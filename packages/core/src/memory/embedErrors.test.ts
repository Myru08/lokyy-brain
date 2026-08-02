import { describe, it, expect, afterEach, vi } from "vitest";
import {
  Tier2Provider,
  EmbeddingUnavailableError,
  EmbeddingInputTooLargeError,
} from "./Tier2Provider.js";

/**
 * Story 5.8 AC#5 — an oversized-input rejection must not be reported as
 * "Ollama unreachable".
 *
 * The community reporter lost debugging time to exactly that mistranslation:
 * every non-2xx response collapsed into `EmbeddingUnavailableError("Ollama
 * embedding service unreachable")`, so an HTTP 500 caused by a too-large chunk
 * read as a service outage. The real response body was captured against the
 * deployed Ollama:
 *
 *   HTTP 500 {"error":"the input length exceeds the context length"}
 *
 * With the AC#3/AC#4 size gates in place this branch should rarely fire — it
 * is defense-in-depth for a future model swap with a smaller window.
 */

const provider = new Tier2Provider({ vaultId: "01TESTVAULT0000000000000000" });

/** `embed` is private by design; this test targets exactly its error mapping. */
const embed = (text: string): Promise<number[]> =>
  (provider as unknown as { embed(t: string): Promise<number[]> }).embed(text);

function respondWith(status: number, body: string): void {
  vi.stubGlobal("fetch", async () => new Response(body, { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Story 5.8 AC#5 — embed() failure classification", () => {
  it("a connection failure is still reported as unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(embed("hi")).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    await expect(embed("hi")).rejects.toThrow(/unreachable/i);
  });

  it("HTTP 500 'input length exceeds the context length' is NOT an outage", async () => {
    respondWith(500, JSON.stringify({ error: "the input length exceeds the context length" }));

    await expect(embed("x".repeat(100))).rejects.toBeInstanceOf(
      EmbeddingInputTooLargeError,
    );
    await expect(embed("x".repeat(100))).rejects.not.toBeInstanceOf(
      EmbeddingUnavailableError,
    );

    const err = await embed("x".repeat(100)).catch((e: Error) => e);
    expect(err.message).not.toMatch(/unreachable/i);
    expect(err.message).toMatch(/context/i);
  });

  it("a genuine server error keeps the unreachable classification and reports the status", async () => {
    respondWith(503, "upstream connect error");
    const err = await embed("hi").catch((e: Error) => e);
    expect(err).toBeInstanceOf(EmbeddingUnavailableError);
    expect(err.message).toMatch(/503/);
  });

  it("a missing model is an availability problem, not a size problem", async () => {
    respondWith(404, JSON.stringify({ error: 'model "nomic-embed-text" not found' }));
    const err = await embed("hi").catch((e: Error) => e);
    expect(err).toBeInstanceOf(EmbeddingUnavailableError);
    expect(err).not.toBeInstanceOf(EmbeddingInputTooLargeError);
  });

  it("an unexpected embedding shape stays an availability error", async () => {
    respondWith(200, JSON.stringify({ embedding: [1, 2, 3] }));
    await expect(embed("hi")).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });
});
