import { recomputeAll } from "../../scoring/store.js";
import { listNotes, getNote } from "../../notes/notesService.js";
import { parseFrontmatter, type DocType } from "../../frontmatter/index.js";
import { DOC_TYPES } from "../../frontmatter/types.js";
import type { SleepPass } from "../types.js";

/**
 * Phase A Wave A2 / Story 7 — first sleep-agent pass.
 *
 * Walks the vault, derives `{ noteId (= frontmatter ULID), type, updated }`
 * for every note, and feeds the async-iterable into `recomputeAll`. No
 * LLM, no embeddings, no graph traversal — Story 1 already produces the
 * scoring rows; this pass just keeps them fresh.
 *
 * Edge cases the iterable absorbs (each becomes a `recomputeAll` `errors++`
 * via per-entry try/catch in `recomputeAll`, OR a silent skip here when
 * we can't even produce a valid record):
 *
 *   - File deleted between `listNotes()` and `getNote()` → silent skip.
 *   - Missing frontmatter / no `id` → silent skip (would key on an
 *     unstable path id and corrupt the scoring sidecar).
 *   - Missing / unknown `type` → fall back to `"note"` so the importance
 *     formula still applies the default origin weight.
 *   - Missing / unparseable `updated` → fall back to the file's
 *     last-commit `updatedAt`, then to `now` — recency decay still
 *     produces a defined number.
 */
const DOC_TYPE_SET = new Set<string>(DOC_TYPES);

export const importanceRecomputePass: SleepPass = {
  name: "importance-recompute",
  phases: ["nrem"],
  async run() {
    const iter = (async function* () {
      const notes = await listNotes();
      for (const summary of notes) {
        // Re-read so we have the body + frontmatter. listNotes() summaries
        // intentionally drop the body; we need the frontmatter ULID +
        // doc type here, both of which only live in the file.
        const note = await getNote(summary.id).catch(() => null);
        if (!note) continue;

        const { data } = parseFrontmatter(note.body);

        const fmId = typeof data.id === "string" ? data.id : null;
        if (!fmId) continue; // skip ULID-less notes — see jsdoc above.

        const rawType = typeof data.type === "string" ? data.type : null;
        const type: DocType =
          rawType && DOC_TYPE_SET.has(rawType) ? (rawType as DocType) : "note";

        const rawUpdated =
          typeof data.updated === "string" ? data.updated : summary.updatedAt;
        const parsed = new Date(rawUpdated);
        const updated = Number.isNaN(parsed.getTime()) ? new Date() : parsed;

        yield {
          noteId: fmId,
          type,
          updated,
        };
      }
    })();
    return await recomputeAll(iter);
  },
};
