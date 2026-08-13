import { getLlmProviders, getLlmRouting } from "./configStore.js";
import {
  OllamaProvider,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CHAT_MODEL,
  OLLAMA_DEFAULT_EMBED_MODEL,
  type OllamaPullProgress,
} from "./providers/ollama.js";
import type { LlmRole, LlmRoutingConfig, ProviderConfig } from "./types.js";

/**
 * Ollama-model presence + pull orchestration (issue #46).
 *
 * The Privacy-Max profile routes every LLM role at `ollama("llama3.1:8b")`,
 * but that chat model is NEVER auto-pulled (only `nomic-embed-text` is) and its
 * presence was never checked — so a Privacy-Max setup silently ran local LLM
 * tasks against a missing model. This module makes the gap visible: it reports
 * which CONFIGURED Ollama models are actually installed, and streams a pull for
 * the missing ones.
 */

/** Rough on-disk sizes for the models the UI offers to install. */
export const KNOWN_OLLAMA_MODEL_SIZES: Record<string, string> = {
  "llama3.1:8b": "~4.9 GB",
  "nomic-embed-text": "~274 MB",
  "qwen2.5:7b": "~4.7 GB",
  "mistral:7b": "~4.1 GB",
  "llama3.2:3b": "~2.0 GB",
};

export type OllamaModelKind = "chat" | "embedding";

export interface ConfiguredOllamaModel {
  model: string;
  roles: LlmRole[];
  kind: OllamaModelKind;
}

export interface OllamaModelStatusEntry extends ConfiguredOllamaModel {
  installed: boolean;
  /** Approximate download size, when known (e.g. `~4.9 GB`). */
  sizeHint?: string;
}

export interface OllamaModelStatus {
  /** Whether `/api/tags` answered — false means Ollama itself is unreachable. */
  ollamaReachable: boolean;
  /** The host actually probed (provider baseUrl → OLLAMA_HOST → default). */
  host: string;
  /** All model names installed in Ollama (with their tags). */
  installed: string[];
  /** Per configured Ollama model: is it installed? */
  models: OllamaModelStatusEntry[];
  /** Populated only when `ollamaReachable` is false. */
  error?: string;
}

/**
 * Resolve which host to talk to. Precedence mirrors `llmRoutes.get("/config")`:
 * an explicit provider `baseUrl` wins, then `OLLAMA_HOST`, then the default.
 */
export function resolveOllamaHost(
  providers: ProviderConfig[],
  envHost?: string,
): string {
  const ollama = providers.find((p) => p.name === "ollama");
  const baseUrl = ollama?.baseUrl?.trim();
  if (baseUrl) return baseUrl;
  const env = (envHost ?? process.env.OLLAMA_HOST ?? "").trim();
  if (env) return env;
  return OLLAMA_DEFAULT_BASE_URL;
}

/**
 * Is `wanted` installed among `installed`? Ollama tag names carry a `:tag`
 * suffix (`nomic-embed-text:latest`), so an untagged wanted matches any tag of
 * the same base, and `:latest` is treated as the implicit default both ways.
 */
export function modelInstalled(installed: string[], wanted: string): boolean {
  const w = wanted.trim();
  if (!w) return false;
  return installed.some((name) => {
    if (name === w) return true;
    if (!w.includes(":") && name.startsWith(`${w}:`)) return true;
    if (w.endsWith(":latest") && name === w.slice(0, -":latest".length)) return true;
    if (name.endsWith(":latest") && name.slice(0, -":latest".length) === w) return true;
    return false;
  });
}

/** Best-effort size hint: exact tag first, then the untagged base name. */
export function ollamaModelSizeHint(model: string): string | undefined {
  if (KNOWN_OLLAMA_MODEL_SIZES[model]) return KNOWN_OLLAMA_MODEL_SIZES[model];
  const base = model.split(":")[0];
  return KNOWN_OLLAMA_MODEL_SIZES[base];
}

/**
 * Every distinct Ollama model referenced by the routing config, with the roles
 * that use it. An assignment without an explicit `model` falls back to the
 * provider default (embedding role → embed default, everything else → chat).
 */
export function collectConfiguredOllamaModels(
  routing: LlmRoutingConfig,
): ConfiguredOllamaModel[] {
  const byModel = new Map<string, { roles: LlmRole[]; hasEmbedding: boolean }>();
  const roles = routing.roles ?? {};

  for (const [role, assignment] of Object.entries(roles) as [
    LlmRole,
    { provider: string; model?: string } | undefined,
  ][]) {
    if (!assignment || assignment.provider !== "ollama") continue;
    const isEmbedding = role === "embedding";
    const model =
      assignment.model?.trim() ||
      (isEmbedding ? OLLAMA_DEFAULT_EMBED_MODEL : OLLAMA_DEFAULT_CHAT_MODEL);
    const entry = byModel.get(model) ?? { roles: [], hasEmbedding: false };
    entry.roles.push(role);
    if (isEmbedding) entry.hasEmbedding = true;
    byModel.set(model, entry);
  }

  return Array.from(byModel.entries()).map(([model, { roles: rs, hasEmbedding }]) => ({
    model,
    roles: rs,
    kind: hasEmbedding ? "embedding" : "chat",
  }));
}

/**
 * Full presence report for the configured Ollama models. Never throws — an
 * unreachable Ollama degrades to `ollamaReachable:false` with `installed:[]`
 * and `installed:false` on every configured model.
 */
export async function getOllamaModelStatus(opts: {
  envHost?: string;
} = {}): Promise<OllamaModelStatus> {
  const [providers, routing] = await Promise.all([
    getLlmProviders(),
    getLlmRouting(),
  ]);
  const host = resolveOllamaHost(providers, opts.envHost);
  const configured = collectConfiguredOllamaModels(routing);

  let installed: string[] = [];
  let reachable = true;
  let error: string | undefined;
  try {
    installed = await new OllamaProvider({ baseUrl: host }).listModelNames();
  } catch (err) {
    reachable = false;
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    ollamaReachable: reachable,
    host,
    installed,
    error,
    models: configured.map((m) => ({
      ...m,
      installed: reachable && modelInstalled(installed, m.model),
      sizeHint: ollamaModelSizeHint(m.model),
    })),
  };
}

/**
 * Pull one model into the configured Ollama host, streaming progress. The host
 * is resolved the same way `getOllamaModelStatus` resolves it, so the pull
 * lands exactly where the presence check looks.
 */
export async function pullOllamaModel(
  model: string,
  onProgress: (p: OllamaPullProgress) => void,
  opts: { envHost?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const providers = await getLlmProviders();
  const host = resolveOllamaHost(providers, opts.envHost);
  await new OllamaProvider({ baseUrl: host }).pullModel(model, onProgress, opts.signal);
}
