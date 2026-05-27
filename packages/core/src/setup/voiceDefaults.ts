import { eq } from "drizzle-orm";
import { database } from "../db/index.js";
import { systemConfig } from "../db/schema/systemConfig.js";

/**
 * Voice-capture defaults — persisted in `system_config` (KV) as a single
 * JSON value under the key `voice_defaults`.
 *
 * Lets the user pin a preferred default folder, title pattern, transcription
 * language hint and capture mode (Live / Whisper-Cloud / Whisper-Self-
 * Hosted). The voice pipe handler reads these defaults whenever the per-job
 * payload doesn't carry an explicit override, so the existing endpoint
 * (`POST /api/pipes/voice`) keeps working unchanged.
 *
 * Stored shape (in `system_config.value_text` as JSON):
 *   {
 *     "mode": "live" | "whisper-cloud" | "whisper-selfhosted",
 *     "folder": "30_captures/voice",
 *     "titlePattern": "Voice-Notiz {YYYY-MM-DD HH:mm}",
 *     "language": "de" | null
 *   }
 */

export const VOICE_DEFAULTS_KEY = "voice_defaults";

export type VoiceMode = "live" | "whisper-cloud" | "whisper-selfhosted";

export const VOICE_MODES: readonly VoiceMode[] = [
  "live",
  "whisper-cloud",
  "whisper-selfhosted",
] as const;

export interface VoiceDefaults {
  /** Capture mode the PWA defaults to when starting a recording. */
  mode: VoiceMode;
  /**
   * Vault-relative folder the voice handler writes notes into. No leading
   * or trailing slash, no `..` segments. First path segment MUST be one of
   * the well-known vault roots (see `VAULT_ROOTS`).
   */
  folder: string;
  /**
   * Title template for auto-named voice notes. Supports tokens:
   *   `{YYYY}` `{MM}` `{DD}` `{HH}` `{mm}` — UTC date parts
   *   `{slug}` — kebab-case of the first ~5 transcript words (max 40 chars)
   *   `{transcript-first-words}` — first sentence or first 80 chars
   * Max 200 characters.
   */
  titlePattern: string;
  /**
   * ISO 639-1 language hint passed to Whisper. `null` means auto-detect.
   * Accepts either a bare 2-letter code (`"de"`) or `code-REGION` shape
   * (`"de-DE"`); regions are kept as-is for display but Whisper only sees
   * the 2-letter prefix when the handler forwards it.
   */
  language: string | null;
}

/** Whitelisted top-level vault folders. Mirrors the structure documented in CLAUDE.md. */
export const VAULT_ROOTS: readonly string[] = [
  "00_meta",
  "10_projects",
  "20_notes",
  "30_captures",
  "40_customers",
  "40_daily",
  "50_decisions",
  "60_meetings",
  "70_pai",
  "80_brand",
  "90_ideas",
  "99_archive",
] as const;

export const DEFAULT_VOICE_DEFAULTS: VoiceDefaults = {
  mode: "live",
  folder: "30_captures/voice",
  titlePattern: "Voice-Notiz {YYYY-MM-DD HH:mm}",
  language: null,
};

/** Validation error surfaced by `validateVoiceDefaultsPatch`. */
export class VoiceDefaultsValidationError extends Error {
  constructor(
    readonly field: keyof VoiceDefaults,
    message: string,
  ) {
    super(message);
    this.name = "VoiceDefaultsValidationError";
  }
}

function isVoiceMode(value: unknown): value is VoiceMode {
  return (
    typeof value === "string" &&
    (VOICE_MODES as readonly string[]).includes(value)
  );
}

