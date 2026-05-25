import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { getNote, listNotes, logRetrieval, saveNote } from "@lokyy/core";

/** /api/notes — Liste, Einzelnotiz, Speichern. */
export const notesRoutes = new Hono();

// GET /api/notes -> NoteSummary[]
notesRoutes.get("/", async (c) => {
  return c.json(await listNotes());
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
