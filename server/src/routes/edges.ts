import { Hono } from "hono";
import {
  getActiveEdgeWeight,
  listEdgesForNote,
  listPrunedEdges,
  resurrectEdge,
} from "@lokyy/core";

/**
 * Phase C Wave C1 / Story 4 — `/api/edges/*`.
 *
 *   GET  /api/edges/pruned?limit=N        graveyard listing, newest first
 *   POST /api/edges/resurrect             { from, to } → un-prune one edge
 *   GET  /api/edges/weights?noteId=X      all tracked outbound edges for X
 *   GET  /api/edges/weight?from=A&to=B    one weight (or null if not tracked)
 *
 * Implementation lives in `packages/core/src/graph/edgeWeights.ts`. This file
 * is glue — it must NOT contain pruning logic; that's the NREM sleep pass.
 */
export const edgesRoutes = new Hono();

edgesRoutes.get("/pruned", async (c) => {
  const raw = c.req.query("limit") ?? "100";
  const limit = Number(raw);
  const edges = await listPrunedEdges(Number.isFinite(limit) ? limit : 100);
  return c.json({ edges });
});

edgesRoutes.post("/resurrect", async (c) => {
  const body = await c.req
    .json<{ from?: string; to?: string }>()
    .catch(() => ({}) as { from?: string; to?: string });
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  if (!from || !to) {
    return c.json({ error: "from + to (string) required" }, 400);
  }
  const ok = await resurrectEdge(from, to);
  if (!ok) return c.json({ error: "edge not tracked", from, to }, 404);
  return c.json({ ok: true, from, to });
});

edgesRoutes.get("/weights", async (c) => {
  const noteId = c.req.query("noteId");
  if (!noteId) return c.json({ error: "noteId query param required" }, 400);
  const edges = await listEdgesForNote(noteId);
  return c.json({ noteId, edges });
});

edgesRoutes.get("/weight", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!from || !to) {
    return c.json({ error: "from + to query params required" }, 400);
  }
  const weight = await getActiveEdgeWeight(from, to);
  return c.json({ from, to, weight });
});
