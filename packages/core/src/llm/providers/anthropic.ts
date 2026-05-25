import Anthropic from "@anthropic-ai/sdk";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  StopReason,
  TextBlockParam,
  Tool,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

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
  LlmProvider,
  ProviderInfo,
  TestConnectionResult,
  ToolCall,
} from "../types.js";

const PROVIDER_NAME = "anthropic";
const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Default model used when `ChatOpts.model` is not set. Defaults to "claude-haiku-4-5". */
  defaultModel?: string;
  /** Optional API base URL override. */
  baseUrl?: string;
}

/**
 * Anthropic provider implementation of `LlmProvider`.
 *
 * Only supports chat (with optional tool calling). Embeddings and reranking
 * are intentionally omitted — Anthropic does not offer those endpoints.
 */
export class AnthropicProvider implements LlmProvider {
  readonly info: ProviderInfo;
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  constructor(opts: AnthropicProviderOptions) {
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseUrl !== undefined ? { baseURL: opts.baseUrl } : {}),
    });
    this.info = {
      name: PROVIDER_NAME,
      defaultModel: this.defaultModel,
      capabilities: {
        chat: true,
        embed: false,
        rerank: false,
        stream: true,
        toolCalling: true,
      },
      isLocal: false,
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    };
  }

  async chat(messages: ChatMessage[], opts?: ChatOpts): Promise<ChatResult> {
    // Extract system messages: Anthropic separates the system prompt
    // from the messages array. We concatenate any `role: "system"` entries
    // and let `opts.systemPrompt` take precedence (matches caller intent).
    const inlineSystems = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content);
    const explicitSystem = opts?.systemPrompt;
    const systemParts: string[] = [];
    if (explicitSystem !== undefined && explicitSystem !== "") {
      systemParts.push(explicitSystem);
    }
    systemParts.push(...inlineSystems);
    const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

    const anthropicMessages: MessageParam[] = messages
      .filter((m): m is ChatMessage & { role: "user" | "assistant" } =>
        m.role === "user" || m.role === "assistant",
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));

    const model = opts?.model ?? this.defaultModel;
    const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;

    const tools: Tool[] | undefined =
      opts?.tools && opts.tools.length > 0
        ? opts.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Tool["input_schema"],
          }))
        : undefined;

    const params: MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      ...(system !== undefined ? { system } : {}),
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(tools !== undefined ? { tools } : {}),
    };

    let response: Message;
    try {
      response = await this.client.messages.create(params);
    } catch (err) {
      throw this.mapError(err);
    }

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of response.content as ContentBlock[]) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        const toolUse = block as ToolUseBlock;
        toolCalls.push({
          name: toolUse.name,
          input: (toolUse.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    const result: ChatResult = {
      text: textParts.join(""),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
      finishReason: mapFinishReason(response.stop_reason),
    };
    if (toolCalls.length > 0) {
      result.toolCalls = toolCalls;
    }
    return result;
  }

  async testConnection(): Promise<TestConnectionResult> {
    const start = Date.now();
    try {
      const pingMessages: MessageParam[] = [
        { role: "user", content: "ping" },
      ];
      const params: MessageCreateParamsNonStreaming = {
        model: this.defaultModel,
        max_tokens: 1,
        messages: pingMessages,
      };
      await this.client.messages.create(params);
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

function mapFinishReason(
  stopReason: StopReason | null,
): ChatResult["finishReason"] {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "error";
    case "pause_turn":
      return "stop";
    case null:
      return "stop";
    default: {
      // Exhaustive — any new StopReason value falls through here.
      const _exhaustive: never = stopReason;
      void _exhaustive;
      return "error";
    }
  }
}

// Silence unused-import warnings for type-only helpers kept for clarity.
export type { TextBlockParam };
