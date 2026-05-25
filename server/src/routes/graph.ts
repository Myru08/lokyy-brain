import { Hono } from "hono";
import { backlinks, buildGraph, listTags } from "@lokyy/core";

/** /api/graph — kompletter Wissensgraph, aus den .md-Dateien abgeleitet. */
export const graphRoutes = new Hono();

graphRoutes.get("/", async (c) => {
  return c.json(await buildGraph());
});

/** /api/graph/backlinks/:noteId — wer linkt auf diese Note? */
graphRoutes.get("/backlinks/:id{.+}", async (c) => {
  const noteId = c.req.param("id");
  return c.json({ backlinks: await backlinks(noteId) });
});

/** /api/graph/tags — alle Tags im Vault mit Counts + noteIds */
graphRoutes.get("/tags", async (c) => {
  return c.json({ tags: await listTags() });
});
