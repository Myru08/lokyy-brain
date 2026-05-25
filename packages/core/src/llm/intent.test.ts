import { describe, it, expect, beforeEach } from "vitest";
import { IntentClassifier, type QueryIntent } from "./intent.js";
import type { LlmRouter } from "./router.js";
import type { ChatMessage, ChatOpts, ChatResult, LlmProvider } from "./types.js";

/**
 * The classifier accepts an `LlmRouter`. We don't want to spin up a real
 * registry for unit tests — so we build a minimal stub router that satisfies
 * the structural shape used by `IntentClassifier`:
 *   `router.getProvider("intent-classifier")` → object with optional `chat`.
 */

interface StubResponse {
  text: string;
}

function makeRouter(response: StubResponse | "no-chat" | "throws"): LlmRouter {
  const provider: Partial<LlmProvider> = {
    info: {
      name: "stub",
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
  };

  if (response !== "no-chat") {
    provider.chat = async (
      _messages: ChatMessage[],
      _opts?: ChatOpts,
    ): Promise<ChatResult> => {
      if (response === "throws") {
        throw new Error("simulated provider failure");
      }
      return {
        text: response.text,
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "stub",
        finishReason: "stop",
      };
    };
  }

  const router = {
    getProvider: () => provider as LlmProvider,
    getProviderChain: () => [provider as LlmProvider],
  };
  return router as unknown as LlmRouter;
}

describe("IntentClassifier — rule-based fast-path", () => {
  let classifier: IntentClassifier;

  beforeEach(() => {
    // LLM throws on every call — proves the rule-based path actually short-circuits
    // for high-confidence queries. Low-confidence queries would fall through and
    // come back as the rule-based default ("topical" 0.6).
    classifier = new IntentClassifier(makeRouter("throws"));
  });

  it("classifies wh-questions as 'question'", async () => {
    const result = await classifier.classify("What does CRDT mean?");
    expect(result.intent).toBe<QueryIntent>("question");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("classifies German wh-words as 'question'", async () => {
    const result = await classifier.classify("Was ist Embedding-Drift?");
    expect(result.intent).toBe<QueryIntent>("question");
  });

  it("classifies recall phrasing as 'exact_recall'", async () => {
    const result = await classifier.classify(
      "the note where I wrote about my Q3 plan",
    );
    expect(result.intent).toBe<QueryIntent>("exact_recall");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("classifies relational queries as 'associative'", async () => {
    const result = await classifier.classify(
      "everything related to the summer project",
    );
    expect(result.intent).toBe<QueryIntent>("associative");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("falls back to 'topical' for low-signal queries (LLM-throws path)", async () => {
    // No rule pattern triggers → low-confidence default → LLM throws → rule-based
    // fallback is returned (topical / 0.6).
    const result = await classifier.classify("deep learning architectures");
    expect(result.intent).toBe<QueryIntent>("topical");
    expect(result.confidence).toBeLessThan(0.85);
  });

  it("returns 'topical' for empty queries without calling the LLM", async () => {
    const result = await classifier.classify("   ");
    expect(result.intent).toBe<QueryIntent>("topical");
    expect(result.reasoning).toBe("empty query");
  });
});

describe("IntentClassifier — LLM fallback parsing", () => {
  it("parses well-formed JSON from the LLM", async () => {
    const classifier = new IntentClassifier(
      makeRouter({
        text: '{"intent": "topical", "confidence": 0.78, "reasoning": "broad browse"}',
      }),
    );
    // Low-confidence rule path → LLM gets called.
    const result = await classifier.classify("deep learning architectures");
    expect(result.intent).toBe<QueryIntent>("topical");
    expect(result.confidence).toBeCloseTo(0.78);
    expect(result.reasoning).toBe("broad browse");
  });

  it("extracts JSON from LLM output that has prose around it", async () => {
    const classifier = new IntentClassifier(
      makeRouter({
        text: 'Sure! Here is the classification: {"intent": "associative", "confidence": 0.72}\nHope that helps.',
      }),
    );
    const result = await classifier.classify("deep learning architectures");
    expect(result.intent).toBe<QueryIntent>("associative");
  });

  it("keyword-scans when JSON is malformed", async () => {
    const classifier = new IntentClassifier(
      makeRouter({ text: "I think this is exact_recall, confidence is moderate." }),
    );
    const result = await classifier.classify("deep learning architectures");
    expect(result.intent).toBe<QueryIntent>("exact_recall");
  });

  it("returns rule-based fallback when provider has no chat capability", async () => {
    const classifier = new IntentClassifier(makeRouter("no-chat"));
    const result = await classifier.classify("deep learning architectures");
    // Falls back to rule-based default — topical / 0.6.
    expect(result.intent).toBe<QueryIntent>("topical");
  });
});

describe("IntentClassifier — caching", () => {
  it("returns the same cached object for the same query", async () => {
    const classifier = new IntentClassifier(makeRouter("throws"));
    const a = await classifier.classify("What is CRDT?");
    const b = await classifier.classify("What is CRDT?");
    expect(a).toEqual(b);
  });

  it("clearCache forces re-classification", async () => {
    const classifier = new IntentClassifier(makeRouter("throws"));
    await classifier.classify("What is CRDT?");
    classifier.clearCache();
    const result = await classifier.classify("What is CRDT?");
    expect(result.intent).toBe<QueryIntent>("question");
  });
});
