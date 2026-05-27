import { Hono } from "hono";
import {
  getLlmProviders,
  setLlmProviders,
  getLlmRouting,
  setLlmRouting,
  maskApiKey,
  initLlmFromConfig,
  llmRegistry,
  budgetTracker,
  OPENAI_COMPAT_PRESETS,
  type ProviderConfig,
  type LlmRoutingConfig,
} from "@lokyy/core";

/**
 * LLM config + registry routes (Phase-0 Wave C-Backend).
 *
 * - GET    /api/llm/config                 → providers (masked) + routing + usage
 * - PUT    /api/llm/config                 → upsert providers + routing, re-init registry
 * - POST   /api/llm/test-connection        → ping a registered provider
 * - GET    /api/llm/presets/openai-compat  → list of static presets
 *
 * The Supadata mask-on-GET pattern is mirrored here: outbound `apiKey` is
 * always masked. On inbound PUT, a masked value (matching the mask format)
 * is treated as "no change" — the existing key is preserved.
 */
export const llmRoutes = new Hono();

/** Returns true when the string is a server-issued masked key (must NOT overwrite real key). */
function isMaskedKey(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  // mask shape: "sk-•••••...{last4}" or "•••••...{last4}" or "•••••"
  return /•/.test(value);
}

llmRoutes.get("/config", async (c) => {
  const providers = await getLlmProviders();
  const envOllamaHost = process.env.OLLAMA_HOST ?? "http://localhost:11434";

  const masked: ProviderConfig[] = providers.map((p) => {
    const next: ProviderConfig = {
      ...p,
      apiKey: maskApiKey(p.apiKey ?? null) ?? undefined,
    };
    // Ollama's baseUrl falls back to process.env.OLLAMA_HOST when the user
    // hasn't explicitly set one. Without this, the AI-Provider panel would
    // display the hardcoded localhost placeholder even when the backend
    // actually talks to an in-cluster Ollama (http://ollama-<UUID>:11434).
    if (next.name === "ollama" && (!next.baseUrl || next.baseUrl.length === 0)) {
      next.baseUrl = envOllamaHost;
    }
    return next;
  });

  // Inject a disabled Ollama placeholder when the user has never touched
  // the AI-Provider panel — so the env-derived host is visible from the
  // very first page load instead of "http://localhost:11434" (frontend
  // placeholder). The provider stays `enabled: false` so it has no runtime
  // side effect until the user actively opts in.
  if (!masked.some((p) => p.name === "ollama")) {
    masked.push({
      name: "ollama",
      enabled: false,
      baseUrl: envOllamaHost,
    });
  }

  const routing = await getLlmRouting();
  const usage = await budgetTracker().listMonthlyUsage();
  return c.json({ providers: masked, routing, usage });
});

interface PutBody {
  providers: ProviderConfig[];
  routing: LlmRoutingConfig;
}

llmRoutes.put("/config", async (c) => {
  let body: PutBody;
  try {
    body = (await c.req.json()) as PutBody;
  } catch {
    return c.json({ error: "invalid-json" }, 400);
  }
  if (!body || !Array.isArray(body.providers) || typeof body.routing !== "object") {
    return c.json(
      { error: "invalid-body", message: "expected { providers: [], routing: {} }" },
      400,
    );
  }

  // Preserve existing apiKey when client sends back the masked placeholder.
  // Provider identity = (name, preset) — two openai-compat providers can coexist
  // (e.g. openrouter + groq) but each (name, preset) tuple is unique.
  const existing = await getLlmProviders();
  const merged: ProviderConfig[] = body.providers.map((p) => {
    if (isMaskedKey(p.apiKey)) {
      const old = existing.find(
        (e) => e.name === p.name && (e.preset ?? null) === (p.preset ?? null),
      );
      return { ...p, apiKey: old?.apiKey };
    }
    return p;
  });

  await setLlmProviders(merged);
  await setLlmRouting(body.routing);

  // Re-init registry so changes take effect immediately (no restart needed).
  const result = await initLlmFromConfig(merged);
  return c.json({ ok: true, ...result });
});

llmRoutes.post("/test-connection", async (c) => {
  let body: { providerName?: string };
  try {
    body = (await c.req.json()) as { providerName?: string };
  } catch {
    return c.json({ error: "invalid-json" }, 400);
  }
  const providerName = body.providerName;
  if (!providerName || typeof providerName !== "string") {
    return c.json({ error: "providerName-required" }, 400);
  }
  const provider = llmRegistry().get(providerName);
  if (!provider) {
    return c.json({ ok: false, error: "provider not registered" }, 404);
  }
  const result = await provider.testConnection();
  return c.json(result);
});

llmRoutes.get("/presets/openai-compat", (c) => {
  return c.json({ presets: Object.values(OPENAI_COMPAT_PRESETS) });
});
