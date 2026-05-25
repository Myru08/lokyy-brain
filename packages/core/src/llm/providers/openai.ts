import OpenAI from "openai";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.js";
import type {
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
} from "openai/resources/embeddings.js";
import type { FunctionParameters } from "openai/resources/shared.js";

import {
  LlmAuthError,
  LlmError,
  LlmRateLimited,
  LlmUnavailable,
} from "../errors.js";
import type {
  ChatMessage,
  ChatOpts,
  ChatResult,
  EmbedOpts,
  EmbedResult,
  LlmProvider,
  ProviderInfo,
  TestConnectionResult,
  ToolCall,
} from "../types.js";

const PROVIDER_NAME = "openai";
const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

export interface OpenAIProviderOptions {
  apiKey: string;
  /** Default chat model when `ChatOpts.model` is omitted. Defaults to "gpt-4o-mini". */
  defaultChatModel?: string;
  /** Default embedding model when `EmbedOpts.model` is omitted. Defaults to "text-embedding-3-small". */
  defaultEmbedModel?: string;
  /** Optional API base URL override (for proxies). For OpenAI itself, leave undefined. */
  baseUrl?: string;
}

/**
 * OpenAI provider implementation of `LlmProvider`.
 *
 * Supports chat (with function/tool calling) and embeddings.
 * Rerank is intentionally omitted — OpenAI does not offer a dedicated rerank endpoint.
 */
export class OpenAIProvider implements LlmProvider {
  readonly info: ProviderInfo;
  private readonly client: OpenAI;
  private readonly defaultChatModel: string;
  private readonly defaultEmbedModel: string;

