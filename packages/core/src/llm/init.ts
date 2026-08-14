import { llmRegistry } from "./registry.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { OllamaProvider } from "./providers/ollama.js";
import {
  OpenAICompatProvider,
  type OpenAICompatPreset,
} from "./providers/openai-compat.js";
import { CohereProvider } from "./providers/cohere.js";
import { LocalReranker } from "./providers/localReranker.js";
import type { LlmProvider, ProviderConfig } from "./types.js";

export interface LlmInitResult {
  registered: string[];
  errors: { providerName: string; error: string }[];
}

/**
 * Read provider configs (typically from `getLlmProviders()`), instantiate each
 * enabled provider, register it in the singleton `llmRegistry()`.
 *
 * Idempotent: clears the registry first, then re-registers. Safe to call
 * again after a config update without restarting the process.
 *
 * Returns the list of successfully registered provider names and any
 * per-provider instantiation errors. Errors are NOT thrown — one broken
 * provider must not block the rest.
 */
export async function initLlmFromConfig(
  configs: ProviderConfig[],
): Promise<LlmInitResult> {
  llmRegistry().clear();
  const registered: string[] = [];
  const errors: { providerName: string; error: string }[] = [];

  for (const cfg of configs) {
    if (!cfg.enabled) continue;
    try {
      const provider = instantiate(cfg);
      llmRegistry().register(cfg.name, provider);
      registered.push(cfg.name);
    } catch (e) {
      errors.push({
        providerName: cfg.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { registered, errors };
}

function instantiate(cfg: ProviderConfig): LlmProvider {
  switch (cfg.name) {
    case "anthropic": {
      if (!cfg.apiKey) throw new Error("anthropic requires apiKey");
      return new AnthropicProvider({
        apiKey: cfg.apiKey,
        defaultModel: cfg.defaultModel,
        baseUrl: cfg.baseUrl,
      });
    }
    case "openai": {
      if (!cfg.apiKey) throw new Error("openai requires apiKey");
      return new OpenAIProvider({
        apiKey: cfg.apiKey,
        defaultChatModel: cfg.defaultModel,
        baseUrl: cfg.baseUrl,
      });
    }
    case "ollama": {
      // `timeoutMs` bleibt hier bewusst ein reines Durchreichen: die
      // Präzedenz Config → `LOKYY_OLLAMA_TIMEOUT_MS` → Default lebt im
      // Provider (`resolveOllamaTimeoutMs`), damit sie auch für die
      // Konstruktionsstellen außerhalb dieser Factory gilt (issue #54).
      return new OllamaProvider({
        baseUrl: cfg.baseUrl,
        defaultChatModel: cfg.defaultModel,
        timeoutMs: cfg.timeoutMs,
      });
    }
    case "openai-compat": {
      if (!cfg.preset) throw new Error("openai-compat requires preset");
      return new OpenAICompatProvider({
        preset: cfg.preset as OpenAICompatPreset,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        defaultChatModel: cfg.defaultModel,
      });
    }
    case "cohere": {
      if (!cfg.apiKey) throw new Error("cohere requires apiKey");
      return new CohereProvider({
        apiKey: cfg.apiKey,
        defaultRerankModel: cfg.defaultModel,
        baseUrl: cfg.baseUrl,
      });
    }
    case "local-reranker": {
      return new LocalReranker({
        baseUrl: cfg.baseUrl,
        judgeModel: cfg.defaultModel,
        timeoutMs: cfg.timeoutMs,
      });
    }
    default:
      throw new Error(`unknown provider: ${cfg.name}`);
  }
}
