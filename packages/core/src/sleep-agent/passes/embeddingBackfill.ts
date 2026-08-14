import { sql } from "drizzle-orm";

import { database } from "../../db/index.js";
import { listNotes } from "../../notes/notesService.js";
import { getMemoryProvider } from "../../memory/index.js";
import { getActiveGeneration } from "../../llm/embeddingsMigration.js";
import { DEFAULT_EMBEDDINGS_GENERATION } from "../../db/schema/embeddingsMigration.js";
import { indexVaultId } from "../../util/coreConfig.js";
import type { SleepPass, SleepPassResult, SleepRun } from "../types.js";

/**
 * issue #52 — Tier-2 Embedding-Backfill sleep pass.
 *
 * THE GAP THIS CLOSES: Tier 2 is only ever written on the save path
 * (`queueIndexRefresh` → `MemoryProvider.indexNote`). That call is
 * fire-and-forget by design, so every save that happened while Ollama was
 * down / mis-wired / quarantined silently produced a note WITHOUT
 * embeddings — and nothing ever went back for it. Until this pass existed
 * the only repair was re-saving each note by hand (a beta tester had 14 of
 * 19 notes unindexed). `POST /api/search/reindex` did not help: it rebuilds
 * the Tier-1 BM25 corpus only.
 *
 * What it does: walk the vault, find notes with no row in `note_embeddings`
 * for the active generation, and push them through the SAME
 * `getMemoryProvider().indexNote()` path the save hook uses. No separate
 * embedding logic — chunking, content-hash skipping and generation
 * handling all stay in `Tier2Provider`.
 *
 * PHASE = NREM, deliberately:
 *   - NREM is the mechanical index-maintenance phase (importance-recompute,
 *     synaptic-pruning, lint, ulid-backfill). REM is the semantic/LLM phase
 *     (entity-extraction, topic-synthesis, peer-profiles). Re-embedding is
 *     index maintenance, not interpretation — it belongs in NREM.
 *   - Practical consequence: NREM is what BOTH the 30-min idle timer and the
 *     03:00 nightly run execute, so a vault that needs several runs to catch
 *     up actually gets them. Registering it in REM too would only duplicate
 *     work — the pass is resumable, not idempotent-per-phase.
 *
 * Budget: at most {@link EMBEDDING_BACKFILL_NOTES_PER_RUN} notes AND at most
 * {@link EMBEDDING_BACKFILL_TIME_BUDGET_MS} wall-clock per run. On CPU-only
 * installs one note costs several Ollama round-trips (title + body_full +
 * one per H2 section), so an unbounded pass could still be running when the
 * user wakes up. Whatever is left over is picked up by the next run — the
 * candidate query re-derives "what is missing" from the DB every time, so
 * progress is never lost and nothing needs to be check-pointed.
 *
 * Failure policy: per-note errors are counted, never thrown — one poison
 * note must not cost the whole night. If the embedding service itself is
 * dead the run aborts early (see {@link CONSECUTIVE_MISS_ABORT}) instead of
 * grinding through hundreds of no-ops.
 *
 * Note on RAW/hands-off zones: unlike `ulid-backfill` this pass never
 * rewrites a file — it only reads and writes DB rows — so the RAW
 * immutability guard does not apply here.
 */

/** Hard cap on notes indexed per run. */
export const EMBEDDING_BACKFILL_NOTES_PER_RUN = 25;

/** Wall-clock budget per run; checked between notes, never mid-note. */
export const EMBEDDING_BACKFILL_TIME_BUDGET_MS = 10 * 60_000;

/**
 * How many consecutive notes may come back WITHOUT embeddings before we
 * conclude the embedding service is unavailable and stop.
 *
 * WHY THE CHECK EXISTS AT ALL: `CombinedProvider.indexNote` swallows
 * `EmbeddingUnavailableError` (Tier 2 is fire-and-forget on the save path).
 * So a successful `await indexNote()` proves nothing — with Ollama down it
 * resolves happily and writes no rows. A backfill that reported those as
 * "processed" would be exactly the kind of false success that produced this
 * bug. Hence: after indexing, verify the rows actually exist.
 */
