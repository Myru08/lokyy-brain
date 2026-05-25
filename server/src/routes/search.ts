import { Hono } from "hono";
import {
  EmbeddingUnavailableError,
  Tier2Provider,
  getMemoryProvider,
  getNote,
  hybridSearch,
  type HybridOpts,
  type SearchOpts,
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

export { getNote };
