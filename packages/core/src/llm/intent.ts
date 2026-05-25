import type { LlmRouter } from "./router.js";
import type { ChatMessage } from "./types.js";

/**
 * Pre-retrieval query intent classification.
 *
 * Routing hints derived from the intent:
 *   - exact_recall  → BM25-only, α=1.0 (sparse-heavy)
 *   - topical       → dense-heavy, α=0.2
 *   - associative   → graph-walk + dense
 *   - question      → RAG-Fusion + hybrid + LLM-generate
 *
 * The classifier uses a two-stage strategy:
 *   1. Cheap deterministic rule-based fast-path (no network call). If the
 *      confidence is ≥ FAST_PATH_THRESHOLD we return immediately.
 *   2. LLM fallback via the `intent-classifier` role (e.g. Llama 3.1 8B or
 *      Haiku). On error we degrade to the rule-based result so the pipeline
 *      always returns a sane intent.
 *
 * Results are cached per query for `TTL_MS` (5 minutes) — queries are very
 * stable within a single session and the user often re-runs the same query.
 */

export type QueryIntent =
  | "exact_recall"
  | "topical"
  | "associative"
  | "question";

export interface IntentResult {
  intent: QueryIntent;
  /** 0..1 — how confident the classifier is. Rule-based hits use fixed values. */
  confidence: number;
  /** Optional human-readable explanation. Useful for debugging routing decisions. */
  reasoning?: string;
}

const PROMPT = `Classify the following user query into ONE of these 4 categories:

1. exact_recall — User looks for a specific note they wrote. Hints: "the note where I…", "what I wrote about…", specific names/dates/IDs.
2. topical — User browses a topic broadly. Hints: "notes about X", "all my projects on Y", abstract terms.
3. associative — User wants connections to a concept. Hints: "things related to…", "what's connected to…", vague memory cues.
4. question — User asks for a synthesized answer. Hints: starts with "what", "how", "why", "when", question marks.

Respond with EXACTLY this JSON:
{"intent": "<category>", "confidence": <0..1>, "reasoning": "<short>"}

Query: "{{QUERY}}"`;

const VALID_INTENTS: readonly QueryIntent[] = [
  "exact_recall",
  "topical",
  "associative",
  "question",
];

/**
 * Confidence threshold above which the rule-based fast-path bypasses the LLM.
 * Tuned so only HIGH-signal patterns (wh-words, explicit recall phrases,
 * relational markers) short-circuit; ambiguous queries fall through to the LLM.
 */
const FAST_PATH_THRESHOLD = 0.85;

export class IntentClassifier {
  private cache = new Map<string, { result: IntentResult; expiresAt: number }>();
  private readonly TTL_MS = 5 * 60 * 1000;
  private readonly MAX_ENTRIES = 1000;

  constructor(private router: LlmRouter) {}

  async classify(query: string): Promise<IntentResult> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return { intent: "topical", confidence: 0.5, reasoning: "empty query" };
    }

    const cached = this.fromCache(trimmed);
    if (cached) return cached;

    // 1. Rule-based fast-path — saves a network call for the most common queries.
    const ruleBased = this.ruleBasedClassify(trimmed);
    if (ruleBased.confidence >= FAST_PATH_THRESHOLD) {
      this.cacheSet(trimmed, ruleBased);
      return ruleBased;
    }

    // 2. LLM fallback. On any failure we fall back to the rule-based result
    // (which always returns at least the low-confidence "topical" default).
    try {
      const provider = this.router.getProvider("intent-classifier");
      if (!provider.chat) {
        throw new Error("intent-classifier provider has no chat capability");
      }
      const prompt = PROMPT.replace("{{QUERY}}", trimmed);
      const messages: ChatMessage[] = [{ role: "user", content: prompt }];
      const result = await provider.chat(messages, {
        maxTokens: 100,
        temperature: 0.1,
      });
      const parsed = this.parseResponse(result.text);
      this.cacheSet(trimmed, parsed);
      return parsed;
    } catch {
      this.cacheSet(trimmed, ruleBased);
      return ruleBased;
    }
  }

  /** Cheap rule-based classifier for fast-path + LLM-failure-fallback. */
  private ruleBasedClassify(query: string): IntentResult {
    const lower = query.toLowerCase();

    // Question — direct heuristics (English + German wh-words, trailing `?`).
    if (
      lower.endsWith("?") ||
      /^(what|how|why|when|where|who|wie|was|warum|wann|wo|wer)\b/i.test(lower)
    ) {
      return {
        intent: "question",
        confidence: 0.9,
        reasoning: "starts with wh-word or ends in ?",
      };
    }

    // Exact recall — concrete recall phrasing.
    if (
      /\b(the note where i|where i wrote|did i write|note about my|my note on)\b/i.test(
        lower,
      )
    ) {
      return {
        intent: "exact_recall",
        confidence: 0.9,
        reasoning: "explicit recall phrasing",
      };
    }

    // Associative — relational markers.
    if (
      /\b(related to|connected to|similar to|reminds me|in the context of)\b/i.test(
        lower,
      )
    ) {
      return {
        intent: "associative",
        confidence: 0.85,
        reasoning: "association phrasing",
      };
    }

    // Default: topical — broad-browse intent, low confidence so the LLM still gets a shot.
    return {
      intent: "topical",
      confidence: 0.6,
      reasoning: "no strong signal — default topical",
    };
  }

  private parseResponse(text: string): IntentResult {
    // Try JSON-parse first — extract first {...} block (the LLM might prepend prose).
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]) as Partial<IntentResult>;
        if (parsed.intent && this.isValid(parsed.intent)) {
          return {
            intent: parsed.intent,
            confidence:
              typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
            reasoning: parsed.reasoning,
          };
        }
      }
    } catch {
      /* fall through to keyword scan */
    }

    // Keyword-scan fallback for malformed LLM output.
    const lower = text.toLowerCase();
    if (lower.includes("exact_recall")) {
      return { intent: "exact_recall", confidence: 0.5 };
    }
    if (lower.includes("associative")) {
      return { intent: "associative", confidence: 0.5 };
    }
    if (lower.includes("question")) {
      return { intent: "question", confidence: 0.5 };
    }
    if (lower.includes("topical")) {
      return { intent: "topical", confidence: 0.5 };
    }
    return { intent: "topical", confidence: 0.3 };
  }

  private isValid(intent: string): intent is QueryIntent {
    return (VALID_INTENTS as readonly string[]).includes(intent);
  }

  private fromCache(query: string): IntentResult | null {
    const e = this.cache.get(query);
    if (!e) return null;
    if (e.expiresAt < Date.now()) {
      this.cache.delete(query);
      return null;
    }
    return e.result;
  }

  private cacheSet(query: string, result: IntentResult): void {
    this.cache.set(query, { result, expiresAt: Date.now() + this.TTL_MS });
    // Simple FIFO eviction — Map preserves insertion order in JS.
    if (this.cache.size > this.MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
