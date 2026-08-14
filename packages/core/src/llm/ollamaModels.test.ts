import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectConfiguredOllamaModels,
  modelInstalled,
  resolveOllamaHost,
  ollamaModelSizeHint,
  getOllamaModelStatus,
} from "./ollamaModels.js";
import { OllamaProvider, type OllamaPullProgress } from "./providers/ollama.js";
import { LlmError } from "./errors.js";
import type { LlmRoutingConfig, ProviderConfig } from "./types.js";

// getOllamaModelStatus reads providers + routing from the config store; mock it
// so the test never needs a database (same shape the real store returns).
vi.mock("./configStore.js", () => ({
  getLlmProviders: vi.fn(),
  getLlmRouting: vi.fn(),
}));
import { getLlmProviders, getLlmRouting } from "./configStore.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Build a streaming Response body from a sequence of NDJSON records. */
function ndjsonResponse(records: OllamaPullProgress[], status = 200): Response {
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split into two chunks with a mid-line boundary to exercise buffering.
      const bytes = encoder.encode(body);
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

describe("collectConfiguredOllamaModels", () => {
  it("groups roles by model and applies provider defaults", () => {
    const routing: LlmRoutingConfig = {
      privacyTier: "always_local",
      roles: {
        embedding: { provider: "ollama" }, // no model → embed default
        "query-rewrite": { provider: "ollama", model: "llama3.1:8b" },
        hyde: { provider: "ollama" }, // no model → chat default
        "topic-synthesis": { provider: "anthropic", model: "claude-haiku-4-5" },
        rerank: { provider: "local-bge", model: "bge" },
      },
    };
    const models = collectConfiguredOllamaModels(routing);
    const byModel = Object.fromEntries(models.map((m) => [m.model, m]));

    expect(byModel["nomic-embed-text"]).toMatchObject({ kind: "embedding" });
    expect(byModel["nomic-embed-text"].roles).toEqual(["embedding"]);
    expect(byModel["llama3.1:8b"].kind).toBe("chat");
    expect(byModel["llama3.1:8b"].roles.sort()).toEqual(["hyde", "query-rewrite"]);
    // Cloud + local-bge providers are ignored.
    expect(models.some((m) => m.model === "claude-haiku-4-5")).toBe(false);
    expect(models.some((m) => m.model === "bge")).toBe(false);
  });

  it("returns [] when nothing routes to ollama", () => {
    expect(
      collectConfiguredOllamaModels({ privacyTier: "cloud_ok", roles: {} }),
    ).toEqual([]);
  });
});

describe("modelInstalled", () => {
  it("matches an untagged wanted against any tag of the same base", () => {
    expect(modelInstalled(["nomic-embed-text:latest"], "nomic-embed-text")).toBe(true);
    expect(modelInstalled(["llama3.1:8b"], "llama3.1:8b")).toBe(true);
  });
  it("does not match a different base", () => {
    expect(modelInstalled(["llama3.1:8b"], "llama3.2:3b")).toBe(false);
    expect(modelInstalled([], "llama3.1:8b")).toBe(false);
  });
});

describe("resolveOllamaHost", () => {
  const providers = (baseUrl?: string): ProviderConfig[] =>
    baseUrl ? [{ name: "ollama", enabled: true, baseUrl }] : [];

  it("prefers an explicit provider baseUrl", () => {
    expect(resolveOllamaHost(providers("http://ollama-x:11434"), "http://env:1")).toBe(
      "http://ollama-x:11434",
    );
  });
  it("falls back to the env host, then the default", () => {
    expect(resolveOllamaHost(providers(), "http://env:1")).toBe("http://env:1");
    expect(resolveOllamaHost(providers(), undefined)).toBe("http://localhost:11434");
  });
});

describe("ollamaModelSizeHint", () => {
  it("resolves exact tag then base name", () => {
    expect(ollamaModelSizeHint("llama3.1:8b")).toBeDefined();
    expect(ollamaModelSizeHint("nomic-embed-text:latest")).toBe(
      ollamaModelSizeHint("nomic-embed-text"),
    );
    expect(ollamaModelSizeHint("some-unknown-model:1b")).toBeUndefined();
  });
});

describe("OllamaProvider.pullModel", () => {
  it("streams progress records and resolves on clean end", async () => {
    vi.stubGlobal("fetch", async () =>
      ndjsonResponse([
        { status: "pulling manifest" },
        { status: "downloading", digest: "sha256:x", total: 100, completed: 40 },
        { status: "downloading", digest: "sha256:x", total: 100, completed: 100 },
        { status: "success" },
      ]),
    );
    const seen: OllamaPullProgress[] = [];
    await new OllamaProvider({ baseUrl: "http://x:11434" }).pullModel(
      "llama3.1:8b",
      (p) => seen.push(p),
    );
    expect(seen).toHaveLength(4);
    expect(seen[2]).toMatchObject({ total: 100, completed: 100 });
    expect(seen.at(-1)?.status).toBe("success");
  });

  it("throws LlmError when Ollama emits an error record", async () => {
    vi.stubGlobal("fetch", async () =>
      ndjsonResponse([{ status: "pulling manifest" }, { error: "model not found" }]),
    );
    await expect(
      new OllamaProvider({ baseUrl: "http://x:11434" }).pullModel("nope", () => {}),
    ).rejects.toBeInstanceOf(LlmError);
  });
});

describe("getOllamaModelStatus", () => {
  it("marks configured models installed/missing against /api/tags", async () => {
    vi.mocked(getLlmProviders).mockResolvedValue([
      { name: "ollama", enabled: true, baseUrl: "http://ollama-x:11434" },
    ]);
    vi.mocked(getLlmRouting).mockResolvedValue({
      privacyTier: "always_local",
      roles: {
        embedding: { provider: "ollama", model: "nomic-embed-text" },
        hyde: { provider: "ollama", model: "llama3.1:8b" },
      },
    });
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ models: [{ name: "nomic-embed-text:latest" }] }), {
        status: 200,
      }),
    );

    const status = await getOllamaModelStatus();
    expect(status.ollamaReachable).toBe(true);
    expect(status.host).toBe("http://ollama-x:11434");
    const byModel = Object.fromEntries(status.models.map((m) => [m.model, m]));
    expect(byModel["nomic-embed-text"].installed).toBe(true);
    expect(byModel["llama3.1:8b"].installed).toBe(false); // the Privacy-Max gap
    expect(byModel["llama3.1:8b"].sizeHint).toBeDefined();
  });

  it("degrades to ollamaReachable:false when /api/tags is unreachable", async () => {
    vi.mocked(getLlmProviders).mockResolvedValue([]);
    vi.mocked(getLlmRouting).mockResolvedValue({
      privacyTier: "always_local",
      roles: { hyde: { provider: "ollama", model: "llama3.1:8b" } },
    });
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    const status = await getOllamaModelStatus({ envHost: "http://localhost:11434" });
    expect(status.ollamaReachable).toBe(false);
    expect(status.error).toBeTruthy();
    expect(status.models[0].installed).toBe(false);
  });
});
