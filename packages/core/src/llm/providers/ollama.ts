import type {
  LlmProvider,
  ProviderInfo,
  ChatMessage,
  ChatOpts,
  ChatResult,
  EmbedOpts,
  EmbedResult,
  TestConnectionResult,
  ToolCall,
} from "../types.js";
import { LlmUnavailable, LlmError } from "../errors.js";

/**
 * Configuration options for the Ollama provider.
 *
 * Ollama is a local LLM runtime exposing a REST API on (by default)
 * http://localhost:11434. Because it runs on-host, `isLocal` is true and
 * the router may pick this provider for privacy-tier `always_local`.
 */
export interface OllamaProviderOptions {
  /** Base URL of the Ollama server. Defaults to `http://localhost:11434`. */
  baseUrl?: string;
  /** Default chat model when `ChatOpts.model` is omitted. */
  defaultChatModel?: string;
  /** Default embedding model when `EmbedOpts.model` is omitted. */
  defaultEmbedModel?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: Record<string, unknown> | string;
      };
    }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
  done?: boolean;
  done_reason?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

/**
 * A single progress record streamed by Ollama's `POST /api/pull` (NDJSON).
 *
 * Ollama emits a sequence like:
 *   { status: "pulling manifest" }
 *   { status: "pulling <digest>", digest, total, completed }   ← many, growing `completed`
 *   { status: "verifying sha256 digest" }
 *   { status: "success" }
 * On failure a single `{ error: "<message>" }` record is emitted instead.
 */
export interface OllamaPullProgress {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

interface OllamaEmbedBatchResponse {
  embeddings?: number[][];
}

interface OllamaEmbedSingleResponse {
  embedding?: number[];
}

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_CHAT_MODEL = "llama3.1:8b";
export const OLLAMA_DEFAULT_EMBED_MODEL = "nomic-embed-text";

const DEFAULT_BASE_URL = OLLAMA_DEFAULT_BASE_URL;
const DEFAULT_CHAT_MODEL = OLLAMA_DEFAULT_CHAT_MODEL;
const DEFAULT_EMBED_MODEL = OLLAMA_DEFAULT_EMBED_MODEL;
const DEFAULT_TIMEOUT_MS = 60_000;

export class OllamaProvider implements LlmProvider {
  public readonly info: ProviderInfo;

  private readonly baseUrl: string;
  private readonly defaultChatModel: string;
  private readonly defaultEmbedModel: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultChatModel = opts.defaultChatModel ?? DEFAULT_CHAT_MODEL;
    this.defaultEmbedModel = opts.defaultEmbedModel ?? DEFAULT_EMBED_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.info = {
      name: "ollama",
      baseUrl: this.baseUrl,
      defaultModel: this.defaultChatModel,
      capabilities: {
        chat: true,
        embed: true,
        rerank: false,
        stream: true,
        toolCalling: true,
      },
      isLocal: true,
    };
  }

