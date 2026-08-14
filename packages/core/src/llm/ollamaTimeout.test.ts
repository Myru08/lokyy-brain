import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OllamaProvider,
  OLLAMA_DEFAULT_TIMEOUT_MS,
  resolveOllamaTimeoutMs,
} from "./providers/ollama.js";
import { LocalReranker } from "./providers/localReranker.js";
import { initLlmFromConfig } from "./init.js";
import { llmRegistry } from "./registry.js";

/**
 * Issue #54: der 60-s-Default war für CPU-only-Setups ("Privacy Max")
 * strukturell zu knapp — ein einzelner llama3.1:8b-Call misst dort 76,6 s.
 * Diese Tests belegen: (a) der Default liegt über der Messung, (b) die
 * Env-Var kommt bis in den abort-Deadline des konstruierten Providers an,
 * (c) Müll in der Env bricht nichts, sondern fällt auf den Default zurück.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  llmRegistry().clear();
});

describe("resolveOllamaTimeoutMs", () => {
  it("hat einen Default deutlich über der gemessenen CPU-Laufzeit (76,6 s)", () => {
    expect(OLLAMA_DEFAULT_TIMEOUT_MS).toBeGreaterThan(76_600);
    expect(resolveOllamaTimeoutMs()).toBe(OLLAMA_DEFAULT_TIMEOUT_MS);
  });

  it("liest einen gültigen Env-Wert", () => {
    expect(resolveOllamaTimeoutMs(undefined, "180000")).toBe(180_000);
    expect(resolveOllamaTimeoutMs(undefined, "  90000  ")).toBe(90_000);
  });

  it("bevorzugt einen expliziten Wert vor der Env", () => {
    expect(resolveOllamaTimeoutMs(45_000, "180000")).toBe(45_000);
  });

  it("fällt bei ungültigen Werten auf den Default zurück, ohne zu werfen", () => {
    for (const bad of ["", "   ", "abc", "-1", "0", "NaN", "Infinity", "12s"]) {
      expect(resolveOllamaTimeoutMs(undefined, bad)).toBe(OLLAMA_DEFAULT_TIMEOUT_MS);
    }
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveOllamaTimeoutMs(bad)).toBe(OLLAMA_DEFAULT_TIMEOUT_MS);
    }
  });

  it("liest process.env.LOKYY_OLLAMA_TIMEOUT_MS, wenn kein Wert übergeben wird", () => {
    vi.stubEnv("LOKYY_OLLAMA_TIMEOUT_MS", "123456");
    expect(resolveOllamaTimeoutMs()).toBe(123_456);
    vi.stubEnv("LOKYY_OLLAMA_TIMEOUT_MS", "nonsense");
    expect(resolveOllamaTimeoutMs()).toBe(OLLAMA_DEFAULT_TIMEOUT_MS);
  });
});

/**
 * Misst den tatsächlichen Abort-Deadline eines Providers: fetch wird durch
 * ein Promise ersetzt, das nur über das AbortSignal endet. Mit Fake-Timers
 * prüfen wir, dass kurz VOR `expectedMs` noch nichts abgebrochen ist und
 * kurz danach schon.
 */
async function expectAbortAfter(
  run: () => Promise<unknown>,
  expectedMs: number,
): Promise<void> {
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    signal = init.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new Error("This operation was aborted")),
      );
    });
  });

  vi.useFakeTimers();
  const pending = run();
  await vi.advanceTimersByTimeAsync(expectedMs - 1);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  expect(signal?.aborted).toBe(true);
  await pending;
}

describe("OllamaProvider abort deadline", () => {
  it("nutzt den Default, wenn nichts konfiguriert ist", async () => {
    const provider = new OllamaProvider({ baseUrl: "http://x:11434" });
    await expectAbortAfter(() => provider.testConnection(), OLLAMA_DEFAULT_TIMEOUT_MS);
  });

  it("nutzt LOKYY_OLLAMA_TIMEOUT_MS", async () => {
    vi.stubEnv("LOKYY_OLLAMA_TIMEOUT_MS", "150000");
    const provider = new OllamaProvider({ baseUrl: "http://x:11434" });
    await expectAbortAfter(() => provider.testConnection(), 150_000);
  });
});

describe("initLlmFromConfig", () => {
  it("reicht LOKYY_OLLAMA_TIMEOUT_MS bis zum konstruierten ollama-Provider durch", async () => {
    vi.stubEnv("LOKYY_OLLAMA_TIMEOUT_MS", "200000");
    await initLlmFromConfig([{ name: "ollama", enabled: true, baseUrl: "http://x:11434" }]);
    const provider = llmRegistry().get("ollama");
    expect(provider).toBeDefined();
    await expectAbortAfter(() => provider!.testConnection(), 200_000);
  });

  it("lässt eine explizite ProviderConfig.timeoutMs gewinnen", async () => {
    vi.stubEnv("LOKYY_OLLAMA_TIMEOUT_MS", "200000");
    await initLlmFromConfig([
      { name: "ollama", enabled: true, baseUrl: "http://x:11434", timeoutMs: 42_000 },
    ]);
    await expectAbortAfter(() => llmRegistry().get("ollama")!.testConnection(), 42_000);
  });

  it("ignoriert einen kaputten Env-Wert und startet trotzdem", async () => {
    vi.stubEnv("LOKYY_OLLAMA_TIMEOUT_MS", "später");
    const result = await initLlmFromConfig([
      { name: "ollama", enabled: true, baseUrl: "http://x:11434" },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.registered).toContain("ollama");
    await expectAbortAfter(
      () => llmRegistry().get("ollama")!.testConnection(),
      OLLAMA_DEFAULT_TIMEOUT_MS,
    );
  });
});

describe("LocalReranker abort deadline", () => {
  it("erbt denselben lokalen Timeout (Env schlägt durch)", async () => {
    vi.stubEnv("LOKYY_OLLAMA_TIMEOUT_MS", "170000");
    const reranker = new LocalReranker({ baseUrl: "http://x:11434" });
    await expectAbortAfter(() => reranker.testConnection(), 170_000);
  });

  it("nutzt ohne Env den Ollama-Default statt der alten 30 s", async () => {
    const reranker = new LocalReranker({ baseUrl: "http://x:11434" });
    await expectAbortAfter(() => reranker.testConnection(), OLLAMA_DEFAULT_TIMEOUT_MS);
  });
});
