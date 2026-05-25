import { eq } from "drizzle-orm";
import { database } from "../db/index.js";
import { systemConfig } from "../db/schema/systemConfig.js";
import type { ProviderConfig, LlmRoutingConfig } from "./types.js";

/**
 * LLM provider + routing config persisted in `system_config` (KV).
 *
 * Storage:
 *   - key `llm_providers` → JSON-stringified `ProviderConfig[]`
 *   - key `llm_routing`   → JSON-stringified `LlmRoutingConfig`
 *
 * NOTE: `apiKey` is stored plain-text in the DB for now. Encryption is a
 * follow-up — see Phase-0 Wave C-Backend brief. HTTP layer MUST mask via
 * `maskApiKey` before returning to clients.
 */

const KEY_LLM_PROVIDERS = "llm_providers";
const KEY_LLM_ROUTING = "llm_routing";

const DEFAULT_ROUTING: LlmRoutingConfig = {
  roles: {},
  fallbacks: {},
  privacyTier: "always_local",
};

async function readJson<T>(key: string): Promise<T | null> {
  const rows = await database()
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, key))
    .limit(1);
  const v = rows[0]?.valueText;
  if (typeof v !== "string" || v.length === 0) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const db = database();
  const serialized = JSON.stringify(value);
  const existing = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, key))
    .limit(1);
  if (existing[0]) {
    await db
      .update(systemConfig)
      .set({ valueText: serialized, updatedAt: new Date() })
      .where(eq(systemConfig.key, key));
  } else {
    await db.insert(systemConfig).values({
      key,
      valueText: serialized,
    });
  }
}

/** Read configured LLM providers. Returns `[]` if nothing is persisted. */
export async function getLlmProviders(): Promise<ProviderConfig[]> {
  const data = await readJson<ProviderConfig[]>(KEY_LLM_PROVIDERS);
  if (!Array.isArray(data)) return [];
  return data;
}

/** Persist the full list of LLM providers. Overwrites prior value. */
export async function setLlmProviders(configs: ProviderConfig[]): Promise<void> {
  await writeJson(KEY_LLM_PROVIDERS, configs);
}

/** Read routing config. Returns sane defaults if nothing persisted. */
export async function getLlmRouting(): Promise<LlmRoutingConfig> {
  const data = await readJson<LlmRoutingConfig>(KEY_LLM_ROUTING);
  if (!data || typeof data !== "object") {
    return { ...DEFAULT_ROUTING, roles: {}, fallbacks: {} };
  }
  return {
    roles: data.roles ?? {},
    fallbacks: data.fallbacks ?? {},
    privacyTier: data.privacyTier ?? DEFAULT_ROUTING.privacyTier,
    privacyTierFolders: data.privacyTierFolders,
  };
}

/** Persist routing config. Overwrites prior value. */
export async function setLlmRouting(routing: LlmRoutingConfig): Promise<void> {
  await writeJson(KEY_LLM_ROUTING, routing);
}

/**
 * Mask an API key for client-side display.
 * Format: `sk-•••••...{last4}` (or `•••••...{last4}` if no recognized prefix).
 * Null / empty → null. Strings shorter than 5 chars → fully masked.
 */
export function maskApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 4) return "•••••";
  const last4 = key.slice(-4);
  const prefixMatch = key.match(/^(sk-|sk_|pk-)/);
  const prefix = prefixMatch ? prefixMatch[1] : "";
  return `${prefix}•••••...${last4}`;
}
