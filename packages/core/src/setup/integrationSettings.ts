import { eq } from "drizzle-orm";
import { database } from "../db/index.js";
import { systemConfig } from "../db/schema/systemConfig.js";

/**
 * Integration settings — persisted in `system_config` (KV).
 *
 * Two values today:
 *   - `supadata_api_key`        → external API key for URL/YouTube import pipes
 *   - `default_import_folder`   → vault-relative folder pipe handlers write to
 *
 * Both are written/read via this module so the UI, MCP, and pipe handlers
 * agree on the single source of truth. Env vars stay supported as a
 * read-only fallback (only used when the DB value is missing).
 */

const KEY_SUPADATA = "supadata_api_key";
const KEY_DEFAULT_IMPORT_FOLDER = "default_import_folder";

export const DEFAULT_IMPORT_FOLDER = "30_captures";

export interface IntegrationSettings {
  /** Plain key from DB, or `null` if not configured. NEVER expose unmasked over HTTP. */
  supadataApiKey: string | null;
  /** Vault-relative folder for pipe handlers. Defaults to `30_captures`. */
  defaultImportFolder: string;
}

async function readValue(key: string): Promise<string | null> {
  const rows = await database()
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, key))
    .limit(1);
  const v = rows[0]?.valueText;
  return typeof v === "string" && v.length > 0 ? v : null;
}

async function writeValue(key: string, value: string | null): Promise<void> {
  const db = database();
  const existing = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, key))
    .limit(1);
  if (existing[0]) {
    await db
      .update(systemConfig)
      .set({ valueText: value, updatedAt: new Date() })
      .where(eq(systemConfig.key, key));
  } else {
    await db.insert(systemConfig).values({
      key,
      valueText: value,
    });
  }
}

/** Read both integration settings. Falls back to env for the Supadata key. */
export async function getIntegrationSettings(): Promise<IntegrationSettings> {
  const [key, folder] = await Promise.all([
    readValue(KEY_SUPADATA),
    readValue(KEY_DEFAULT_IMPORT_FOLDER),
  ]);
  const envKey = process.env.SUPADATA_API_KEY;
  return {
    supadataApiKey:
      key ?? (typeof envKey === "string" && envKey.length > 0 ? envKey : null),
    defaultImportFolder:
      folder && folder.trim().length > 0
        ? normalizeFolder(folder)
        : DEFAULT_IMPORT_FOLDER,
  };
}

/** Convenience read for the Supadata key — used by pipe handlers. */
export async function getSupadataApiKey(): Promise<string | null> {
  const s = await getIntegrationSettings();
  return s.supadataApiKey;
}

/** Convenience read for the default import folder — used by pipe handlers. */
export async function getDefaultImportFolder(): Promise<string> {
  const s = await getIntegrationSettings();
  return s.defaultImportFolder;
}

/** Write the Supadata API key. Empty string / null → clear it. */
export async function setSupadataApiKey(value: string | null): Promise<void> {
  const trimmed = value?.trim() ?? "";
  await writeValue(KEY_SUPADATA, trimmed.length > 0 ? trimmed : null);
}

/** Write the default import folder. Empty / null → reset to default. */
export async function setDefaultImportFolder(value: string | null): Promise<void> {
  const trimmed = value?.trim() ?? "";
  await writeValue(
    KEY_DEFAULT_IMPORT_FOLDER,
    trimmed.length > 0 ? normalizeFolder(trimmed) : null,
  );
}

/** Mask a Supadata key for client-side display: `***…{last4}`. Null → null. */
export function maskSupadataKey(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return "***";
  return `***...${value.slice(-4)}`;
}

function normalizeFolder(folder: string): string {
  // Strip leading/trailing slashes; collapse internal `//`. Vault-relative.
  return folder.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}
