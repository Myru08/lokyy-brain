import { recomputeAll } from "../../scoring/store.js";
import { listNotes, getNote } from "../../notes/notesService.js";
import { parseFrontmatter, type DocType } from "../../frontmatter/index.js";
import { DOC_TYPES } from "../../frontmatter/types.js";
import type { SleepPass, SleepPassResult } from "../types.js";

/**
 * Phase A Wave A2 / Story 7 — first sleep-agent pass.
 *
 * Walks the vault, derives `{ noteId (= vault PATH id), type, updated }` for
 * every note, and feeds the async-iterable into `recomputeAll`. No LLM, no
 * embeddings, no graph traversal — Story 1 already produces the scoring rows;
 * this pass just keeps them fresh.
 *
 * ── WHY THE PATH ID AND NOT THE FRONTMATTER ULID — issue #61 ────────────
 *
 * This pass used to yield the frontmatter ULID, on the reasoning that a ULID
 * survives a move and a path does not. The reasoning was locally sound and
 * globally wrong: `importanceScore` is written by nothing but `recomputeAll`,
 * and its only reader — `llm/reranker.ts` — looks the row up by search-hit id,
 * which is a PATH id. So the scores this pass computed every night were
 * written into a key space nobody read, and every note the reranker saw fell
 * back to its neutral `?? 0.5`. Meanwhile `touchView`/`touchEdit` wrote path
 * ids into the same table, so each note also accumulated a second row.
 *
 * The path id wins because the reader cannot produce anything else, because
 * every other derived store keys the same way, and because the loss on a move
 * is self-healing: this pass recomputes `importanceScore`/`recencyScore` from
 * scratch on the next run. Move-stability is the `onNoteMoved` sink's job
 * (#55), not the key's.
 *
 * Edge cases the iterable absorbs (each becomes a `recomputeAll` `errors++`
 * via per-entry try/catch in `recomputeAll`, OR a silent skip here when we
 * can't even produce a valid record):
 *
 *   - File deleted between `listNotes()` and `getNote()` → silent skip. This
 *     is the ONLY remaining skip, and it is not a judgement call: there is no
 *     file left to score.
 *   - Missing frontmatter / no `id` → SCORED ANYWAY. Under ULID keying such a
 *     note had no usable key and had to be skipped; under path keying it has
 *     one like every other note, and skipping it would mean the reranker keeps
 *     treating exactly the vault's messiest notes as perfectly average.
 *   - Missing / unknown `type` → fall back to `"note"` so the importance
 *     formula still applies the default origin weight.
 *   - Missing / unparseable `updated` → fall back to the file's
 *     last-commit `updatedAt`, then to `now` — recency decay still
 *     produces a defined number.
 *
 * Per-note failures are reported per note — issue #60. `recomputeAll` returns
 * its failing ids and reasons (capped at `MAX_ERROR_SAMPLES`, the same cap the
 * `PassErrorLog` applies), so this pass forwards them unchanged instead of
 * emitting the pass-scoped placeholder it used to. `errors` remains the exact
 * total, so `errorSamplesTruncated()` still reads true on a truncated sample.
 */
const DOC_TYPE_SET = new Set<string>(DOC_TYPES);

export const importanceRecomputePass: SleepPass = {
  name: "importance-recompute",
  phases: ["nrem"],
  async run(): Promise<SleepPassResult> {
    const iter = (async function* () {
      const notes = await listNotes();
      for (const summary of notes) {
        // Re-read so we have the body + frontmatter. listNotes() summaries
        // intentionally drop the body; we need the doc type, which only
        // lives in the file. The key itself is `summary.id` — the path id.
        const note = await getNote(summary.id).catch(() => null);
        if (!note) continue;

        const { data } = parseFrontmatter(note.body);

        const rawType = typeof data.type === "string" ? data.type : null;
        const type: DocType =
          rawType && DOC_TYPE_SET.has(rawType) ? (rawType as DocType) : "note";

        const rawUpdated =
          typeof data.updated === "string" ? data.updated : summary.updatedAt;
        const parsed = new Date(rawUpdated);
        const updated = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

        yield {
          noteId: summary.id,
          type,
          updated,
        };
      }
    })();

    // Passed through as-is: the counter and the sample come from the SAME
    // call, so they cannot drift the way two hand-maintained values would.
    const { processed, errors, errorSamples } = await recomputeAll(iter);
    return { processed, errors, errorSamples };
  },
};
