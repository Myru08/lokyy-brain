import OpenAI, {
  APIError,
  AuthenticationError,
  RateLimitError,
  APIConnectionError,
  InternalServerError,
} from "openai";
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
import {
  LlmAuthError,
  LlmRateLimited,
  LlmUnavailable,
  LlmError,
  LlmCapabilityMissing,
} from "../errors.js";

export type OpenAICompatPreset =
  | "openrouter"
  | "eurouter"
  | "cortex"
  | "groq"
  | "together"
  | "lm-studio"
  | "vllm"
  | "custom";

export interface PresetConfig {
  name: OpenAICompatPreset;
  label: string;
  baseUrl: string;
  defaultChatModel: string;
  defaultEmbedModel?: string;
  supportsEmbed: boolean;
  isLocal: boolean;
  apiKeyRequired: boolean;
}

export const OPENAI_COMPAT_PRESETS: Record<OpenAICompatPreset, PresetConfig> = {
  openrouter: {
    name: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultChatModel: "anthropic/claude-haiku-4-5",
    supportsEmbed: false,
    isLocal: false,
    apiKeyRequired: true,
  },
  eurouter: {
    name: "eurouter",
    label: "eurouter.ai (EU sovereign)",
    baseUrl: "https://api.eurouter.ai/v1",
    defaultChatModel: "mistral-large",
    supportsEmbed: false,
    isLocal: false,
    apiKeyRequired: true,
  },
  cortex: {
    name: "cortex",
    label: "Cortex.so (local)",
    baseUrl: "http://localhost:39281/v1",
    defaultChatModel: "llama3.1:8b-instruct",
    defaultEmbedModel: "nomic-embed-text",
    supportsEmbed: true,
    isLocal: true,
    apiKeyRequired: false,
  },
  groq: {
    name: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultChatModel: "llama-3.1-70b-versatile",
    supportsEmbed: false,
    isLocal: false,
    apiKeyRequired: true,
  },
  together: {
    name: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultChatModel: "meta-llama/Llama-3.1-70B-Instruct-Turbo",
    defaultEmbedModel: "BAAI/bge-large-en-v1.5",
    supportsEmbed: true,
    isLocal: false,
    apiKeyRequired: true,
  },
  "lm-studio": {
    name: "lm-studio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    defaultChatModel: "local-model",
    supportsEmbed: true,
    isLocal: true,
    apiKeyRequired: false,
  },
  vllm: {
    name: "vllm",
    label: "vLLM (self-hosted)",
    baseUrl: "http://localhost:8000/v1",
    defaultChatModel: "local-model",
    supportsEmbed: true,
    isLocal: true,
    apiKeyRequired: false,
  },
  custom: {
    name: "custom",
    label: "Custom OpenAI-compatible endpoint",
    baseUrl: "",
    defaultChatModel: "",
    supportsEmbed: false,
    isLocal: false,
    apiKeyRequired: false,
  },
};

export interface OpenAICompatProviderOptions {
  preset: OpenAICompatPreset;
  apiKey?: string;
  baseUrl?: string;
  defaultChatModel?: string;
  defaultEmbedModel?: string;
  isLocalOverride?: boolean;
}

const PROVIDER_NAME = "openai-compat";

interface ChatCompletionRequestMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatToolParam {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatRequestBody {
  model: string;
  messages: ChatCompletionRequestMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: ChatToolParam[];
  stream?: false;
}

function mapOpenAIError(err: unknown): LlmError {
  if (err instanceof AuthenticationError) {
    return new LlmAuthError(PROVIDER_NAME, err.message);
  }
  if (err instanceof RateLimitError) {
    return new LlmRateLimited(PROVIDER_NAME, err.message);
  }
  if (err instanceof InternalServerError || err instanceof APIConnectionError) {
    return new LlmUnavailable(PROVIDER_NAME, err.message);
  }
  if (err instanceof APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    if (status === 401 || status === 403) {
      return new LlmAuthError(PROVIDER_NAME, err.message);
    }
    if (status === 429) {
      return new LlmRateLimited(PROVIDER_NAME, err.message);
    }
    if (status >= 500) {
      return new LlmUnavailable(PROVIDER_NAME, err.message);
    }
    return new LlmError(`HTTP_${status || "UNKNOWN"}`, err.message, PROVIDER_NAME);
  }
  if (err instanceof Error) {
    return new LlmError("UNKNOWN", err.message, PROVIDER_NAME);
  }
  return new LlmError("UNKNOWN", String(err), PROVIDER_NAME);
}

function mapFinishReason(
  reason: string | null | undefined,
): ChatResult["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "stop";
  }
}

export class OpenAICompatProvider implements LlmProvider {
  readonly info: ProviderInfo;
  private client: OpenAI;
  private preset: PresetConfig;
  private effectiveBaseUrl: string;
  private effectiveChatModel: string;
  private effectiveEmbedModel: string | undefined;

