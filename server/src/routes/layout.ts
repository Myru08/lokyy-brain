import { Hono } from "hono";
import {
  buildLayoutedPrompt,
  type ContextChunk,
  type ContextLayoutOptions,
  type QueryInjectionMode,
} from "@lokyy/core";

/**
 * Lost-in-the-Middle Context-Layout route.
 * Phase B Wave B2 / Story 3.
 *
 * POST /api/layout/build
 *   body: { query: string, chunks: ContextChunk[], options?: ContextLayoutOptions }
 *   →    LayoutResult
 *
 * Pure debug/UI endpoint. No LLM calls. No state. Useful for previewing
 * the prompt that downstream answer-routes will actually send to the model.
 */

export const layoutRoutes = new Hono();

const VALID_MODES: ReadonlySet<QueryInjectionMode> = new Set([
  "before",
  "after",
  "sandwich",
  "none",
]);

layoutRoutes.post("/build", async (c) => {
  let body: {
    query?: unknown;
    chunks?: unknown;
    options?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid-json" }, 400);
  }

  const { query } = body;
  if (typeof query !== "string" || query.trim().length === 0) {
    return c.json({ error: "query required (non-empty string)" }, 400);
  }

  if (!Array.isArray(body.chunks)) {
    return c.json({ error: "chunks required (array)" }, 400);
  }

  const chunks: ContextChunk[] = [];
  for (let i = 0; i < body.chunks.length; i++) {
    const raw = body.chunks[i] as Record<string, unknown> | null | undefined;
    if (!raw || typeof raw !== "object") {
      return c.json({ error: `chunks[${i}] must be an object` }, 400);
    }
    if (typeof raw.noteId !== "string" || raw.noteId.length === 0) {
      return c.json({ error: `chunks[${i}].noteId required` }, 400);
    }
    if (typeof raw.text !== "string") {
      return c.json({ error: `chunks[${i}].text required (string)` }, 400);
    }
    if (typeof raw.score !== "number" || !Number.isFinite(raw.score)) {
      return c.json({ error: `chunks[${i}].score required (finite number)` }, 400);
    }
    chunks.push({
      noteId: raw.noteId,
      text: raw.text,
      score: raw.score,
      chunkId: typeof raw.chunkId === "string" ? raw.chunkId : undefined,
      title: typeof raw.title === "string" ? raw.title : undefined,
    });
  }

  const options = parseOptions(body.options);
  if ("error" in options) {
    return c.json({ error: options.error }, 400);
  }

  try {
    const result = buildLayoutedPrompt(query, chunks, options.value);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "layout-failed";
    return c.json({ error: "layout-failed", message }, 500);
  }
});

function parseOptions(
  raw: unknown,
): { value: ContextLayoutOptions } | { error: string } {
  if (raw == null) return { value: {} };
  if (typeof raw !== "object") {
    return { error: "options must be an object" };
  }
  const r = raw as Record<string, unknown>;
  const out: ContextLayoutOptions = {};

  if (r.maxChunks !== undefined) {
    if (typeof r.maxChunks !== "number" || !Number.isFinite(r.maxChunks)) {
      return { error: "options.maxChunks must be a finite number" };
    }
    out.maxChunks = Math.max(0, Math.floor(r.maxChunks));
  }

  if (r.queryInjectionMode !== undefined) {
    if (
      typeof r.queryInjectionMode !== "string" ||
      !VALID_MODES.has(r.queryInjectionMode as QueryInjectionMode)
    ) {
      return {
        error:
          'options.queryInjectionMode must be one of "before" | "after" | "sandwich" | "none"',
      };
    }
    out.queryInjectionMode = r.queryInjectionMode as QueryInjectionMode;
  }

  if (r.separatorTemplate !== undefined) {
    if (typeof r.separatorTemplate !== "string") {
      return { error: "options.separatorTemplate must be a string" };
    }
    out.separatorTemplate = r.separatorTemplate;
  }

  if (r.chunkTemplate !== undefined) {
    if (typeof r.chunkTemplate !== "string") {
      return { error: "options.chunkTemplate must be a string" };
    }
    out.chunkTemplate = r.chunkTemplate;
  }

  return { value: out };
}
