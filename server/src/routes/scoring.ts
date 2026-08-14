import { Hono } from "hono";
import {
  getScoring,
  recomputeAll,
  touchEdit,
  touchView,
  type DocType,
} from "@lokyy/core";

/**
 * Phase A Wave A1 / Story 1 — `/api/scoring/*`.
 *
 *   GET  /api/scoring/:noteId          → current scoring row
 *   POST /api/scoring/touch-view       { noteId }
 *   POST /api/scoring/touch-edit       { noteId }
 *   POST /api/scoring/recompute-all    { notes: [{noteId, type, updated, ...}] }
 *
 * The recompute-all endpoint is the sleep-agent's entry point. It accepts
 * a pre-walked signal list rather than walking the vault itself — that
 * keeps the scoring module decoupled from `notesService` / `graphService`.
 *
 * `noteId` is the vault PATH id (`50_decisions/foo`) on EVERY route here,
 * including the `notes[].noteId` entries of recompute-all — issue #61. It
 * used to be the frontmatter ULID for recompute-all only, which meant the
 * scores that endpoint wrote landed in a key space no reader ever queried.
 * The routes pass the id straight through, so a caller sending ULIDs still
 * gets rows written — just orphaned ones nothing will read.
 */
export const scoringRoutes = new Hono();

// noteId contains "/" in the normal case — path ids are hierarchical — so the
// wildcard is what makes the route usable, not a concession to callers who
// pass the wrong thing.
scoringRoutes.get("/:noteId{.+}", async (c) => {
  const noteId = c.req.param("noteId");
  const row = await getScoring(noteId);
  if (!row) return c.json({ error: "Kein Scoring für diese Note." }, 404);
  return c.json(row);
});

scoringRoutes.post("/touch-view", async (c) => {
  const { noteId } = await c.req.json<{ noteId?: string }>();
  if (typeof noteId !== "string" || noteId.length === 0) {
    return c.json({ error: "noteId (string) erforderlich" }, 400);
  }
  await touchView(noteId);
  return c.json({ ok: true });
});

scoringRoutes.post("/touch-edit", async (c) => {
  const { noteId } = await c.req.json<{ noteId?: string }>();
  if (typeof noteId !== "string" || noteId.length === 0) {
    return c.json({ error: "noteId (string) erforderlich" }, 400);
  }
  await touchEdit(noteId);
  return c.json({ ok: true });
});

interface RecomputeAllBodyEntry {
  noteId: string;
  type: DocType;
  updated: string;
  incomingBacklinks?: number;
  coCitationMax?: number;
}

scoringRoutes.post("/recompute-all", async (c) => {
  const body = await c.req.json<{ notes?: RecomputeAllBodyEntry[] }>();
  const entries = Array.isArray(body.notes) ? body.notes : [];

  async function* iter(): AsyncGenerator<{
    noteId: string;
    type: DocType;
    updated: Date;
    incomingBacklinks?: number;
    coCitationMax?: number;
  }> {
    for (const e of entries) {
      const updated = new Date(e.updated);
      if (Number.isNaN(updated.getTime())) continue;
      yield {
        noteId: e.noteId,
        type: e.type,
        updated,
        incomingBacklinks: e.incomingBacklinks,
        coCitationMax: e.coCitationMax,
      };
    }
  }

  const result = await recomputeAll(iter());
  return c.json(result);
});