  constructor(opts: OpenAICompatProviderOptions) {
    const preset = OPENAI_COMPAT_PRESETS[opts.preset];
    if (!preset) {
      throw new LlmError(
        "INVALID_PRESET",
        `unknown openai-compat preset: ${opts.preset}`,
        PROVIDER_NAME,
      );
    }
    this.preset = preset;

    const effectiveBaseUrl = opts.baseUrl ?? preset.baseUrl;
    if (!effectiveBaseUrl) {
      throw new LlmError(
        "MISSING_BASE_URL",
        opts.preset === "custom"
          ? "custom preset requires baseUrl in OpenAICompatProviderOptions"
          : `preset ${opts.preset} has no baseUrl and none was provided`,
        PROVIDER_NAME,
      );
    }
    this.effectiveBaseUrl = effectiveBaseUrl;

    if (preset.apiKeyRequired && !opts.apiKey) {
      throw new LlmAuthError(
        PROVIDER_NAME,
        `preset ${opts.preset} requires an apiKey`,
      );
    }

    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "dummy",
      baseURL: effectiveBaseUrl,
    });

    this.effectiveChatModel =
      opts.defaultChatModel || preset.defaultChatModel || "";
    this.effectiveEmbedModel =
      opts.defaultEmbedModel ?? preset.defaultEmbedModel;

    const embedSupported =
      preset.supportsEmbed || Boolean(opts.defaultEmbedModel);

    const isLocal =
      opts.isLocalOverride !== undefined ? opts.isLocalOverride : preset.isLocal;

    this.info = {
      name: PROVIDER_NAME,
      preset: opts.preset,
      baseUrl: effectiveBaseUrl,
      defaultModel: this.effectiveChatModel || undefined,
      isLocal,
      capabilities: {
        chat: true,
        embed: embedSupported,
        rerank: false,
        stream: true,
        toolCalling: true,
      },
    };
  }

  async chat(messages: ChatMessage[], opts?: ChatOpts): Promise<ChatResult> {
    const model = opts?.model || this.effectiveChatModel;
    if (!model) {
      throw new LlmError(
        "MISSING_MODEL",
        "no model specified and preset has no defaultChatModel",
        PROVIDER_NAME,
      );
    }

    const fullMessages: ChatCompletionRequestMessage[] = [];
    if (opts?.systemPrompt) {
      fullMessages.push({ role: "system", content: opts.systemPrompt });
    }
    for (const m of messages) {
      fullMessages.push({ role: m.role, content: m.content });
    }

    const body: ChatRequestBody = {
      model,
      messages: fullMessages,
      stream: false,
    };
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    try {
      const resp = await this.client.chat.completions.create(body);
      const choice = resp.choices[0];
      const message = choice?.message;
      const text = typeof message?.content === "string" ? message.content : "";

      const toolCalls: ToolCall[] | undefined = message?.tool_calls
        ?.map((tc): ToolCall | null => {
          if (tc.type !== "function") return null;
          let input: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(tc.function.arguments || "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              input = parsed as Record<string, unknown>;
            }
          } catch {
            input = { _raw: tc.function.arguments };
          }
          return { name: tc.function.name, input };
        })
        .filter((tc): tc is ToolCall => tc !== null);

      const inputTokens = resp.usage?.prompt_tokens ?? 0;
      const outputTokens = resp.usage?.completion_tokens ?? 0;

      return {
        text,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        usage: { inputTokens, outputTokens },
        model: resp.model || model,
        finishReason: mapFinishReason(choice?.finish_reason),
      };
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }

  async embeddings(texts: string[], opts?: EmbedOpts): Promise<EmbedResult> {
    if (!this.info.capabilities.embed) {
      throw new LlmCapabilityMissing(PROVIDER_NAME, "embed");
    }
    const model =
      opts?.model || this.effectiveEmbedModel || this.preset.defaultEmbedModel;
    if (!model) {
      throw new LlmError(
        "MISSING_MODEL",
        "no embedding model specified and preset has no defaultEmbedModel",
        PROVIDER_NAME,
      );
    }

    const body: { model: string; input: string[]; dimensions?: number } = {
      model,
      input: texts,
    };
    if (opts?.dimensions !== undefined) {
      body.dimensions = opts.dimensions;
    }

    try {
      const resp = await this.client.embeddings.create(body);
      const vectors = resp.data.map((d) => d.embedding);
      const dimensions = vectors[0]?.length ?? opts?.dimensions ?? 0;
      const inputTokens = resp.usage?.prompt_tokens ?? 0;
      return {
        vectors,
        model: resp.model || model,
        dimensions,
        usage: { inputTokens },
      };
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const started = Date.now();
    try {
      if (this.info.capabilities.chat && this.effectiveChatModel) {
        await this.client.chat.completions.create({
          model: this.effectiveChatModel,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        });
        return { ok: true, latencyMs: Date.now() - started };
      }
      if (this.info.capabilities.embed) {
        const embedModel =
          this.effectiveEmbedModel || this.preset.defaultEmbedModel;
        if (embedModel) {
          await this.client.embeddings.create({
            model: embedModel,
            input: ["ping"],
          });
          return { ok: true, latencyMs: Date.now() - started };
        }
      }
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: "no chat or embed model configured to test",
      };
    } catch (err) {
      const mapped = mapOpenAIError(err);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: mapped.message,
      };
    }
  }
}
