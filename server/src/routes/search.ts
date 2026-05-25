import { Hono } from "hono";
import {
  EmbeddingUnavailableError,
  LlmRouter,
  RagFusion,
  Tier2Provider,
  buildSearchPipeline,
  getLlmRouting,
  getMemoryProvider,
  getNote,
  hybridSearch,
  type HybridOpts,
  type RetrieveHit,
  type SearchOpts,
  type SearchPipelineInput,
} from "@lokyy/core";

/**
 * Search routes.
 *
 * POST /api/search             — Tier 1 + Tier 2 merged hits (Story 5.5)
 * GET  /api/notes/:id/related  — top-N related notes (Story 5.6)
 * POST /api/search/hybrid      — BM25 (pg_search) + dense (pgvector) via RRF
 *                                fusion (Phase A Wave A1 / Story 2)
 *
 * vaultId is implicit for now (single-active-vault dev mode). Once Story
 * 3's route migration to /api/vaults/:vaultId/* lands, these will move
 * under that scope.
 */

const DEFAULT_VAULT = process.env.LOKYY_DEFAULT_VAULT ?? "default";

export const searchRoutes = new Hono();

searchRoutes.post("/search", async (c) => {
  const { query, limit, tagFilter, folderPrefix } = await c.req.json<{
    query: string;
    limit?: number;
    tagFilter?: string[];
    folderPrefix?: string;
  }>();
  const opts: SearchOpts = { limit, tagFilter, folderPrefix };
  const hits = await getMemoryProvider(DEFAULT_VAULT).search(query ?? "", opts);
  return c.json({ results: hits, degraded: hits.every((h) => h.tier === "t1") && hits.length > 0 ? false : false });
});

searchRoutes.get("/notes/:id{.+}/related", async (c) => {
  const noteId = c.req.param("id");
  const limit = Number(c.req.query("limit") ?? "5");
  const hits = await getMemoryProvider(DEFAULT_VAULT).relatedNotes(noteId, { limit });
  return c.json({ results: hits });
});

/**
 * POST /api/search/hybrid — BM25 + Dense via RRF.
 *
 * Body:
 *   { query: string, intent?: "exact_recall" | "topical" | "associative" | "question",
 *     topK?: number, rrfK?: number }
 *
 * Response:
 *   { hits: [{ noteId, title, score, snippet? }],
 *     degraded?: "no_embedding" | "no_bm25" }
 *
 * Degradation:
 *   - Ollama unreachable → no query embedding → returns BM25-only via the
 *     `note_search` path (still useful). `degraded: "no_embedding"`.
 *   - Both unavailable → empty hits.
 */
searchRoutes.post("/search/hybrid", async (c) => {
  const body = await c.req.json<{
    query: string;
    intent?: HybridOpts["intent"];
    topK?: number;
    rrfK?: number;
  }>();
  const query = body.query ?? "";
  if (!query.trim()) {
    return c.json({ hits: [] });
  }

  // Embed the query via Tier-2 (which already speaks Ollama). On failure,
  // fall back to a zero-vector — the dense leg will return useless rankings
  // but the BM25 leg keeps working. Mark the response as degraded.
  const t2 = new Tier2Provider({ vaultId: DEFAULT_VAULT });
  let queryEmbedding: number[];
  let degraded: "no_embedding" | undefined;
  try {
    // Tier2Provider.embed is private — exercise it indirectly via search()
    // would re-run the SQL we want to subsume. Instead use a tiny utility:
    // call the public `indexNote` path? No — that writes. We need a
    // dedicated embed helper. Use a direct fetch matching Tier2Provider.
    queryEmbedding = await embedQuery(query);
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError || err instanceof Error) {
      // Zero-vector keeps the SQL valid; dense leg contributes no useful
      // signal so the result is effectively BM25-only.
      queryEmbedding = new Array<number>(768).fill(0);
      degraded = "no_embedding";
    } else {
      throw err;
    }
  }

  const hits = await hybridSearch(query, queryEmbedding, {
    intent: body.intent,
    topK: body.topK,
    rrfK: body.rrfK,
    vaultId: DEFAULT_VAULT,
  });
  // Eliminate accidental unused-binding lint on t2 — placeholder until the
  // embed helper migrates into core.
  void t2;
  return c.json(degraded ? { hits, degraded } : { hits });
});

/**
 * Local embedding helper — mirrors Tier2Provider.embed. Lives here until a
 * dedicated embed-only export lands in core; duplicates ~15 lines for now.
 */
async function embedQuery(text: string): Promise<number[]> {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = "nomic-embed-text";
  const res = await fetch(`${host}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}`);
  const data = (await res.json()) as { embedding: number[] };
  if (!Array.isArray(data.embedding) || data.embedding.length !== 768) {
    throw new Error(`Unexpected embedding shape: ${data.embedding?.length}`);
  }
  return data.embedding;
}

