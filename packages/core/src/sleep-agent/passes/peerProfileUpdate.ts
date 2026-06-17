import { eq } from "drizzle-orm";

import { database } from "../../db/index.js";
import { peerProfiles } from "../../db/schema/peerProfiles.js";
import { entityMentions } from "../../db/schema/entities.js";
import { listNotes, saveNote } from "../../notes/notesService.js";
import {
  parseFrontmatter,
  serializeFrontmatter,
  type FrontmatterMap,
} from "../../frontmatter/index.js";
import { isPeerType, type PeerType } from "../../frontmatter/types.js";
import { resolveVaultProfile } from "../../frontmatter/profiles.js";
import { isRawImmutable, isHandsOffZone } from "../rawGuard.js";
import { computeRelationshipStrength } from "../../peers/index.js";
import type { SleepPass, SleepRun, SleepPassResult } from "../types.js";

/**
 * Phase C Wave C2 / Story 3 — Peer-Profile-Update REM-sleep pass.
 *
 * Walks every `type: peer` note in the vault and refreshes its profile:
 *
 *   1. Aggregate evidence from `entity_mentions` (when `linked_entity_id`
 *      is set) — mention count, latest observed_at.
 *   2. Aggregate co-tagged topics from the source notes' frontmatter tags.
 *   3. Recompute `relationship_strength` via the shared
 *      `computeRelationshipStrength` heuristic (see peers/index.ts).
 *   4. Write back to BOTH the DB sidecar (`peer_profiles`) AND the note
 *      frontmatter (the agent updates `interaction_count`, `ongoing_topics`,
 *      `last_interaction`, `relationship_strength`, `traits` — but ONLY when
 *      the user hasn't manually overridden — frontmatter wins).
 *
 * Override semantics:
 *   - `relationship_strength` is the only field where the user override
 *     fully replaces the computed value (the constraint cited in the story
 *     spec: "User darf manuell overriden (frontmatter wins)"). When the
 *     user has supplied a number in the frontmatter, the pass uses it as-is
 *     for the sidecar and does NOT touch the frontmatter field.
 *   - `ongoing_topics` / `interaction_count` / `last_interaction` are
 *     additive — the agent merges new evidence with whatever the user
 *     wrote. Manual entries persist, agent-derived entries get appended.
 *
 * Failure semantics mirror the other sleep passes — per-peer errors are
 * counted and the next peer continues. The pass NEVER aborts a sleep-run.
 *
 * Cost: O(P · M) where P = peer count and M = avg mentions per peer.
 * Today's vaults have P in the dozens and M in the hundreds — well below
 * the 2-minute soft budget the sleep-agent allots per pass.
 */

const MAX_TOPICS_PER_PEER = 20;

