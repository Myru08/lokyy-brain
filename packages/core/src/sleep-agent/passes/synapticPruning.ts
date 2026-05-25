import { and, eq } from "drizzle-orm";

import { database } from "../../db/index.js";
import { edgeWeights } from "../../db/schema/edgeWeights.js";
import { buildGraph } from "../../graph/graphService.js";
import { coRetrievalPairs } from "../../scoring/retrievalLog.js";
import { getScoring } from "../../scoring/store.js";
import type { SleepPass, SleepRun, SleepPassResult } from "../types.js";

/**
 * Phase C Wave C1 / Story 4 — Synaptic-Pruning NREM pass.
 *
 * Tononi & Cirelli Synaptic Homeostasis Hypothesis (2003, 2014, 2020):
 * NREM sleep down-selects synaptic strength globally, keeping the strongest
 * connections and pruning the weakest. We translate the biological idea to
 * the wikilink graph:
 *
 *   strength = 0.4·co-retrieval-norm + 0.4·avg-importance + 0.2·avg-recency
 *
 * Why the 40/40/20 split:
 *   - Co-retrieval (40%): the most behaviour-driven signal — "did the user
 *     actually traverse this edge in the same session as the other side?"
 *     This is the closest analogue to neural co-activation (Hebb: "fire
 *     together → wire together"). Heaviest weight, but capped at 40% so a
 *     single session-blip cannot pin a weak link as strong forever.
 *   - Importance (40%): structural prior — both endpoints' standing in the
 *     vault. An edge between two highly-cited / heavily-touched notes
 *     deserves preservation even before retrieval evidence accrues
 *     (otherwise we cold-start every link). Tied with co-retrieval on
 *     purpose: a fresh edge between hub notes survives early NREM runs.
 *   - Recency (20%): smallest weight by design — sleep-pass should NOT
 *     punish a note merely for being old (the whole point of pruning is
 *     a "useless" signal, not "stale"). But a non-zero recency term lets
 *     edges between very active notes drift up slightly, which matches
 *     the homeostatic intuition that recent activity reinforces synapses.
 *
 * Demotion mechanics:
 *   - `DEMOTION_THRESHOLD_WEIGHT = 0.15` — below this, an edge is weak.
 *   - Cooldown (`COOLDOWN_BETWEEN_DEMOTIONS_DAYS = 7`) prevents a single
 *     weak edge from being demoted multiple times within a week even if
 *     nightly NREM runs every day. With 3-strikes-then-prune semantics
 *     this guarantees a minimum 14-day window (2 cooldown gaps between
 *     the 3 demotions) before any edge moves to the graveyard, giving
 *     the user time to revisit it.
 *   - Recovery: if a previously-demoted edge climbs back above threshold,
 *     `demotion_count` is reset to 0 AND `pruned` flips back to 0 — the
 *     edge resurrects automatically.
 *
 * First-run / empty-DB edge cases (all handled):
 *   - `edge_weights` table empty → INSERT path; `existingRow` is null.
 *   - `coRetrievalPairs` returns [] (no traces yet) → every coRetrieval=0;
 *     strength reduces to 0.4·importance + 0.2·recency. With default
 *     importance=0.5 / recency=1, that's 0.4 ≥ 0.15 → STRONG, no demotion.
 *     So a vault with zero retrieval history does NOT mass-prune itself.
 *   - `getScoring()` returns null (no scoring row yet) → defaults to 0.5
 *     importance + 1.0 recency (see `?? 0.5` / `?? 1` fallbacks). Same
 *     "no premature demotion" guarantee.
 *   - Errors per edge are caught + counted but never abort the run.
 *   - DB unavailable entirely → outer try/catch returns `errors+1` with
 *     a `pass-error:` note, in line with other sleep passes.
 */

/** Composite weights below this are considered weak → eligible for demotion. */
const DEMOTION_THRESHOLD_WEIGHT = 0.15;
/** Consecutive demotions before an edge gets moved to the graveyard. */
const PRUNE_AFTER_DEMOTIONS = 3;
/** Don't demote the same edge twice within this many days (anti-flicker). */
const COOLDOWN_BETWEEN_DEMOTIONS_DAYS = 7;
/** Trailing window over which co-retrievals are counted. */
const CO_RETRIEVAL_WINDOW_DAYS = 30;
/** Co-retrieval count at which the co-retrieval component saturates at 1.0. */
const CO_RETRIEVAL_SATURATION = 5;

/** Strength formula weights — see jsdoc above for rationale. */
const W_CO_RETRIEVAL = 0.4;
const W_IMPORTANCE = 0.4;
const W_RECENCY = 0.2;

