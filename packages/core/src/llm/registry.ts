import type { LlmProvider } from "./types.js";

/**
 * Singleton registry of all initialised LlmProviders.
 * Initialised once at server start from system_config.
 */
export class LlmRegistry {
  private providers = new Map<string, LlmProvider>();

  register(name: string, provider: LlmProvider): void {
    this.providers.set(name, provider);
  }

  get(name: string): LlmProvider | undefined {
    return this.providers.get(name);
  }

  list(): { name: string; provider: LlmProvider }[] {
    return Array.from(this.providers.entries()).map(([name, provider]) => ({
      name,
      provider,
    }));
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  clear(): void {
    this.providers.clear();
  }
}

// Singleton accessor
let _instance: LlmRegistry | null = null;

export function llmRegistry(): LlmRegistry {
  if (!_instance) _instance = new LlmRegistry();
  return _instance;
}

export function resetLlmRegistry(): void {
  _instance = null;
}
