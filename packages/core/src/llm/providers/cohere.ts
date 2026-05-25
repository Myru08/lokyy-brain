import type {
  LlmProvider,
  ProviderInfo,
  RerankOpts,
  RerankResult,
  TestConnectionResult,
} from "../types.js";
import {
  LlmAuthError,
  LlmRateLimited,
  LlmUnavailable,
  LlmError,
} from "../errors.js";

/**
 * Configuration options for the Cohere provider.
 *
 * Cohere offers a hosted Rerank API (cross-encoder, hochqualitativ) used as
 * the second retrieval stage in lokyy-brain after Hybrid (BM25 + Dense + RRF).
 * The provider only exposes `rerank` capability — chat/embed are intentionally
 * unsupported, so the router will only ever pick it for the `rerank` role.
 *
 * Pricing reference (May 2026): rerank-3.5 ≈ $2 / 1000 searches.
 */
export interface CohereProviderOptions {
  /** Cohere API key (required). */
  apiKey: string;
  /** Default rerank model (default `"rerank-3.5"`). */
  defaultRerankModel?: string;
  /** Override the API base (default `"https://api.cohere.com/v1"`). */
  baseUrl?: string;
  /** Request timeout in ms (default 30s). */
  timeoutMs?: number;
}

interface CohereRerankResponse {
  results: Array<{ index: number; relevance_score: number }>;
  meta?: {
    billed_units?: {
      input_tokens?: number;
      search_units?: number;
    };
  };
}

const DEFAULT_BASE_URL = "https://api.cohere.com/v1";
const DEFAULT_MODEL = "rerank-3.5";
const DEFAULT_TIMEOUT_MS = 30_000;

export class CohereProvider implements LlmProvider {
  public readonly info: ProviderInfo;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;

  constructor(opts: CohereProviderOptions) {
    if (!opts.apiKey) {
      throw new LlmError(
        "MISSING_API_KEY",
        "cohere requires apiKey",
        "cohere",
      );
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultModel = opts.defaultRerankModel ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.info = {
      name: "cohere",
      defaultModel: this.defaultModel,
      baseUrl: this.baseUrl,
      capabilities: {
        chat: false,
        embed: false,
        rerank: true,
        stream: false,
        toolCalling: false,
      },
      isLocal: false,
    };
  }

  async rerank(
    query: string,
    documents: string[],
    opts: RerankOpts = {},
  ): Promise<RerankResult> {
    const model = opts.model ?? this.defaultModel;
    const topN = opts.topN ?? documents.length;

    if (documents.length === 0) {
      return { rankings: [], model };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/rerank`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          query,
          documents,
          top_n: topN,
          return_documents: false,
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LlmUnavailable("cohere", msg);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new LlmAuthError("cohere");
    }
    if (res.status === 429) {
      throw new LlmRateLimited("cohere");
    }
    if (res.status >= 500) {
      throw new LlmUnavailable("cohere", `status ${res.status}`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // ignore body read failure
      }
      throw new LlmError(
        "PROVIDER_ERROR",
        `Cohere HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        "cohere",
      );
    }

    const data = (await res.json()) as CohereRerankResponse;
    const rankings = Array.isArray(data.results)
      ? data.results.map((r) => ({ index: r.index, score: r.relevance_score }))
      : [];

    const billed = data.meta?.billed_units;
    const usage = billed
      ? { inputTokens: billed.input_tokens ?? 0 }
      : undefined;

    return {
      rankings,
      model,
      usage,
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      await this.rerank("test query", ["test document"], { topN: 1 });
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }
}
