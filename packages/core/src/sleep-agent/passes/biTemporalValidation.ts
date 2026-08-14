import { and, asc, isNull, lt } from "drizzle-orm";

import { database } from "../../db/index.js";
import { temporalEdges } from "../../db/schema/temporalEdges.js";
import { markEdgeStale } from "../../graph/temporalEdges.js";
import { createPassErrorLog } from "../errorSamples.js";
import type { SleepPass, SleepPassResult } from "../types.js";

/**
 * Phase C Wave C2 / Story 1 — Bi-Temporal Validation REM-pass.
 *
 * Why REM and not NREM:
 *   The synaptic-pruning NREM pass already churns through edge_weights. This
 *   pass operates on a different table (temporal_edges) and a different
 *   signal (real-world-time validity vs. retrieval strength) — REM is where
 *   the "is this still true?" question naturally lives.
 *
 * Heuristic — pure-code, no LLM:
 *   For each currently-active edge (`t_invalid IS NULL`) whose `t_valid` is
 *   older than STALE_AFTER_DAYS, flag it as `stale` in the metadata blob.
 *   We do NOT invalidate — invalidation is a real-world claim and requires
 *   either a contradicting note (already handled by `findInvalidationCandidates`
 *   + `invalidateEdge` at write time) or an explicit user action via
 *   `/api/temporal-edges/invalidate`.
 *
 *   Marking stale is a soft signal. Downstream:
 *     - The retrieval pipeline can choose to deprioritise stale edges.
 *     - The lint sleep-pass / user UI can surface stale-flagged edges as
 *       review candidates.
 *     - If the user re-asserts the same claim in a new note, the next
 *       wikilink-sync call will skip (dedupe) — the flag persists as a
 *       reminder, but the edge remains active.
 *
 * Scale control:
 *   - MAX_PER_RUN bounds the work per nightly invocation; the next run picks
 *     up where this one left off because edges already flagged are filtered
 *     out by the `metadata->>'stale' IS NULL` guard (done in TS to avoid
 *     dialect-specific JSONB predicates in Drizzle).
 *   - Sorted ascending by `t_valid` so the OLDEST edges are flagged first
 *     — most signal for the cost.
 */

const STALE_AFTER_DAYS = 365;
const MAX_PER_RUN = 500;

export const biTemporalValidationPass: SleepPass = {
  name: "bi-temporal-validation",
  phases: ["rem"],

  async run(): Promise<SleepPassResult> {
    let processed = 0;
    let flagged = 0;
    // #58 — an edge is not a note, so the sample is keyed on the edge's SOURCE
    // note (the file an operator would open to look at it) and names the edge
    // id in the reason. Keying on the edge id alone would produce a sample
    // nobody can navigate to.
    const errors = createPassErrorLog();

    try {
      const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000);
      const candidates = await database()
        .select()
        .from(temporalEdges)
        .where(
          and(
            isNull(temporalEdges.tInvalid),
            lt(temporalEdges.tValid, cutoff),
          ),
        )
        .orderBy(asc(temporalEdges.tValid))
        .limit(MAX_PER_RUN);

      for (const row of candidates) {
        try {
          processed++;
          // Already-flagged guard: the JSONB metadata may carry `stale: true`
          // from a prior run. Re-marking is harmless but wastes a write —
          // skip when the flag is already present.
          const meta =
            row.metadata && typeof row.metadata === "object"
              ? (row.metadata as Record<string, unknown>)
              : null;
          if (meta && meta.stale === true) continue;

          const ageDays = Math.round(
            (Date.now() - row.tValid.getTime()) / 86_400_000,
          );
          await markEdgeStale(
            row.id,
            `t_valid ${ageDays}d ago — older than ${STALE_AFTER_DAYS}d threshold; no recent reinforcement`,
          );
          flagged++;
        } catch (err) {
          errors.record(row.fromNoteId, `edge ${row.id} → ${row.toNoteId}: ${
            err instanceof Error ? err.message : String(err)
          }`);
        }
      }

      return errors.result(
        processed,
        `${flagged} edges flagged stale (>${STALE_AFTER_DAYS}d t_valid, max ${MAX_PER_RUN}/run)`,
      );
    } catch (e) {
      errors.recordPassScoped(e);
      return errors.result(processed, `pass-error: ${String(e).slice(0, 200)}`);
    }
  },
};
