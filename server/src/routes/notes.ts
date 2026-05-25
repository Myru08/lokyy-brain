import { Hono } from "hono";
import { getNote, listNotes, saveNote } from "@lokyy/core";

/** /api/notes — Liste, Einzelnotiz, Speichern. */
export const notesRoutes = new Hono();

// GET /api/notes -> NoteSummary[]
notesRoutes.get("/", async (c) => {
  return c.json(await listNotes());
});

// GET /api/notes/:id  (id darf "/" enthalten -> Wildcard)
notesRoutes.get("/:id{.+}", async (c) => {
  const note = await getNote(c.req.param("id"));
  if (!note) return c.json({ error: "Notiz nicht gefunden" }, 404);
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
