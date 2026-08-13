import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * issue #46 — the Ollama model presence + pull routes under `/api/llm/models`.
 *
 * The two guarantees a careless refactor would break:
 *   - `/models/status` surfaces the CONFIGURED-model presence report (the check
 *     Privacy-Max needs), not just endpoint reachability.
 *   - `/models/pull` relays the pull as SSE progress + a terminal event, and
 *     rejects a missing `model` query up front.
 */

// @lokyy/core reads process.env at import time (DB url etc.).
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

// Partial-mock core: keep everything real, override only the two functions the
// new routes call, so we never touch Ollama or the DB.
vi.mock("@lokyy/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getOllamaModelStatus: vi.fn(),
    pullOllamaModel: vi.fn(),
  };
});

type CoreMod = typeof import("@lokyy/core");
let core: CoreMod;
let app: Hono;

beforeAll(async () => {
  core = await import("@lokyy/core");
  const mod = await import("./llm.js");
  app = new Hono();
  app.route("/api/llm", mod.llmRoutes);
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/llm/models/status", () => {
  it("returns the configured-model presence report", async () => {
    vi.mocked(core.getOllamaModelStatus).mockResolvedValue({
      ollamaReachable: true,
      host: "http://ollama-x:11434",
      installed: ["nomic-embed-text:latest"],
      models: [
        { model: "nomic-embed-text", roles: ["embedding"], kind: "embedding", installed: true },
        {
          model: "llama3.1:8b",
          roles: ["hyde"],
          kind: "chat",
          installed: false,
          sizeHint: "~4.9 GB",
        },
      ],
    });

    const res = await app.request("/api/llm/models/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: { model: string; installed: boolean }[] };
    expect(body.models).toHaveLength(2);
    expect(body.models.find((m) => m.model === "llama3.1:8b")?.installed).toBe(false);
  });
});

describe("GET /api/llm/models/pull", () => {
  it("400s without a model query", async () => {
    const res = await app.request("/api/llm/models/pull");
    expect(res.status).toBe(400);
  });

  it("streams progress + a terminal done event on success", async () => {
    vi.mocked(core.pullOllamaModel).mockImplementation(
      async (_model: string, onProgress: (p: { status?: string; total?: number; completed?: number }) => void) => {
        onProgress({ status: "pulling manifest" });
        onProgress({ status: "downloading", total: 100, completed: 100 });
      },
    );

    const res = await app.request("/api/llm/models/pull?model=llama3.1:8b");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: progress");
    expect(text).toContain("event: done");
    expect(text).toContain("success");
  });

  it("emits an error event when the pull rejects", async () => {
    vi.mocked(core.pullOllamaModel).mockRejectedValue(new Error("model not found"));

    const res = await app.request("/api/llm/models/pull?model=nope");
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("model not found");
  });
});
