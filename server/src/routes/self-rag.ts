import { Hono } from "hono";
import { LlmRouter, SelfRagReflector, getLlmRouting } from "@lokyy/core";

/**
 * Self-RAG Reflection routes (Phase B Wave B1 / Story 4).
 *
 * Two endpoints, both pure functions over the LLM-router:
 *
 *   POST /api/self-rag/reflect
 *     body: { query: string, answer: string, chunkCount: number }
 *     →    ReflectionDecision
 *
 *   POST /api/self-rag/critique
 *     body: { query: string, chunks: Array<{ id: string, text: string }> }
 *     →    ChunkRelevance[]
 *
 * The reflector instance is lazily constructed once per server lifetime
 * (router config read on first use). No internal cache — each call is fresh.
 */

export const selfRagRoutes = new Hono();

let _reflector: SelfRagReflector | null = null;

async function getReflector(): Promise<SelfRagReflector> {
  if (!_reflector) {
    const routing = await getLlmRouting();
    _reflector = new SelfRagReflector(new LlmRouter(routing));
  }
  return _reflector;
}

selfRagRoutes.post("/reflect", async (c) => {
  const body = await c.req.json<{
    query?: unknown;
    answer?: unknown;
    chunkCount?: unknown;
  }>();
  const { query, answer, chunkCount } = body;
  if (typeof query !== "string") {
    return c.json({ error: "query (string) required" }, 400);
  }
  if (typeof answer !== "string") {
    return c.json({ error: "answer (string) required" }, 400);
  }
  if (typeof chunkCount !== "number" || !Number.isFinite(chunkCount)) {
    return c.json({ error: "chunkCount (number) required" }, 400);
  }
  const reflector = await getReflector();
  const result = await reflector.reflect(query, answer, chunkCount);
  return c.json(result);
});

selfRagRoutes.post("/critique", async (c) => {
  const body = await c.req.json<{
    query?: unknown;
    chunks?: unknown;
  }>();
  const { query, chunks } = body;
  if (typeof query !== "string") {
    return c.json({ error: "query (string) required" }, 400);
  }
  if (!Array.isArray(chunks)) {
    return c.json({ error: "chunks (array) required" }, 400);
  }
  const normalized: Array<{ id: string; text: string }> = [];
  for (const ch of chunks) {
    if (
      typeof ch !== "object" ||
      ch === null ||
      typeof (ch as { id?: unknown }).id !== "string" ||
      typeof (ch as { text?: unknown }).text !== "string"
    ) {
      return c.json(
        { error: "each chunk must be { id: string, text: string }" },
        400,
      );
    }
    normalized.push({
      id: (ch as { id: string }).id,
      text: (ch as { text: string }).text,
    });
  }
  const reflector = await getReflector();
  const result = await reflector.critiqueChunks(query, normalized);
  return c.json(result);
});