function normalizeFolder(folder: string): string {
  return folder.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function validateFolder(value: unknown): string {
  if (typeof value !== "string") {
    throw new VoiceDefaultsValidationError(
      "folder",
      "folder must be a string",
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new VoiceDefaultsValidationError(
      "folder",
      "folder must not be empty",
    );
  }
  if (trimmed.startsWith("/")) {
    throw new VoiceDefaultsValidationError(
      "folder",
      "folder must not start with '/' (vault-relative)",
    );
  }
  const normalized = normalizeFolder(trimmed);
  const segments = normalized.split("/");
  if (segments.some((s) => s === "..")) {
    throw new VoiceDefaultsValidationError(
      "folder",
      "folder must not contain '..' segments",
    );
  }
  const root = segments[0];
  if (!VAULT_ROOTS.includes(root)) {
    throw new VoiceDefaultsValidationError(
      "folder",
      `folder must start with one of: ${VAULT_ROOTS.join(", ")}`,
    );
  }
  return normalized;
}

function validateTitlePattern(value: unknown): string {
  if (typeof value !== "string") {
    throw new VoiceDefaultsValidationError(
      "titlePattern",
      "titlePattern must be a string",
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new VoiceDefaultsValidationError(
      "titlePattern",
      "titlePattern must not be empty",
    );
  }
  if (trimmed.length > 200) {
    throw new VoiceDefaultsValidationError(
      "titlePattern",
      "titlePattern must be 200 characters or fewer",
    );
  }
  return trimmed;
}

function validateLanguage(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new VoiceDefaultsValidationError(
      "language",
      "language must be a string or null",
    );
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  // ISO 639-1 (2 letters) optionally followed by region (`de-DE`, `en_US`).
  if (!/^[a-zA-Z]{2}([-_][a-zA-Z]{2,4})?$/.test(trimmed)) {
    throw new VoiceDefaultsValidationError(
      "language",
      "language must be ISO 639-1 (e.g. 'de') or with region (e.g. 'de-DE')",
    );
  }
  return trimmed;
}

function validateMode(value: unknown): VoiceMode {
  if (!isVoiceMode(value)) {
    throw new VoiceDefaultsValidationError(
      "mode",
      `mode must be one of: ${VOICE_MODES.join(", ")}`,
    );
  }
  return value;
}

/**
 * Validate a partial patch and return a clean `Partial<VoiceDefaults>`.
 * Throws `VoiceDefaultsValidationError` on the first invalid field.
 * Unknown keys are ignored (forward-compatibility with old clients).
 */
export function validateVoiceDefaultsPatch(
  patch: unknown,
): Partial<VoiceDefaults> {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new VoiceDefaultsValidationError(
      "mode",
      "body must be a JSON object",
    );
  }
  const out: Partial<VoiceDefaults> = {};
  const p = patch as Record<string, unknown>;
  if ("mode" in p) out.mode = validateMode(p.mode);
  if ("folder" in p) out.folder = validateFolder(p.folder);
  if ("titlePattern" in p) out.titlePattern = validateTitlePattern(p.titlePattern);
  if ("language" in p) out.language = validateLanguage(p.language);
  return out;
}

/**
 * Merge a stored row (raw JSON object or null) with the hardcoded defaults.
 * Bad / missing fields in the stored row silently fall back to the default
 * — old rows are never the reason a request fails.
 */
function mergeWithDefaults(stored: unknown): VoiceDefaults {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { ...DEFAULT_VOICE_DEFAULTS };
  }
  const s = stored as Record<string, unknown>;
  const merged: VoiceDefaults = { ...DEFAULT_VOICE_DEFAULTS };
  if (isVoiceMode(s.mode)) merged.mode = s.mode;
  if (typeof s.folder === "string" && s.folder.trim()) {
    try {
      merged.folder = validateFolder(s.folder);
    } catch {
      // keep default
    }
  }
  if (typeof s.titlePattern === "string" && s.titlePattern.trim()) {
    try {
      merged.titlePattern = validateTitlePattern(s.titlePattern);
    } catch {
      // keep default
    }
  }
  if (s.language === null) {
    merged.language = null;
  } else if (typeof s.language === "string") {
    try {
      merged.language = validateLanguage(s.language);
    } catch {
      // keep default (null)
    }
  }
  return merged;
}

/** Read the stored voice defaults, merged with the hardcoded baseline. */
export async function getVoiceDefaults(): Promise<VoiceDefaults> {
  return (await getVoiceDefaultsWithMeta()).defaults;
}

/**
 * Sibling to `getVoiceDefaults` that also reports whether a persisted row
 * exists. Callers use this to distinguish "user has explicitly configured
 * voice defaults" from "no row yet — handler should keep the legacy
 * behavior". Backwards-compat in the voice pipe handler depends on it.
 */
export interface VoiceDefaultsWithMeta {
  defaults: VoiceDefaults;
  /** True iff a `system_config[voice_defaults]` row was found. */
  rowExists: boolean;
}

export async function getVoiceDefaultsWithMeta(): Promise<VoiceDefaultsWithMeta> {
  const rows = await database()
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, VOICE_DEFAULTS_KEY))
    .limit(1);
  const raw = rows[0]?.valueText;
  if (!raw) {
    return { defaults: { ...DEFAULT_VOICE_DEFAULTS }, rowExists: false };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return { defaults: mergeWithDefaults(parsed), rowExists: true };
  } catch {
    // Corrupt JSON: treat like "no row" so the handler stays on legacy
    // behavior, but still flag rowExists=false so we don't pin a broken
    // path shape. The PUT endpoint will overwrite the bad row on next write.
    return { defaults: { ...DEFAULT_VOICE_DEFAULTS }, rowExists: false };
  }
}

/**
 * Persist a patch on top of the current defaults. Returns the full merged
 * value after the write. Validation happens on the patch only — fields the
 * caller didn't send keep their current value.
 */
export async function updateVoiceDefaults(
  patch: Partial<VoiceDefaults>,
): Promise<VoiceDefaults> {
  const current = await getVoiceDefaults();
  const merged: VoiceDefaults = {
    mode: patch.mode ?? current.mode,
    folder: patch.folder ?? current.folder,
    titlePattern: patch.titlePattern ?? current.titlePattern,
    language:
      patch.language === undefined ? current.language : patch.language,
  };
  const serialized = JSON.stringify(merged);
  const db = database();
  const existing = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, VOICE_DEFAULTS_KEY))
    .limit(1);
  if (existing[0]) {
    await db
      .update(systemConfig)
      .set({ valueText: serialized, updatedAt: new Date() })
      .where(eq(systemConfig.key, VOICE_DEFAULTS_KEY));
  } else {
    await db.insert(systemConfig).values({
      key: VOICE_DEFAULTS_KEY,
      valueText: serialized,
    });
  }
  return merged;
}
