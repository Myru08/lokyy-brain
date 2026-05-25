import type {
  LlmProvider,
  ProviderInfo,
  RerankOpts,
  RerankResult,
  TestConnectionResult,
  ChatMessage,
} from "../types.js";
import { LlmError } from "../errors.js";
import { OllamaProvider } from "./ollama.js";

/**
 * Local reranker.
 *
 * Cross-Encoder Modelle (bge-reranker-v2-m3 et al.) sind in Node ohne
 * native dependencies schwer einzubinden — eine spätere Story kann sie via
 * transformers.js oder einem dedizierten Sidecar nachreichen. Für Wave B2
 * bauen wir einen pragmatischen Fallback: LLM-as-judge über Ollama.
 *
 * Vorgehen:
 *  - Pro Dokument fragen wir das lokale Modell um einen Relevanz-Score 0–10.
 *  - Score-Parsing ist tolerant (erste Zahl im Output zählt).
 *  - Parallelität ist auf `maxConcurrency` begrenzt (Default 5) — sonst legt
 *    ein Reranker-Call mit Top-25 Ollama lokal lahm.
 *  - Qualität liegt deutlich unter Cohere Rerank-3, deckt aber den Use-Case
 *    "kein Cloud, kein Budget" ab.
 *
 * Privacy-Tier: `isLocal: true` — wird vom Router auch bei `always_local`
 * für die `rerank`-Rolle gewählt.
 */
export interface LocalRerankerOptions {
  /** Ollama base URL (default `http://localhost:11434`). */
  baseUrl?: string;
  /** Judge-Modell (default `llama3.1:8b`). */
  judgeModel?: string;
  /** Max concurrent judge-calls (default 5). */
  maxConcurrency?: number;
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number;
}

const DEFAULT_JUDGE_MODEL = "llama3.1:8b";
const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DOC_CHARS = 4_000;

const JUDGE_SYSTEM =
  "You are a precise relevance grader. " +
  "Given a query and a document, output ONLY a single integer from 0 to 10 " +
  "indicating how well the document answers the query. " +
  "0 = totally unrelated, 10 = perfectly answers it. " +
  "No words, no punctuation, no explanation — just the digit(s).";

const JUDGE_USER_TEMPLATE = (query: string, doc: string): string =>
  `Query: ${query}\n\nDocument:\n${doc.slice(0, MAX_DOC_CHARS)}\n\nScore (0-10):`;

/**
 * Parse the first integer found in `text`, clamp to [0, 10]. Returns `null`
 * if nothing parseable was emitted — caller falls back to a neutral score.
 */
function parseScore(text: string): number | null {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return null;
  return Math.min(10, Math.max(0, n));
}

/**
 * Bounded-concurrency map. Runs `fn` over `items` with at most `limit`
 * in-flight promises. Result ordering matches input ordering.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx] as T, idx);
    }
  };

  const workers: Promise<void>[] = [];
  const n = Math.min(Math.max(1, limit), items.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export class LocalReranker implements LlmProvider {
  public readonly info: ProviderInfo;

  private readonly ollama: OllamaProvider;
  private readonly judgeModel: string;
  private readonly maxConcurrency: number;

  constructor(opts: LocalRerankerOptions = {}) {
    this.judgeModel = opts.judgeModel ?? DEFAULT_JUDGE_MODEL;
    this.maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.ollama = new OllamaProvider({
      baseUrl: opts.baseUrl,
      defaultChatModel: this.judgeModel,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    this.info = {
      name: "local-reranker",
      baseUrl: this.ollama.info.baseUrl,
      defaultModel: this.judgeModel,
      capabilities: {
        chat: false,
        embed: false,
        rerank: true,
        stream: false,
        toolCalling: false,
      },
      isLocal: true,
    };
  }

  async rerank(
    query: string,
    documents: string[],
    opts: RerankOpts = {},
  ): Promise<RerankResult> {
    const model = opts.model ?? this.judgeModel;
    const topN = opts.topN ?? documents.length;

    if (documents.length === 0) {
      return { rankings: [], model };
    }

    const judge = async (doc: string): Promise<number> => {
      if (!this.ollama.chat) {
        throw new LlmError(
          "CAPABILITY_MISSING",
          "underlying ollama provider has no chat capability",
          "local-reranker",
        );
      }
      const messages: ChatMessage[] = [
        { role: "user", content: JUDGE_USER_TEMPLATE(query, doc) },
      ];
      const result = await this.ollama.chat(messages, {
        model,
        systemPrompt: JUDGE_SYSTEM,
        temperature: 0,
        maxTokens: 8,
      });
      const parsed = parseScore(result.text);
      // Neutral fallback (5/10) when the judge emits gibberish — safer than
      // dropping the doc entirely. Normalize to [0, 1] for the result.
      return (parsed ?? 5) / 10;
    };

    const scores = await mapWithConcurrency(
      documents,
      this.maxConcurrency,
      async (doc) => judge(doc),
    );

    const indexed = scores.map((score, index) => ({ index, score }));
    indexed.sort((a, b) => b.score - a.score);
    const rankings = indexed.slice(0, topN);

    // Token usage isn't tracked here — Ollama responses include prompt_eval +
    // eval counts per call, but we'd need to plumb them through. Skip for
    // Wave B2; sleep-agent / budget can hook in later if needed.
    return { rankings, model };
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const probe = await this.ollama.testConnection();
      if (!probe.ok) {
        return {
          ok: false,
          error: probe.error ?? "ollama unreachable",
        };
      }
      const hasModel = probe.modelsAvailable?.some((name) =>
        name === this.judgeModel || name.startsWith(`${this.judgeModel}:`),
      ) ?? false;
      if (!hasModel) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          error: `judge model ${this.judgeModel} not pulled in Ollama`,
          modelsAvailable: probe.modelsAvailable,
        };
      }
      return {
        ok: true,
        latencyMs: Date.now() - start,
        modelsAvailable: probe.modelsAvailable,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }
}

// Re-export internal helper so tests in a sibling story can exercise it
// without re-implementing parsing logic.
export { parseScore as _parseLocalRerankScore };
