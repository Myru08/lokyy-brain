import { Hono } from "hono";
import { IntentClassifier, LlmRouter, getLlmRouting } from "@lokyy/core";

/**
 * Intent classification route (Phase A Wave A1 / Story 4).
 *
 * POST /api/intent/classify
 *   body: { query: string }
 *   →    { intent, confidence, reasoning? }
 *
 * The classifier instance is lazily constructed once per server lifetime
 * (router config is read at first use). Cache lives inside the classifier.
 */

export const intentRoutes = new Hono();

let _classifier: IntentClassifier | null = null;

async function getClassifier(): Promise<IntentClassifier> {
  if (!_classifier) {
    const routing = await getLlmRouting();
    _classifier = new IntentClassifier(new LlmRouter(routing));
  }
  return _classifier;
}

intentRoutes.post("/classify", async (c) => {
  const body = await c.req.json<{ query?: unknown }>();
  const { query } = body;
  if (typeof query !== "string") {
    return c.json({ error: "query required" }, 400);
  }
  const classifier = await getClassifier();
  const result = await classifier.classify(query);
  return c.json(result);
});
