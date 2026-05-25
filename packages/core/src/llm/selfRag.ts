import type { LlmRouter } from "./router.js";
import type { ChatMessage } from "./types.js";

/**
 * Self-RAG-style Reflection (prompt-level, no fine-tuning).
 *
 * Inspired by Asai et al. (ICLR 2024) — but instead of training reflection
 * tokens (`[Retrieve]`, `[IsRel]`, `[IsSup]`, `[IsUse]`), we emulate the same
 * behavior at the PROMPT level:
 *
 *   1. After each retrieve+generate step, ask the LLM to self-critique:
 *      "Is the answer complete? Should we retrieve more? With what query?"
 *      → `reflect()` returns a `ReflectionDecision`. The caller decides
 *        whether to loop another retrieval hop (cap at 3 in practice).
 *
 *   2. Pre-generation per-chunk relevance critique: each retrieved chunk
 *      is scored individually for "isRelevant" + "supportsAnswer", so the
 *      caller can filter low-signal chunks before stuffing them into the
 *      generation prompt.
 *
 * Both methods are fail-safe: any LLM/network/parse error degrades to an
 * accept-and-continue default. The reasoning is that retrieval is already
 * the user's intent — refusing to return results because the reflector
 * crashed would be a worse user experience than passing through unfiltered
 * results. See the route handler for the exposed HTTP surface.
 */

/**
 * The reflector's verdict on whether another retrieval hop is warranted.
 *
 * @property needMoreRetrieval - true → caller should issue another hop with `refinedQuery`.
 * @property refinedQuery      - present iff `needMoreRetrieval`. The next query to run.
 * @property confidence        - 0..1, the LLM's own confidence that the answer is complete.
 * @property missingInfo       - optional human-readable gap description.
 * @property reasoning         - optional one-sentence rationale (for trace logs).
 */
export interface ReflectionDecision {
  needMoreRetrieval: boolean;
  refinedQuery?: string;
  confidence: number;
  missingInfo?: string;
  reasoning?: string;
}

/**
 * Per-chunk critique. Designed to be cheap (small completion budget) so it
 * can be issued for every retrieved chunk in parallel.
 */
export interface ChunkRelevance {
  chunkId: string;
  isRelevant: boolean;
  supportsAnswer: boolean;
  reasoning: string;
}

const REFLECTION_PROMPT = `You have generated an answer to the user's query based on retrieved context.
Now reflect critically:

User Query: {{QUERY}}
Your Answer: {{ANSWER}}
Context chunks used: {{CHUNK_COUNT}}

Should we retrieve more information to improve the answer?
Respond with EXACTLY this JSON:
{
  "needMoreRetrieval": <true|false>,
  "refinedQuery": "<more specific follow-up query if needed, else null>",
  "confidence": <0..1>,
  "missingInfo": "<what's missing, or null>",
  "reasoning": "<one sentence>"
}`;

const CHUNK_CRITIQUE_PROMPT = `Evaluate whether the following chunk is relevant + supportive for answering the user's query.

User Query: {{QUERY}}

Chunk content:
"""
{{CHUNK}}
"""

Respond with EXACTLY this JSON:
{
  "isRelevant": <true|false>,
  "supportsAnswer": <true|false>,
  "reasoning": "<one sentence>"
}`;

/**
 * Max characters of chunk text passed into the critique prompt. Bounds LLM
 * cost — chunks longer than this are truncated.
 */
const CHUNK_TEXT_LIMIT = 2000;

export class SelfRagReflector {
  constructor(private router: LlmRouter) {}

  /**
   * After retrieval+generation, decide whether to loop another retrieval-hop.
   *
   * Fail-safe contract: any error (LLM offline, parse failure) returns
   * `{ needMoreRetrieval: false, confidence: 0.5 }` — i.e. trust the current
   * answer rather than loop forever or block the caller.
   */
  async reflect(
    query: string,
    answer: string,
    chunkCount: number,
  ): Promise<ReflectionDecision> {
    let provider;
    try {
      provider = this.router.getProvider("self-rag");
    } catch {
      return {
        needMoreRetrieval: false,
        confidence: 0.5,
        reasoning: "self-rag-provider-unavailable",
      };
    }
    if (!provider.chat) {
      return {
        needMoreRetrieval: false,
        confidence: 0.5,
        reasoning: "self-rag-provider-no-chat",
      };
    }

    const prompt = REFLECTION_PROMPT
      .replace("{{QUERY}}", query)
      .replace("{{ANSWER}}", answer)
      .replace("{{CHUNK_COUNT}}", String(chunkCount));

    try {
      const messages: ChatMessage[] = [{ role: "user", content: prompt }];
      const result = await provider.chat(messages, {
        maxTokens: 250,
        temperature: 0.1,
      });
      return this.parseReflection(result.text);
    } catch {
      // Failsafe: assume the current answer stands rather than spin on a broken LLM.
      return {
        needMoreRetrieval: false,
        confidence: 0.5,
        reasoning: "reflection-failed-fallback",
      };
    }
  }

