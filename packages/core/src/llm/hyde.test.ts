import { describe, it, expect } from "vitest";
import { HyDE } from "./hyde.js";
import type { LlmRouter } from "./router.js";
import type {
  ChatMessage,
  ChatOpts,
  ChatResult,
  EmbedResult,
  LlmProvider,
} from "./types.js";

/**
 * HyDE accepts an `LlmRouter`. Mirror the intent-classifier stub pattern:
 * fabricate a minimal router that returns one provider for "hyde" (chat)
 * and one for "embedding" (embeddings). No real registry is touched.
 */

function makeChatProvider(text: string): LlmProvider {
  return {
    info: {
      name: "stub-chat",
      capabilities: {
        chat: true,
        embed: false,
        rerank: false,
        stream: false,
        toolCalling: false,
      },
      isLocal: true,
    },
    async testConnection() {
      return { ok: true };
    },
    chat: async (
      _messages: ChatMessage[],
      _opts?: ChatOpts,
    ): Promise<ChatResult> => ({
      text,
      usage: { inputTokens: 10, outputTokens: 10 },
      model: "stub-chat",
      finishReason: "stop",
    }),
  };
}

function makeEmbedProvider(dim: number): LlmProvider {
  return {
    info: {
      name: "stub-embed",
      capabilities: {
        chat: false,
        embed: true,
        rerank: false,
        stream: false,
        toolCalling: false,
      },
      isLocal: true,
    },
    async testConnection() {
      return { ok: true };
    },
    embeddings: async (texts: string[]): Promise<EmbedResult> => {
      // Deterministic vector: byte 0 = text length, rest zero. Keeps the math
      // simple and lets us assert the mean-pool divides by N correctly.
      const vectors = texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        v[0] = t.length;
        return v;
      });
      return {
        vectors,
        model: "stub-embed",
        dimensions: dim,
        usage: { inputTokens: 1 },
      };
    },
  };
}

function makeRouter(chatText: string, dim: number): LlmRouter {
  const chatProvider = makeChatProvider(chatText);
  const embedProvider = makeEmbedProvider(dim);
  const router = {
    getProvider: (role: string) => {
      if (role === "hyde") return chatProvider;
      if (role === "embedding") return embedProvider;
      throw new Error(`unexpected role: ${role}`);
    },
    getProviderChain: (role: string) => [
      role === "hyde" ? chatProvider : embedProvider,
    ],
  };
  return router as unknown as LlmRouter;
}

describe("HyDE — single hypothetical (default)", () => {
  it("produces one hypothetical + one embedding + identical fused vector", async () => {
    const hyde = new HyDE(makeRouter("hypothetical answer text", 4));
    const result = await hyde.expand("What does CRDT mean?");

    expect(result.query).toBe("What does CRDT mean?");
    expect(result.hypotheticalDocs).toHaveLength(1);
    expect(result.hypotheticalDocs[0]).toBe("hypothetical answer text");
    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toHaveLength(4);
    // fused == single embedding when N=1
    expect(result.fusedEmbedding).toEqual(result.embeddings[0]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("HyDE — multi-HyDE mean pooling", () => {
  it("averages N hypothetical embeddings into the fused centroid", async () => {
    // Every chat call returns the same text → every embedding is identical →
    // the mean equals any single vector. This isolates the arithmetic from
    // the chat-variance dimension.
    const hyde = new HyDE(makeRouter("answer", 3));
    const result = await hyde.expand("Why pool?", { numHypothetical: 3 });

    expect(result.hypotheticalDocs).toHaveLength(3);
    expect(result.embeddings).toHaveLength(3);
    expect(result.fusedEmbedding).toHaveLength(3);
    // text length = 6, so each vector is [6, 0, 0]; mean is [6, 0, 0].
    expect(result.fusedEmbedding[0]).toBeCloseTo(6, 9);
    expect(result.fusedEmbedding[1]).toBeCloseTo(0, 9);
    expect(result.fusedEmbedding[2]).toBeCloseTo(0, 9);
  });
});

describe("HyDE — guard clauses", () => {
  it("throws when the hyde provider has no chat capability", async () => {
    const router = {
      getProvider: () => ({
        info: {
          name: "no-chat",
          capabilities: {
            chat: false,
            embed: false,
            rerank: false,
            stream: false,
            toolCalling: false,
          },
          isLocal: true,
        },
        async testConnection() {
          return { ok: true };
        },
      }),
      getProviderChain: () => [],
    } as unknown as LlmRouter;
    const hyde = new HyDE(router);
    await expect(hyde.expand("query")).rejects.toThrow(/no chat capability/);
  });
});
