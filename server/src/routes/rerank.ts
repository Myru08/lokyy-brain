import { Hono } from "hono";
import {
  RerankerService,
  LlmRouter,
  getLlmRouting,
  type RerankInput,
  type RerankedHit,
} from "@lokyy/core";

/**
 * /api/rerank — Phase B Wave B2 / Story 1
 *
 * POST /api/rerank
 *   body: {
 *     query: string,
 *     inputs: Array<{ noteId: string; text: string; baseScore?: number }>,
 *     topN?: number,                  // default 5
 *     applyImportanceBoost?: boolean, // default true
 *     importanceWeight?: number,      // default 0.3
 *   }
 *   →    { hits: RerankedHit[] }
 *
 * Lazily builds the RerankerService once per server lifetime (same pattern
 * as `intent.ts` / `hyde.ts`). Provider behind the "rerank" role is decided
 * by the persisted LLM-routing config (Cohere | LocalReranker | …).
 */
export const rerankRoutes = new Hono();

let _service: RerankerService | null = null;

async function getService(): Promise<RerankerService> {
  if (!_service) {
    const routing = await getLlmRouting();
    _service = new RerankerService(new LlmRouter(routing));
  }
  return _service;
}

interface RerankBody {
  query?: unknown;
  inputs?: unknown;
  topN?: unknown;
  applyImportanceBoost?: unknown;
  importanceWeight?: unknown;
}

function sanitizeInputs(raw: unknown): RerankInput[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: RerankInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { noteId?: unknown; text?: unknown; baseScore?: unknown };
    if (typeof e.noteId !== "string" || e.noteId.length === 0) continue;
    if (typeof e.text !== "string" || e.text.length === 0) continue;
    const baseScore =
      typeof e.baseScore === "number" && Number.isFinite(e.baseScore)
        ? e.baseScore
        : undefined;
    cleaned.push({ noteId: e.noteId, text: e.text, baseScore });
  }
  return cleaned;
}

rerankRoutes.post("/", async (c) => {
  const body = await c.req.json<RerankBody>();

  const { query } = body;
  if (typeof query !== "string" || query.trim().length === 0) {
    return c.json({ error: "query required" }, 400);
  }

  const inputs = sanitizeInputs(body.inputs);
  if (inputs.length === 0) {
    return c.json({ hits: [] satisfies RerankedHit[] });
  }

  const topN =
    typeof body.topN === "number" && Number.isFinite(body.topN)
      ? Math.max(1, Math.floor(body.topN))
      : undefined;
  const applyImportanceBoost =
    typeof body.applyImportanceBoost === "boolean"
      ? body.applyImportanceBoost
      : undefined;
  const importanceWeight =
    typeof body.importanceWeight === "number" &&
    Number.isFinite(body.importanceWeight)
      ? body.importanceWeight
      : undefined;

  try {
    const service = await getService();
    const hits = await service.rerank(query, inputs, {
      topN,
      applyImportanceBoost,
      importanceWeight,
    });
    return c.json({ hits });
  } catch (err) {
    const message = err instanceof Error ? err.message : "rerank-failed";
    return c.json({ error: "rerank-failed", message }, 500);
  }
});