  /**
   * Issue an HTTP request to Ollama with a shared timeout + error envelope.
   * Network failures (DNS, ECONNREFUSED, AbortError) become LlmUnavailable;
   * non-2xx responses become LlmError("PROVIDER_ERROR", ...).
   */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LlmUnavailable("ollama", msg);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // ignore body-read failure; status alone is enough
      }
      throw new LlmError(
        "PROVIDER_ERROR",
        `Ollama HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        "ollama",
      );
    }

    return (await res.json()) as T;
  }

  async chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<ChatResult> {
    const model = opts.model ?? this.defaultChatModel;

    // System prompt — Ollama accepts a `system`-role message inline.
    const finalMessages: ChatMessage[] = opts.systemPrompt
      ? [{ role: "system", content: opts.systemPrompt }, ...messages]
      : messages;

    const ollamaOptions: Record<string, unknown> = {};
    if (opts.temperature !== undefined) ollamaOptions.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) ollamaOptions.num_predict = opts.maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: finalMessages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    };
    if (Object.keys(ollamaOptions).length > 0) body.options = ollamaOptions;

    // Pass tool definitions through — supported by tool-calling models (llama3.1, etc.).
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    if (opts.extra) Object.assign(body, opts.extra);

    const data = await this.request<OllamaChatResponse>("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const text = data.message?.content ?? "";

    // Surface tool_calls if the model emitted any.
    let toolCalls: ToolCall[] | undefined;
    const rawCalls = data.message?.tool_calls;
    if (Array.isArray(rawCalls) && rawCalls.length > 0) {
      toolCalls = rawCalls
        .map((c): ToolCall | null => {
          const name = c.function?.name;
          if (!name) return null;
          const rawArgs = c.function?.arguments;
          let input: Record<string, unknown> = {};
          if (rawArgs && typeof rawArgs === "object") {
            input = rawArgs as Record<string, unknown>;
          } else if (typeof rawArgs === "string") {
            try {
              input = JSON.parse(rawArgs) as Record<string, unknown>;
            } catch {
              input = { _raw: rawArgs };
            }
          }
          return { name, input };
        })
        .filter((c): c is ToolCall => c !== null);
      if (toolCalls.length === 0) toolCalls = undefined;
    }

    let finishReason: ChatResult["finishReason"];
    if (toolCalls && toolCalls.length > 0) {
      finishReason = "tool_use";
    } else if (data.done_reason === "length") {
      finishReason = "length";
    } else {
      // "stop", undefined, or anything else → treat as a normal stop.
      finishReason = "stop";
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      model,
      finishReason,
    };
  }

  async embeddings(texts: string[], opts: EmbedOpts = {}): Promise<EmbedResult> {
    const model = opts.model ?? this.defaultEmbedModel;

    if (texts.length === 0) {
      return {
        vectors: [],
        model,
        dimensions: 0,
        usage: { inputTokens: 0 },
      };
    }

    // Prefer the batch endpoint `/api/embed` (input: string[]) introduced in
    // Ollama 0.2+. Fall back to per-text `/api/embeddings` if the server
    // returns 404 / shape doesn't match.
    let vectors: number[][] | null = null;

    try {
      const batch = await this.request<OllamaEmbedBatchResponse>("/api/embed", {
        method: "POST",
        body: JSON.stringify({ model, input: texts }),
      });
      if (
        Array.isArray(batch.embeddings) &&
        batch.embeddings.length === texts.length &&
        Array.isArray(batch.embeddings[0])
      ) {
        vectors = batch.embeddings;
      }
    } catch (err) {
      // Only swallow PROVIDER_ERROR (likely 404 on older Ollama). Connection
      // failures must propagate so the caller sees LlmUnavailable.
      if (!(err instanceof LlmError) || err instanceof LlmUnavailable) throw err;
      vectors = null;
    }

    if (vectors === null) {
      const collected: number[][] = [];
      for (const text of texts) {
        const single = await this.request<OllamaEmbedSingleResponse>("/api/embeddings", {
          method: "POST",
          body: JSON.stringify({ model, prompt: text }),
        });
        if (!Array.isArray(single.embedding)) {
          throw new LlmError(
            "PROVIDER_ERROR",
            "Ollama returned no embedding array",
            "ollama",
          );
        }
        collected.push(single.embedding);
      }
      vectors = collected;
    }

    const dimensions = vectors[0]?.length ?? 0;
    const approxInputTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);

    return {
      vectors,
      model,
      dimensions,
      usage: { inputTokens: approxInputTokens },
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const data = await this.request<OllamaTagsResponse>("/api/tags", { method: "GET" });
      const modelsAvailable = Array.isArray(data.models)
        ? data.models.map((m) => m.name).filter((n): n is string => typeof n === "string")
        : [];
      return {
        ok: true,
        latencyMs: Date.now() - start,
        modelsAvailable,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /**
   * List the model names currently installed in this Ollama server (via
   * `/api/tags`). Names carry their tag, e.g. `llama3.1:8b`,
   * `nomic-embed-text:latest`. Network/HTTP failures surface as
   * `LlmUnavailable` / `LlmError` (same envelope as every other call).
   */
  async listModelNames(): Promise<string[]> {
    const data = await this.request<OllamaTagsResponse>("/api/tags", { method: "GET" });
    return Array.isArray(data.models)
      ? data.models.map((m) => m.name).filter((n): n is string => typeof n === "string")
      : [];
  }

  /**
   * Pull a model into this Ollama server, streaming progress.
   *
   * Wraps `POST /api/pull` (NDJSON stream). `onProgress` fires for every
   * record Ollama emits — the caller decides how to surface it (SSE, log, …).
   * Resolves once the stream ends cleanly; rejects with `LlmError` if Ollama
   * reports an `error` record or a non-2xx status, and with `LlmUnavailable`
   * if the server can't be reached.
   *
   * Deliberately NOT bounded by `timeoutMs`: a multi-GB pull legitimately runs
   * for minutes. Pass a `signal` to abort (e.g. client disconnect).
   */
  async pullModel(
    model: string,
    onProgress: (p: OllamaPullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LlmUnavailable("ollama", msg);
    }

    if (!res.ok || !res.body) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // status alone is enough
      }
      throw new LlmError(
        "PROVIDER_ERROR",
        `Ollama pull HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        "ollama",
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let record: OllamaPullProgress;
      try {
        record = JSON.parse(trimmed) as OllamaPullProgress;
      } catch {
        return; // ignore a malformed partial line
      }
      if (record.error) {
        throw new LlmError("PROVIDER_ERROR", record.error, "ollama");
      }
      onProgress(record);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    }
    // Flush any trailing record without a newline terminator.
    handleLine(buffer);
  }
}