  /**
   * Critique a single chunk's relevance + supportiveness for the query.
   *
   * Fail-safe contract: any error returns `{ isRelevant: true, supportsAnswer: true }`
   * — i.e. accept the chunk by default. Rationale: a broken critique
   * should NOT silently strip retrieval results; better to pass through and
   * let downstream ranking decide.
   */
  async critiqueChunk(
    query: string,
    chunkId: string,
    chunkText: string,
  ): Promise<ChunkRelevance> {
    let provider;
    try {
      provider = this.router.getProvider("self-rag");
    } catch {
      return {
        chunkId,
        isRelevant: true,
        supportsAnswer: true,
        reasoning: "self-rag-provider-unavailable-accept",
      };
    }
    if (!provider.chat) {
      return {
        chunkId,
        isRelevant: true,
        supportsAnswer: true,
        reasoning: "self-rag-provider-no-chat-accept",
      };
    }

    const prompt = CHUNK_CRITIQUE_PROMPT
      .replace("{{QUERY}}", query)
      .replace("{{CHUNK}}", chunkText.slice(0, CHUNK_TEXT_LIMIT));

    try {
      const messages: ChatMessage[] = [{ role: "user", content: prompt }];
      const result = await provider.chat(messages, {
        maxTokens: 150,
        temperature: 0.1,
      });
      return this.parseCritique(chunkId, result.text);
    } catch {
      return {
        chunkId,
        isRelevant: true,
        supportsAnswer: true,
        reasoning: "critique-failed-fallback-accept",
      };
    }
  }

  /**
   * Batch-critique many chunks in parallel.
   *
   * Note on rate-limits: every chunk fires its own provider.chat() concurrently.
   * Per-provider rate-limit handling lives at the provider layer (registry +
   * provider implementations), and individual failures degrade to accept-by-
   * default via `critiqueChunk`, so a partial outage cannot cascade into a
   * full failure of the batch.
   */
  async critiqueChunks(
    query: string,
    chunks: Array<{ id: string; text: string }>,
  ): Promise<ChunkRelevance[]> {
    return await Promise.all(
      chunks.map((c) => this.critiqueChunk(query, c.id, c.text)),
    );
  }

  // ─── parsing ─────────────────────────────────────────────────────────

  private parseReflection(text: string): ReflectionDecision {
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]) as Partial<{
          needMoreRetrieval: boolean;
          refinedQuery: string | null;
          confidence: number;
          missingInfo: string | null;
          reasoning: string;
        }>;
        return {
          needMoreRetrieval: Boolean(parsed.needMoreRetrieval),
          refinedQuery:
            typeof parsed.refinedQuery === "string" && parsed.refinedQuery.length > 0
              ? parsed.refinedQuery
              : undefined,
          confidence:
            typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
          missingInfo:
            typeof parsed.missingInfo === "string" && parsed.missingInfo.length > 0
              ? parsed.missingInfo
              : undefined,
          reasoning: parsed.reasoning,
        };
      }
    } catch {
      /* fall through to keyword fallback */
    }

    // Keyword fallback for malformed LLM output.
    const lower = text.toLowerCase();
    const needMore =
      /need.*more|incomplete|missing/i.test(lower) &&
      !/don't need|sufficient|complete/i.test(lower);
    return {
      needMoreRetrieval: needMore,
      confidence: 0.3,
      reasoning: "parsed-by-keyword",
    };
  }

  private parseCritique(chunkId: string, text: string): ChunkRelevance {
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]) as Partial<{
          isRelevant: boolean;
          supportsAnswer: boolean;
          reasoning: string;
        }>;
        return {
          chunkId,
          isRelevant: Boolean(parsed.isRelevant),
          supportsAnswer: Boolean(parsed.supportsAnswer),
          reasoning:
            typeof parsed.reasoning === "string" ? parsed.reasoning : "no-reasoning",
        };
      }
    } catch {
      /* fall through to accept */
    }
    return {
      chunkId,
      isRelevant: true,
      supportsAnswer: true,
      reasoning: "parse-failed-accept",
    };
  }
}
