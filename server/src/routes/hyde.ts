import { Hono } from "hono";
import { HyDE, LlmRouter, getLlmRouting } from "@lokyy/core";

/**
 * HyDE (Hypothetical Document Embedding) route.
 * Phase B Wave B1 / Story 2.
 *
 * POST /api/hyde
 *   body: { query: string, numHypothetical?: number, domainHint?: string, maxTokens?: number }
 *   →    { hypotheticalDocs, embeddings, fusedEmbedding, query, durationMs }
 *
 * Triggered upstream by the IntentClassifier — only `question`-intent
 * queries should reach this endpoint. The HyDE instance is lazily built
 * once per server lifetime (same pattern as `intent.ts`).
 */

export const hydeRoutes = new Hono();

let _hyde: HyDE | null = null;

async function getHyDE(): Promise<HyDE> {
  if (!_hyde) {
    const routing = await getLlmRouting();
    _hyde = new HyDE(new LlmRouter(routing));
  }
  return _hyde;
}

hydeRoutes.post("/", async (c) => {
  const body = await c.req.json<{
    query?: unknown;
    numHypothetical?: unknown;
    domainHint?: unknown;
    maxTokens?: unknown;
  }>();

  const { query } = body;
  if (typeof query !== "string" || query.trim().length === 0) {
    return c.json({ error: "query required" }, 400);
  }

  const numHypothetical =
    typeof body.numHypothetical === "number" && Number.isFinite(body.numHypothetical)
      ? Math.max(1, Math.floor(body.numHypothetical))
      : undefined;
  const domainHint =
    typeof body.domainHint === "string" ? body.domainHint : undefined;
  const maxTokens =
    typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens)
      ? Math.max(1, Math.floor(body.maxTokens))
      : undefined;

  try {
    const hyde = await getHyDE();
    const result = await hyde.expand(query, {
      numHypothetical,
      domainHint,
      maxTokens,
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "hyde-failed";
    return c.json({ error: "hyde-failed", message }, 500);
  }
});