  constructor(opts: OpenAIProviderOptions) {
    this.defaultChatModel = opts.defaultChatModel ?? DEFAULT_CHAT_MODEL;
    this.defaultEmbedModel = opts.defaultEmbedModel ?? DEFAULT_EMBED_MODEL;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseUrl !== undefined ? { baseURL: opts.baseUrl } : {}),
    });
    this.info = {
      name: PROVIDER_NAME,
      defaultModel: this.defaultChatModel,
      capabilities: {
        chat: true,
        embed: true,
        rerank: false,
        stream: true,
        toolCalling: true,
      },
      isLocal: false,
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    };
  }

  async chat(messages: ChatMessage[], opts?: ChatOpts): Promise<ChatResult> {
    // Prepend the explicit systemPrompt (if any) as a system-role message.
    // Any inline `role: "system"` messages remain in-place — OpenAI accepts
    // multiple system entries and concatenates them implicitly.
    const explicitSystem = opts?.systemPrompt;
    const allMessages: ChatMessage[] =
      explicitSystem !== undefined && explicitSystem !== ""
        ? [{ role: "system", content: explicitSystem }, ...messages]
        : messages;

    const openaiMessages: ChatCompletionMessageParam[] = allMessages.map((m) => {
      if (m.role === "system") {
        return { role: "system", content: m.content };
      }
      if (m.role === "user") {
        return { role: "user", content: m.content };
      }
      return { role: "assistant", content: m.content };
    });

    const tools: ChatCompletionTool[] | undefined =
      opts?.tools && opts.tools.length > 0
        ? opts.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema as FunctionParameters,
            },
          }))
        : undefined;

    const model = opts?.model ?? this.defaultChatModel;

    const params: ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: openaiMessages,
      stream: false,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      ...(tools !== undefined ? { tools } : {}),
    };

    let response: ChatCompletion;
    try {
      response = await this.client.chat.completions.create(params);
    } catch (err) {
      throw this.mapError(err);
    }

    const choice = response.choices[0];
    if (!choice) {
      throw new LlmError(
        "PROVIDER_ERROR",
        "OpenAI returned no choices",
        PROVIDER_NAME,
      );
    }

    const text = choice.message.content ?? "";

    // Map OpenAI's tool_calls (function-calling format) → our ToolCall[].
    // Each entry has { id, type: "function", function: { name, arguments } }
    // where `arguments` is a JSON string. We parse it into a plain object.
    // Currently OpenAI only emits `type: "function"`; custom-tool variants exist
    // but are not supported by our `ToolCall` shape, so we skip them.
    let toolCalls: ToolCall[] | undefined;
    const rawCalls = choice.message.tool_calls;
    if (Array.isArray(rawCalls) && rawCalls.length > 0) {
      const mapped: ToolCall[] = [];
      for (const call of rawCalls) {
        const functionCall = toFunctionToolCall(call);
        if (functionCall === null) continue;
        const argString = functionCall.function.arguments;
        let input: Record<string, unknown> = {};
        if (argString && argString.length > 0) {
          try {
            const parsed = JSON.parse(argString) as unknown;
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
              input = parsed as Record<string, unknown>;
            } else {
              input = { _raw: argString };
            }
          } catch {
            input = { _raw: argString };
          }
        }
        mapped.push({ name: functionCall.function.name, input });
      }
      if (mapped.length > 0) toolCalls = mapped;
    }

    const usage = response.usage;
    const result: ChatResult = {
      text,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
      model: response.model,
      finishReason: mapFinishReason(choice.finish_reason),
    };
    if (toolCalls !== undefined) {
      result.toolCalls = toolCalls;
    }
    return result;
  }

  async embeddings(texts: string[], opts?: EmbedOpts): Promise<EmbedResult> {
    const model = opts?.model ?? this.defaultEmbedModel;

    if (texts.length === 0) {
      return {
        vectors: [],
        model,
        dimensions: 0,
        usage: { inputTokens: 0 },
      };
    }

    const params: EmbeddingCreateParams = {
      model,
      input: texts,
      ...(opts?.dimensions !== undefined ? { dimensions: opts.dimensions } : {}),
    };

    let response: CreateEmbeddingResponse;
    try {
      response = await this.client.embeddings.create(params);
    } catch (err) {
      throw this.mapError(err);
    }

    // Preserve the request order — OpenAI returns one Embedding per input with
    // an `index` field; we sort by it to be safe even though the API currently
    // returns them in order.
    const ordered = [...response.data].sort((a, b) => a.index - b.index);
    const vectors = ordered.map((e) => e.embedding);
    const dimensions = vectors[0]?.length ?? 0;

    return {
      vectors,
      model: response.model,
      dimensions,
      usage: { inputTokens: response.usage.prompt_tokens },
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      // Minimal embeddings call — single short input, smallest model the caller
      // configured. Cheaper and faster than a chat completion ping.
      const params: EmbeddingCreateParams = {
        model: this.defaultEmbedModel,
        input: "ping",
      };
      await this.client.embeddings.create(params);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  private mapError(err: unknown): LlmError {
    if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
      return new LlmAuthError(PROVIDER_NAME, err.message);
    }
    if (err instanceof RateLimitError) {
      return new LlmRateLimited(PROVIDER_NAME, err.message);
    }
    if (err instanceof APIConnectionError) {
      return new LlmUnavailable(PROVIDER_NAME, err.message);
    }
    if (err instanceof InternalServerError) {
      return new LlmUnavailable(PROVIDER_NAME, err.message);
    }
    if (err instanceof APIError) {
      const status = err.status;
      if (typeof status === "number") {
        if (status === 401 || status === 403) {
          return new LlmAuthError(PROVIDER_NAME, err.message);
        }
        if (status === 429) {
          return new LlmRateLimited(PROVIDER_NAME, err.message);
        }
        if (status >= 500) {
          return new LlmUnavailable(PROVIDER_NAME, err.message);
        }
      }
      return new LlmError("PROVIDER_ERROR", err.message, PROVIDER_NAME);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new LlmError("PROVIDER_ERROR", message, PROVIDER_NAME);
  }
}

/**
 * Narrow the ChatCompletionMessageToolCall union to the function-call variant.
 * OpenAI's API exposes function tool calls and custom tool calls; we only
 * surface function calls because our `ToolCall` shape carries a name + JSON input.
 */
function toFunctionToolCall(
  call: ChatCompletionMessageToolCall,
): { function: { name: string; arguments: string } } | null {
  if (call.type !== "function") return null;
  const fn = (call as { function?: { name?: string; arguments?: string } }).function;
  if (!fn || typeof fn.name !== "string") return null;
  return {
    function: {
      name: fn.name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : "",
    },
  };
}

function mapFinishReason(
  reason: ChatCompletion.Choice["finish_reason"] | null,
): ChatResult["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "error";
    case null:
      return "stop";
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return "error";
    }
  }
}