/**
 * POST /api/search/rag-fusion — Multi-Query Rewrite + RRF (Phase B Wave B1 / Story 3).
 *
 * Body:
 *   { query: string, numRewrites?: number, rrfK?: number, topK?: number,
 *     includeOriginal?: boolean, intent?: HybridOpts["intent"] }
 *
 * Response:
 *   { rewrites: [{ text, isOriginal }],
 *     fused:    [{ noteId, title?, score, sources }],
 *     durationMs, degraded? }
 *
 * The retrieval function passed to `RagFusion` wraps `hybridSearch` so each
 * variant gets the full BM25+dense pipeline. Embedding failures degrade
 * gracefully to a zero-vector (BM25-only) per variant — same behaviour as
 * `/api/search/hybrid`. LLM rewrite failures degrade to original-only and
 * are flagged via `degraded: true` in the response.
 */
let _ragRouter: LlmRouter | null = null;
async function getRagRouter(): Promise<LlmRouter> {
  if (!_ragRouter) {
    const routing = await getLlmRouting();
    _ragRouter = new LlmRouter(routing);
  }
  return _ragRouter;
}

searchRoutes.post("/search/rag-fusion", async (c) => {
  const body = await c.req.json<{
    query?: string;
    numRewrites?: number;
    rrfK?: number;
    topK?: number;
    includeOriginal?: boolean;
    intent?: HybridOpts["intent"];
  }>();
  const query = (body.query ?? "").trim();
  if (query.length === 0) {
    return c.json({ rewrites: [], fused: [], durationMs: 0 });
  }

  const router = await getRagRouter();

  // Wrap hybridSearch into a uniform retrieval-fn the fuser expects.
  // Embedding errors per-variant are absorbed into a zero-vector so the
  // BM25 leg still contributes — mirrors /api/search/hybrid.
  const retrieve = async (variant: string): Promise<RetrieveHit[]> => {
    let embedding: number[];
    try {
      embedding = await embedQuery(variant);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError || err instanceof Error) {
        embedding = new Array<number>(768).fill(0);
      } else {
        throw err;
      }
    }
    const hits = await hybridSearch(variant, embedding, {
      intent: body.intent,
      topK: body.topK,
      rrfK: body.rrfK,
      vaultId: DEFAULT_VAULT,
    });
    return hits.map((h) => ({ noteId: h.noteId, score: h.score }));
  };

  const fuser = new RagFusion(router, retrieve);
  const result = await fuser.fuse(query, {
    numRewrites: body.numRewrites,
    rrfK: body.rrfK,
    topK: body.topK,
    includeOriginal: body.includeOriginal,
  });

  // Enrich fused hits with note titles so the PWA doesn't need an extra
  // round-trip. Missing notes (deleted between index and request) are
  // dropped silently — same policy as other search routes.
  const enriched = await Promise.all(
    result.fused.map(async (h) => {
      const note = await getNote(h.noteId);
      if (!note) return null;
      return {
        noteId: h.noteId,
        title: note.title,
        score: h.score,
        sources: h.sources,
      };
    }),
  );

  return c.json({
    rewrites: result.rewrites,
    fused: enriched.filter((x): x is NonNullable<typeof x> => x !== null),
    durationMs: result.durationMs,
    ...(result.degraded ? { degraded: true } : {}),
  });
});

/**
 * POST /api/search/pipeline — Phase B Wave B3 / Story 2.
 *
 * Run the full 8-step cognitive retrieval pipeline:
 *   conversational rewrite → intent classify → hybrid (or RAG-Fusion for
 *   question intent) → working-memory boost → PPR (associative only) →
 *   encoding-context boost → rerank → lost-in-middle layout → generate
 *   with Self-RAG reflection.
 *
 * Body matches `SearchPipelineInput`:
 *   { query: string,
 *     conversationHistory?, sessionId?, sessionContext?,
 *     generate?, forceIntent?, maxRetrievalHops?, vaultId? }
 *
 * Response is the full `SearchPipelineResult` including per-step
 * telemetry and `degraded[]` flags. The pipeline never throws — caller
 * always gets a result, possibly with `rerankedHits: []` if retrieval
 * found nothing.
 *
 * Note on cost: when `generate=true` and the LLM judges the answer
 * incomplete, the pipeline may issue up to `maxRetrievalHops-1` extra
 * direct-hybrid retrievals + LLM regenerations. Cap at the default 3
 * if you care about p99 latency; bump for research-grade answers.
 */
searchRoutes.post("/search/pipeline", async (c) => {
  // Reuse the request's JSON as `SearchPipelineInput`. Defensive: missing
  // body / missing query short-circuits with an empty-shape response so
  // the PWA gets predictable JSON instead of a 400.
  let body: Partial<SearchPipelineInput>;
  try {
    body = (await c.req.json()) as Partial<SearchPipelineInput>;
  } catch {
    body = {};
  }
  const query = (body.query ?? "").trim();
  if (query.length === 0) {
    return c.json({
      query: "",
      rewrittenQuery: "",
      intent: "topical" as const,
      hops: 0,
      totalDurationMs: 0,
      steps: [],
      rerankedHits: [],
      degraded: ["empty_query"],
    });
  }
  const pipeline = await buildSearchPipeline();
  // Cast through SearchPipelineInput so optional fields propagate without
  // re-declaring the body shape here.
  const result = await pipeline.execute({ ...body, query } as SearchPipelineInput);
  return c.json(result);
});

export { getNote };
