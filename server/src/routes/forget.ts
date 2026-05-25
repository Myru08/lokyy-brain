import { Hono } from "hono";
import {
  getNote,
  isForgotten,
  parseFrontmatter,
  queueForgottenToggle,
  saveNote,
  serializeFrontmatter,
} from "@lokyy/core";

/**
 * Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
 *
 * Two endpoints flip the `forgotten:` field on a note's frontmatter:
 *
 *   POST /api/notes/:id/forget    sets   forgotten = <ISO-timestamp>
 *   POST /api/notes/:id/unforget  removes the field entirely
 *
 * The note remains in the vault (Forgejo + on-disk) for audit / recovery
 * — only retrieval ignores it. Search-layer filtering (Tier1-BM25,
 * Tier2-embeddings, hybrid-RRF, PPR-spreading-activation) is wired in
 * `@lokyy/core`; this route is purely a frontmatter-mutation + index hint.
 *
 * Both operations are idempotent: forgetting an already-forgotten note
 * updates the timestamp (cheap signal that the user re-affirmed the
 * decision) but never errors; unforgetting a note that was never
 * forgotten is a no-op.
 *
 * Wildcard segment `:id{.+}` is reused from the rest of the notes routes
 * — note ids contain `/` (path-minus-`.md`).
 */
export const forgetRoutes = new Hono();

forgetRoutes.post("/notes/:id{.+}/forget", async (c) => {
  const id = c.req.param("id");
  const note = await getNote(id);
  if (!note) {
    return c.json({ error: "Notiz nicht gefunden" }, 404);
  }

  // Parse the existing body, set `forgotten`, re-serialize, write through
  // notesService.saveNote (which handles validation + git commit + the
  // BM25/temporal-edge hooks).
  const { data, body } = parseFrontmatter(note.body);
  const timestamp = new Date().toISOString();
  data.forgotten = timestamp;
  const nextBody = serializeFrontmatter(data, body);

  try {
    const saved = await saveNote(id, nextBody);
    // saveNote already enqueues a BM25 refresh with the new forgotten=true
    // flag, but we also fire the explicit toggle so the column flips
    // immediately even if the BM25 row is still being indexed for the
    // first time.
    queueForgottenToggle(id, true);
    return c.json({ ok: true, noteId: id, forgotten: timestamp, note: saved });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Forget fehlgeschlagen" },
      409,
    );
  }
});

forgetRoutes.post("/notes/:id{.+}/unforget", async (c) => {
  const id = c.req.param("id");
  const note = await getNote(id);
  if (!note) {
    return c.json({ error: "Notiz nicht gefunden" }, 404);
  }

  const { data, body } = parseFrontmatter(note.body);
  const wasForgotten = isForgotten(data);
  // Drop the field entirely on unforget — the absent-field convention is
  // the schema's canonical "not forgotten" state, so re-saving without
  // the key keeps the YAML cleaner than `forgotten: false`.
  delete data.forgotten;
  const nextBody = serializeFrontmatter(data, body);

  try {
    const saved = await saveNote(id, nextBody);
    queueForgottenToggle(id, false);
    return c.json({
      ok: true,
      noteId: id,
      forgotten: false,
      wasForgotten,
      note: saved,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Unforget fehlgeschlagen" },
      409,
    );
  }
});
