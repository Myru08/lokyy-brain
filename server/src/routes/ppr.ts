import { Hono } from "hono";
import {
  personalizedPageRank,
  seedsFromRrfHits,
  type EdgeKind,
  type PPRHit,
} from "@lokyy/core";

/**
 * /api/ppr — Personalized PageRank über den Wikilink-Graph
 * (Phase B Wave B1 / Story 1, HippoRAG-style spreading activation).
 *
 * Routes:
 *   POST /api/ppr
 *     Body: { seeds: { [noteId: string]: number }, topK?, damping?,
 *             iterations?, edgeWeights?, applyImportanceBoost? }
 *     Response: { hits: PPRHit[] }
 *
 *   POST /api/ppr/from-hits
 *     Body: { hits: Array<{ noteId: string; score: number }>, topK?, damping?,
 *             iterations?, edgeWeights?, applyImportanceBoost? }
 *     Response: { hits: PPRHit[] }
 *
 * Both routes return the same shape — second is a convenience wrapper that
 * takes an RRF-style ranked list (e.g. from /api/search/hybrid) and runs
 * {@link seedsFromRrfHits} server-side.
 */
export const pprRoutes = new Hono();

interface PprCommonBody {
  topK?: number;
  damping?: number;
  iterations?: number;
  edgeWeights?: Partial<Record<EdgeKind, number>>;
  applyImportanceBoost?: boolean;
}

interface PprDirectBody extends PprCommonBody {
  seeds?: Record<string, number>;
}

interface PprFromHitsBody extends PprCommonBody {
  hits?: Array<{ noteId: string; score: number }>;
}

function buildOpts(body: PprCommonBody) {
  return {
    topK: body.topK,
    damping: body.damping,
    iterations: body.iterations,
    edgeWeights: body.edgeWeights,
    applyImportanceBoost: body.applyImportanceBoost,
  };
}

pprRoutes.post("/", async (c) => {
  const body = await c.req.json<PprDirectBody>();
  const seedMap = new Map<string, number>();
  if (body.seeds && typeof body.seeds === "object") {
    for (const [id, w] of Object.entries(body.seeds)) {
      if (typeof w === "number" && Number.isFinite(w)) seedMap.set(id, w);
    }
  }
  const hits: PPRHit[] = await personalizedPageRank({ seeds: seedMap }, buildOpts(body));
  return c.json({ hits });
});

pprRoutes.post("/from-hits", async (c) => {
  const body = await c.req.json<PprFromHitsBody>();
  const raw = Array.isArray(body.hits) ? body.hits : [];
  const sanitised = raw.filter(
    (h): h is { noteId: string; score: number } =>
      typeof h?.noteId === "string" && typeof h?.score === "number" && Number.isFinite(h.score),
  );
  const seeds = seedsFromRrfHits(sanitised);
  const hits: PPRHit[] = await personalizedPageRank(seeds, buildOpts(body));
  return c.json({ hits });
});
