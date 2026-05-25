import { Hono } from "hono";

import {
  listEntities,
  getEntity,
  entitiesInNote,
  notesForEntity,
  entityCoOccurrence,
  isEntityType,
} from "@lokyy/core";

/**
 * Phase C Wave C2 / Story 2 — `/api/entities/*`.
 *
 *   GET /api/entities?type=person&limit=50&minMentions=2
 *       → list known entities, optional filters
 *   GET /api/entities/by-note/:noteId
 *       → entities mentioned in a specific note
 *   GET /api/entities/:id
 *       → single entity by id
 *   GET /api/entities/:id/notes
 *       → all note ids mentioning this entity
 *   GET /api/entities/:id/co-occurrence?limit=20
 *       → entities frequently co-mentioned with this one
 *
 * Route order note: the specific `by-note/:noteId` path is registered
 * BEFORE the parametric `:id` path so Hono doesn't shadow it with the
 * generic single-id handler.
 */
export const entitiesRoutes = new Hono();

entitiesRoutes.get("/", async (c) => {
  const typeParam = c.req.query("type");
  const limitParam = c.req.query("limit");
  const minMentionsParam = c.req.query("minMentions");

  const limit = (() => {
    const n = Number(limitParam ?? "100");
    if (!Number.isFinite(n)) return 100;
    return Math.max(1, Math.min(1000, Math.floor(n)));
  })();
  const minMentions = (() => {
    const n = Number(minMentionsParam ?? "0");
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.floor(n));
  })();
  const type =
    typeParam && isEntityType(typeParam) ? typeParam : undefined;

  const items = await listEntities({ type, limit, minMentions });
  return c.json({ entities: items });
});

entitiesRoutes.get("/by-note/:noteId{.+}", async (c) => {
  const noteId = c.req.param("noteId");
  const items = await entitiesInNote(noteId);
  return c.json({ entities: items });
});

entitiesRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const entity = await getEntity(id);
  if (!entity) return c.json({ error: "entity not found" }, 404);
  return c.json({ entity });
});

entitiesRoutes.get("/:id/notes", async (c) => {
  const id = c.req.param("id");
  const entity = await getEntity(id);
  if (!entity) return c.json({ error: "entity not found" }, 404);
  const noteIds = await notesForEntity(id);
  return c.json({ entityId: id, noteIds });
});

entitiesRoutes.get("/:id/co-occurrence", async (c) => {
  const id = c.req.param("id");
  const limitRaw = c.req.query("limit");
  const limit = (() => {
    const n = Number(limitRaw ?? "20");
    if (!Number.isFinite(n)) return 20;
    return Math.max(1, Math.min(500, Math.floor(n)));
  })();
  const entity = await getEntity(id);
  if (!entity) return c.json({ error: "entity not found" }, 404);
  const cooccurrence = await entityCoOccurrence(id, limit);
  return c.json({ entityId: id, cooccurrence });
});
