import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  findByUlid,
  getNote,
  isUlid,
  listNotes,
  logRetrieval,
  saveNote,
} from "@lokyy/core";

/** /api/notes — Liste, Einzelnotiz, Speichern. */
export const notesRoutes = new Hono();

// GET /api/notes -> NoteSummary[]
notesRoutes.get("/", async (c) => {
  return c.json(await listNotes());
});

// GET /api/notes/by-id/:ulid — resolve via stable frontmatter ULID.
//
// Registered BEFORE the wildcard `:id{.+}` so the literal `by-id` prefix
// is not swallowed as a note path. Hono dispatches in registration
// order, so this works without explicit priority config.
notesRoutes.get("/by-id/:ulid", async (c) => {
  const ulid = c.req.param("ulid");
  if (!isUlid(ulid)) {
    return c.json({ error: "invalid ULID format" }, 400);
  }
  const note = await findByUlid(ulid);
  if (!note) return c.json({ error: "not found" }, 404);
  // Mirror the path-based GET's fire-and-forget retrieval log so the
  // "AI prompt" → resolve round-trip is visible in /api/traces.
  const sessionId = getCookie(c, "lokyy_session");
  void logRetrieval({
    noteId: note.path,
    source: "api",
    sessionId: sessionId,
  });
  return c.json(note);
});

// GET /api/notes/:id  (id darf "/" enthalten -> Wildcard)
notesRoutes.get("/:id{.+}", async (c) => {
  const id = c.req.param("id");
  const note = await getNote(id);
  if (!note) return c.json({ error: "Notiz nicht gefunden" }, 404);
  // Phase A Wave A1 / Story 3 — Retrieval-Trace-Log.
  // Fire-and-forget: logRetrieval swallows its own errors. The `void`
  // prefix makes it explicit that we are not awaiting the side-channel
  // write, so a slow DB cannot stall the user-facing GET.
  // We use the note's path-id (frontmatter ULID is not exposed on the
  // shared Note shape); migrating to ULIDs is the consolidation-agent's
  // job and out of scope here.
  const sessionId = getCookie(c, "lokyy_session");
  void logRetrieval({
    noteId: note.id,
    source: "api",
    sessionId: sessionId,
  });
  return c.json(note);
});

// PUT /api/notes/:id  { body: string }  -> committet & pusht
notesRoutes.put("/:id{.+}", async (c) => {
  const id = c.req.param("id");
  const { body } = await c.req.json<{ body: string }>();
  if (typeof body !== "string") {
    return c.json({ error: "body (string) erforderlich" }, 400);
  }
  try {
    return c.json(await saveNote(id, body));
  } catch (err) {
    // u.a. Merge-Konflikt -> 409, damit die PWA es als Konflikt behandeln kann
    return c.json(
      { error: err instanceof Error ? err.message : "Speichern fehlgeschlagen" },
      409,
    );
  }
});