export const peerProfileUpdatePass: SleepPass = {
  name: "peer-profile-update",
  phases: ["rem"],

  async run(_run: SleepRun): Promise<SleepPassResult> {
    let processed = 0;
    let errors = 0;
    const db = database();

    try {
      const allNotes = await listNotes();

      // Build a fast id → tags map once so per-peer topic aggregation is O(M).
      const tagsByNoteId = new Map<string, string[]>();
      for (const n of allNotes) {
        tagsByNoteId.set(n.id, n.tags ?? []);
      }

      // Surface peer-note summaries first via filename heuristic (cheap) —
      // confirm via frontmatter read below. We could parse every note's
      // frontmatter here, but most vaults have <1% peer-notes and `listNotes`
      // doesn't expose frontmatter, so we rely on the user keeping peers
      // under the standard `peers/` folder OR an explicit type re-read.
      // Cheap path: candidate = id starts with "peers/" OR `entity_mentions`
      // shows a linked-entity-id pointing at us. The full read happens below.
      const peerCandidates = allNotes.filter((n) => n.id.startsWith("peers/"));

      // Also grab any peer-notes currently in the sidecar — covers users who
      // keep peer-notes outside `peers/`.
      const existingProfiles = await db
        .select({ noteId: peerProfiles.noteId })
        .from(peerProfiles);
      const candidateIds = new Set<string>(peerCandidates.map((n) => n.id));
      for (const p of existingProfiles) candidateIds.add(p.noteId);

      // Story S4 — RAW-Immutabilität. A peer-note never lives under RAW/ by
      // convention (peers are PARA `peers/` / karpathy never marks RAW as
      // peer), but this is a SYSTEM-driven frontmatter write-back, so we guard
      // defensively: under `karpathy` no RAW source is ever rewritten, and the
      // `RAW/_…` Hände-weg-Zone is skipped unconditionally. Under `para`
      // `isRawImmutable` is always `false` → byte-identical behaviour.
      const profile = resolveVaultProfile();

      for (const noteId of candidateIds) {
        try {
          if (isRawImmutable(noteId, profile)) continue;
          if (isHandsOffZone(noteId)) continue;
          // Read the note body fresh — listNotes summaries don't carry body.
          // Failures (file gone between listNotes and getNote) drop silently.
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const { coreConfig } = await import("../../util/coreConfig.js");
          const c = coreConfig();
          const abs = join(c.vaultDir, ...noteId.split("/")) + ".md";

          let rawBody: string;
          try {
            rawBody = await readFile(abs, "utf8");
          } catch {
            // Note vanished — drop the sidecar row.
            await db.delete(peerProfiles).where(eq(peerProfiles.noteId, noteId));
            continue;
          }

          const { data: fm, body: noteBody } = parseFrontmatter(rawBody);
          if (fm.type !== "peer") continue;

          const peerType: PeerType = isPeerType(String(fm.peer_type))
            ? (fm.peer_type as PeerType)
            : "person";
          const linkedEntityId =
            typeof fm.linked_entity_id === "string" && fm.linked_entity_id.length > 0
              ? fm.linked_entity_id
              : null;

          // ── Aggregate evidence from entity_mentions ──────────────────
          let aggInteractionCount = 0;
          let aggLastInteraction: Date | null = null;
          const aggTopics = new Set<string>();

          if (linkedEntityId) {
            const mentions = await db
              .select({
                noteId: entityMentions.noteId,
                observedAt: entityMentions.observedAt,
              })
              .from(entityMentions)
              .where(eq(entityMentions.entityId, linkedEntityId));

            aggInteractionCount = mentions.length;
            for (const m of mentions) {
              if (!aggLastInteraction || m.observedAt > aggLastInteraction) {
                aggLastInteraction = m.observedAt;
              }
              for (const tag of tagsByNoteId.get(m.noteId) ?? []) {
                aggTopics.add(tag);
              }
            }
          }

          // ── Merge with user-supplied frontmatter (additive) ──────────
          const userTopics = Array.isArray(fm.ongoing_topics)
            ? fm.ongoing_topics.filter(
                (t): t is string => typeof t === "string" && t.length > 0,
              )
            : [];
          for (const t of userTopics) aggTopics.add(t);
          const ongoingTopics = [...aggTopics].slice(0, MAX_TOPICS_PER_PEER);

          const userInteractions =
            typeof fm.interaction_count === "number" &&
            Number.isFinite(fm.interaction_count)
              ? Math.floor(fm.interaction_count)
              : 0;
          const interactionCount = Math.max(aggInteractionCount, userInteractions);

          const userLast =
            typeof fm.last_interaction === "string"
              ? (() => {
                  const d = new Date(fm.last_interaction as string);
                  return Number.isNaN(d.getTime()) ? null : d;
                })()
              : null;
          const lastInteraction = (() => {
            if (aggLastInteraction && userLast) {
              return aggLastInteraction > userLast ? aggLastInteraction : userLast;
            }
            return aggLastInteraction ?? userLast;
          })();

          const traits = Array.isArray(fm.traits)
            ? fm.traits.filter((t): t is string => typeof t === "string")
            : [];

          // ── Compute strength ─────────────────────────────────────────
          const computedStrength = computeRelationshipStrength({
            interactionCount,
            lastInteraction,
            topicCount: ongoingTopics.length,
            topicCap: MAX_TOPICS_PER_PEER,
            firstMet:
              typeof fm.first_met === "string"
                ? (() => {
                    const d = new Date(fm.first_met as string);
                    return Number.isNaN(d.getTime()) ? null : d;
                  })()
                : null,
          });

          // User override wins for `relationship_strength` — frontmatter stays.
          const userOverridesStrength =
            typeof fm.relationship_strength === "number" &&
            Number.isFinite(fm.relationship_strength);
          const finalStrength = userOverridesStrength
            ? Math.max(0, Math.min(1, fm.relationship_strength as number))
            : computedStrength;

          // ── Sidecar UPSERT ───────────────────────────────────────────
          const now = new Date();
          await db
            .insert(peerProfiles)
            .values({
              noteId,
              peerType,
              linkedEntityId: linkedEntityId ?? undefined,
              relationshipStrength: finalStrength,
              interactionCount,
              lastInteraction: lastInteraction ?? undefined,
              ongoingTopics,
              traits,
              computedAt: now,
            })
            .onConflictDoUpdate({
              target: peerProfiles.noteId,
              set: {
                peerType,
                linkedEntityId: linkedEntityId ?? null,
                relationshipStrength: finalStrength,
                interactionCount,
                lastInteraction: lastInteraction ?? null,
                ongoingTopics,
                traits,
                computedAt: now,
              },
            });

          // ── Frontmatter write-back ───────────────────────────────────
          //
          // Only write if SOMETHING agent-derived changed. We deliberately
          // skip `relationship_strength` when the user has overridden it
          // (frontmatter wins, sleep doesn't churn the .md). Otherwise we
          // rewrite the .md via saveNote so the user sees current numbers
          // in PropertiesPanel.
          const updatedFm: FrontmatterMap = {
            ...fm,
            interaction_count: interactionCount,
            ongoing_topics: ongoingTopics,
            ...(lastInteraction && {
              last_interaction: lastInteraction.toISOString(),
            }),
            ...(userOverridesStrength
              ? {}
              : { relationship_strength: Number(finalStrength.toFixed(3)) }),
          };

          const changed =
            updatedFm.interaction_count !== fm.interaction_count ||
            JSON.stringify(updatedFm.ongoing_topics) !==
              JSON.stringify(fm.ongoing_topics) ||
            updatedFm.last_interaction !== fm.last_interaction ||
            (!userOverridesStrength &&
              updatedFm.relationship_strength !== fm.relationship_strength);

          if (changed) {
            try {
              const newContent = serializeFrontmatter(updatedFm, noteBody);
              await saveNote(noteId, newContent);
            } catch {
              // Frontmatter write-back is best-effort. Sidecar already
              // captured the truth.
              errors++;
            }
          }

          processed++;
        } catch (err) {
          errors++;
          console.warn(
            `[peer-profile-update] note "${noteId}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return {
        processed,
        errors,
        notes: `${processed} peers updated, ${errors} errors`,
      };
    } catch (err) {
      return {
        processed,
        errors: errors + 1,
        notes: `pass-error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