const CONSECUTIVE_MISS_ABORT = 5;

/** Active generation with the same fallback Tier2Provider uses. */
async function activeGenerationSafe(): Promise<string> {
  try {
    return await getActiveGeneration();
  } catch {
    return DEFAULT_EMBEDDINGS_GENERATION;
  }
}

/** noteIds that already have at least one chunk in the active generation. */
async function indexedNoteIds(
  vaultId: string,
  generation: string,
): Promise<Set<string>> {
  const rows = await database().execute<{ note_id: string }>(sql`
    SELECT DISTINCT note_id
    FROM note_embeddings
    WHERE vault_id = ${vaultId}
      AND generation = ${generation}
  `);
  const out = new Set<string>();
  for (const row of rows as unknown as Array<{ note_id: string }>) {
    if (typeof row.note_id === "string") out.add(row.note_id);
  }
  return out;
}

/** True once the note has at least one chunk row in the active generation. */
async function hasEmbeddings(
  noteId: string,
  vaultId: string,
  generation: string,
): Promise<boolean> {
  const rows = await database().execute<{ note_id: string }>(sql`
    SELECT note_id
    FROM note_embeddings
    WHERE note_id = ${noteId}
      AND vault_id = ${vaultId}
      AND generation = ${generation}
    LIMIT 1
  `);
  return (rows as unknown as unknown[]).length > 0;
}

export const embeddingBackfillPass: SleepPass = {
  name: "embedding-backfill",
  phases: ["nrem"],

  async run(_run: SleepRun): Promise<SleepPassResult> {
    let processed = 0;
    let errors = 0;

    try {
      const vaultId = indexVaultId();
      const generation = await activeGenerationSafe();

      const summaries = await listNotes();
      const alreadyIndexed = await indexedNoteIds(vaultId, generation);

      const missing = summaries
        .map((s) => s.id)
        .filter((id) => !alreadyIndexed.has(id));

      if (missing.length === 0) {
        return {
          processed: 0,
          errors: 0,
          notes: "all notes have Tier-2 embeddings",
        };
      }

      const batch = missing.slice(0, EMBEDDING_BACKFILL_NOTES_PER_RUN);
      const provider = getMemoryProvider(vaultId);
      const deadline = Date.now() + EMBEDDING_BACKFILL_TIME_BUDGET_MS;

      let consecutiveMisses = 0;
      let abortReason: string | null = null;

      for (const noteId of batch) {
        if (Date.now() >= deadline) {
          abortReason = "time budget exhausted";
          break;
        }
        try {
          await provider.indexNote(noteId);
          if (await hasEmbeddings(noteId, vaultId, generation)) {
            processed++;
            consecutiveMisses = 0;
          } else {
            // Resolved but wrote nothing → embedding service silently
            // unavailable (see CONSECUTIVE_MISS_ABORT).
            errors++;
            consecutiveMisses++;
          }
        } catch (err) {
          errors++;
          consecutiveMisses++;
          console.warn(
            `[sleep-agent] embedding-backfill failed for "${noteId}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        if (consecutiveMisses >= CONSECUTIVE_MISS_ABORT) {
          abortReason = `embedding service produced no vectors for ${consecutiveMisses} notes in a row`;
          break;
        }
      }

      const remaining = missing.length - processed;
      return {
        processed,
        errors,
        notes:
          `embedded ${processed} note(s), ${errors} failed, ${remaining} still missing` +
          (abortReason ? ` — stopped early: ${abortReason}` : ""),
      };
    } catch (err) {
      return {
        processed,
        errors: errors + 1,
        notes: `pass-error: ${String(err).slice(0, 200)}`,
      };
    }
  },
};