/** Canonical key for unordered note-pair lookups in the co-retrieval map. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export const synapticPruningPass: SleepPass = {
  name: "synaptic-pruning",
  phases: ["nrem"],

  async run(_run: SleepRun): Promise<SleepPassResult> {
    let processed = 0;
    let errors = 0;
    let demoted = 0;
    let pruned = 0;
    let strengthened = 0;

    try {
      const db = database();

      // 1. Active graph — directed edges out of every note's wikilinks.
      const graph = await buildGraph();

      // 2. Co-retrieval map (last 30 days, unordered pairs).
      //    coRetrievalPairs() defends with `minCount = 2`; pairs below that
      //    threshold don't appear → map.get() returns undefined → coalesced to 0.
      const coRetrievalRaw = await coRetrievalPairs(CO_RETRIEVAL_WINDOW_DAYS);
      const coRetrievalMap = new Map<string, number>();
      for (const p of coRetrievalRaw) {
        coRetrievalMap.set(pairKey(p.noteIdA, p.noteIdB), p.count);
      }

      const now = Date.now();
      const cooldownCutoff = new Date(
        now - COOLDOWN_BETWEEN_DEMOTIONS_DAYS * 86_400_000,
      );

      for (const edge of graph.edges) {
        try {
          const coRetrieval = coRetrievalMap.get(pairKey(edge.source, edge.target)) ?? 0;

          // Endpoint scoring — null tolerated, defaults match "fresh note".
          const sa = await getScoring(edge.source).catch(() => null);
          const sb = await getScoring(edge.target).catch(() => null);
          const importance =
            ((sa?.importanceScore ?? 0.5) + (sb?.importanceScore ?? 0.5)) / 2;
          const recency =
            ((sa?.recencyScore ?? 1) + (sb?.recencyScore ?? 1)) / 2;

          // Saturating normalization — past N co-retrievals everything looks
          // equally "wired"; we don't reward viral pairs disproportionately.
          const coRetrievalNorm = Math.min(
            1,
            coRetrieval / CO_RETRIEVAL_SATURATION,
          );
          const strength =
            W_CO_RETRIEVAL * coRetrievalNorm +
            W_IMPORTANCE * importance +
            W_RECENCY * recency;

          // Existing row?
          const existing = await db
            .select()
            .from(edgeWeights)
            .where(
              and(
                eq(edgeWeights.fromNoteId, edge.source),
                eq(edgeWeights.toNoteId, edge.target),
              ),
            )
            .limit(1);
          const existingRow = existing[0];

          if (strength >= DEMOTION_THRESHOLD_WEIGHT) {
            // STRONG edge → keep / refresh.
            const wasInGraveyard =
              existingRow !== undefined &&
              (existingRow.demotionCount > 0 || existingRow.pruned === 1);

            if (existingRow) {
              await db
                .update(edgeWeights)
                .set({
                  weight: strength,
                  coRetrievalCount: coRetrieval,
                  demotionCount: 0,
                  pruned: 0,
                  lastUpdated: new Date(),
                })
                .where(
                  and(
                    eq(edgeWeights.fromNoteId, edge.source),
                    eq(edgeWeights.toNoteId, edge.target),
                  ),
                );
              if (wasInGraveyard) strengthened++;
            } else {
              await db.insert(edgeWeights).values({
                fromNoteId: edge.source,
                toNoteId: edge.target,
                weight: strength,
                coRetrievalCount: coRetrieval,
                demotionCount: 0,
                pruned: 0,
                lastUpdated: new Date(),
              });
            }
            processed++;
            continue;
          }

          // WEAK edge → consider demotion, respecting cooldown.
          if (
            existingRow &&
            existingRow.lastDemotedAt &&
            existingRow.lastDemotedAt > cooldownCutoff
          ) {
            // Still within cooldown — record-keep the new weight but do
            // NOT increment demotion_count.
            await db
              .update(edgeWeights)
              .set({
                weight: strength,
                coRetrievalCount: coRetrieval,
                lastUpdated: new Date(),
              })
              .where(
                and(
                  eq(edgeWeights.fromNoteId, edge.source),
                  eq(edgeWeights.toNoteId, edge.target),
                ),
              );
            processed++;
            continue;
          }

          const newDemoCount = (existingRow?.demotionCount ?? 0) + 1;
          const shouldPrune = newDemoCount >= PRUNE_AFTER_DEMOTIONS;

          if (existingRow) {
            await db
              .update(edgeWeights)
              .set({
                weight: strength,
                coRetrievalCount: coRetrieval,
                demotionCount: newDemoCount,
                lastDemotedAt: new Date(),
                pruned: shouldPrune ? 1 : 0,
                lastUpdated: new Date(),
              })
              .where(
                and(
                  eq(edgeWeights.fromNoteId, edge.source),
                  eq(edgeWeights.toNoteId, edge.target),
                ),
              );
          } else {
            // First-ever sighting that's already weak. We still insert with
            // demotionCount=1 + lastDemotedAt=now so the cooldown engages
            // immediately — no risk of pruning a brand-new weak edge in
            // back-to-back runs.
            await db.insert(edgeWeights).values({
              fromNoteId: edge.source,
              toNoteId: edge.target,
              weight: strength,
              coRetrievalCount: coRetrieval,
              demotionCount: 1,
              lastDemotedAt: new Date(),
              pruned: 0,
              lastUpdated: new Date(),
            });
          }

          if (shouldPrune) pruned++;
          else demoted++;
          processed++;
        } catch (err) {
          errors++;
          console.warn(
            `[sleep-agent] synaptic-pruning edge ${edge.source}→${edge.target} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return {
        processed,
        errors,
        notes: `${demoted} demoted, ${pruned} pruned to graveyard, ${strengthened} recovered from graveyard`,
      };
    } catch (err) {
      return {
        processed,
        errors: errors + 1,
        notes: `pass-error: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      };
    }
  },
};
