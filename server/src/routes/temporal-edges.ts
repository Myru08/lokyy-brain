import { Hono } from "hono";
import {
  activeEdgesFrom,
  edgesFromAsOf,
  edgeHistory,
  invalidateEdge,
} from "@lokyy/core";

/**
 * Phase C Wave C2 / Story 1 — `/api/temporal-edges/*`.
 *
 *   GET  /api/temporal-edges/from/:noteId            currently-active edges
 *   GET  /api/temporal-edges/from/:noteId/at?ts=ISO  point-in-time query
 *   POST /api/temporal-edges/invalidate              { edgeId, invalidatedBy, [invalidAt] }
 *   GET  /api/temporal-edges/history/:edgeId         full history along the
 *                                                    (from, to, kind) lineage
 *
 * All read paths return the bi-temporal `tValid` / `tInvalid` columns as
 * ISO strings — JSON has no native Date.
 */
export const temporalEdgesRoutes = new Hono();

temporalEdgesRoutes.get("/from/:noteId/at", async (c) => {
  const noteId = c.req.param("noteId");
  const ts = c.req.query("ts");
  if (!ts) return c.json({ error: "ts query param required (ISO 8601)" }, 400);
  const asOf = new Date(ts);
  if (Number.isNaN(asOf.getTime())) {
    return c.json({ error: "invalid ts (must be ISO 8601)" }, 400);
  }
  const edges = await edgesFromAsOf(noteId, asOf);
  return c.json({
    noteId,
    asOf: asOf.toISOString(),
    edges: edges.map(toJsonEdge),
  });
});

temporalEdgesRoutes.get("/from/:noteId", async (c) => {
  const noteId = c.req.param("noteId");
  const edges = await activeEdgesFrom(noteId);
  return c.json({ noteId, edges: edges.map(toJsonEdge) });
});

temporalEdgesRoutes.post("/invalidate", async (c) => {
  const body = await c.req
    .json<{ edgeId?: string; invalidatedBy?: string; invalidAt?: string }>()
    .catch(() => ({}) as {
      edgeId?: string;
      invalidatedBy?: string;
      invalidAt?: string;
    });
  const edgeId = typeof body.edgeId === "string" ? body.edgeId : "";
  const invalidatedBy =
    typeof body.invalidatedBy === "string" ? body.invalidatedBy : "";
  if (!edgeId || !invalidatedBy) {
    return c.json(
      { error: "edgeId + invalidatedBy (string) required" },
      400,
    );
  }
  let invalidAt: Date | undefined;
  if (typeof body.invalidAt === "string") {
    const parsed = new Date(body.invalidAt);
    if (Number.isNaN(parsed.getTime())) {
      return c.json({ error: "invalid invalidAt (must be ISO 8601)" }, 400);
    }
    invalidAt = parsed;
  }
  await invalidateEdge(edgeId, invalidatedBy, invalidAt);
  return c.json({ ok: true, edgeId, invalidatedBy });
});

temporalEdgesRoutes.get("/history/:edgeId", async (c) => {
  const edgeId = c.req.param("edgeId");
  const edges = await edgeHistory(edgeId);
  return c.json({ edgeId, edges: edges.map(toJsonEdge) });
});

/**
 * Serialise the runtime `TemporalEdge` (with `Date` columns) to JSON. Dates
 * become ISO strings; everything else passes through. Local helper rather
 * than a public type because the wire-format is route-specific.
 */
function toJsonEdge(e: {
  id: string;
  fromNoteId: string;
  toNoteId: string;
  edgeKind: string;
  tCreated: Date;
  tExpired: Date | null;
  tValid: Date;
  tInvalid: Date | null;
  sourceNoteId: string | null;
  invalidatedBy: string | null;
  factText: string | null;
  confidence: number | null;
  metadata: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    id: e.id,
    fromNoteId: e.fromNoteId,
    toNoteId: e.toNoteId,
    edgeKind: e.edgeKind,
    tCreated: e.tCreated.toISOString(),
    tExpired: e.tExpired ? e.tExpired.toISOString() : null,
    tValid: e.tValid.toISOString(),
    tInvalid: e.tInvalid ? e.tInvalid.toISOString() : null,
    sourceNoteId: e.sourceNoteId,
    invalidatedBy: e.invalidatedBy,
    factText: e.factText,
    confidence: e.confidence,
    metadata: e.metadata,
  };
}
