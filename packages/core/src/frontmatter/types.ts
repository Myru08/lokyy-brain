/**
 * Vault frontmatter contract — see CLAUDE.md "Vault Contract (SPEC)".
 *
 * Every .md file in a lokyy-vault requires YAML frontmatter validated by
 * one of these doc types. The pre-commit hook in the vault rejects any
 * write that fails validation.
 */

/** Closed list of supported doc types. */
export const DOC_TYPES = [
  "note",
  "capture",
  "project",
  "task",
  "decision",
  "meeting",
  "customer",
  "workflow",
  "intervention",
  "content",
] as const;

export type DocType = (typeof DOC_TYPES)[number];

/**
 * Per-note privacy tier (frontmatter `privacy:` field).
 *
 * - `"default"` — follow the global privacyTier setting of the LLM router.
 * - `"local-only"` — force a local provider (`isLocal: true`) regardless of
 *   the user's global setting. Cloud providers are skipped in the router
 *   chain for any AI operation against this note.
 *
 * Optional; absent means `"default"` (backwards-compat with legacy notes
 * written before this field existed).
 */
export type NotePrivacy = "default" | "local-only";

/**
 * Device categories used by the encoding-context-capture (Phase B Wave B3 /
 * Story 1 — Tulving 1973 Encoding Specificity Principle).
 *
 * `"api"` covers headless / scripted writes; `"mcp"` distinguishes writes
 * arriving through the MCP tool surface so retrieval can prefer
 * human-authored notes when the query comes from the PWA.
 */
export type DeviceType =
  | "laptop"
  | "desktop"
  | "mobile"
  | "tablet"
  | "api"
  | "mcp";

/** Coarse time-of-day bucket. See `timeOfDayFrom` in `scoring/encodingContext.ts`. */
export type TimeOfDay = "morning" | "midday" | "evening" | "night";

/** Lowercase English weekday name. */
export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/**
 * Encoding-context block. Captured at note-creation time and persisted as
 * `encoded:` in the YAML frontmatter. NEVER updated on subsequent saves —
 * it describes the encoding event, not the current state of the note.
 *
 * All fields are optional so legacy notes (no `encoded` block) continue to
 * validate; matchers treat a missing block as "no boost".
 */
export interface EncodedContext {
  /** Device class the note was authored on. */
  device?: DeviceType;
  /** Free-form app-state label (e.g. `"focused-writing"`, `"daily-review"`). */
  app_state?: string;
  /** Coarse time-of-day at creation. Derived from local clock. */
  time_of_day?: TimeOfDay;
  /** Weekday at creation. Derived from local clock. */
  weekday?: Weekday;
  /** Notes that were open immediately before this one was created. */
  preceding_notes?: string[];
  /** Length of the authoring session up to this note, in minutes. */
  session_duration_min?: number;
  /** Word-count produced during this session up to creation. */
  word_count_session?: number;
  /** Origin metadata when the note came from a pipe (url, youtube, …). */
  source?: Record<string, unknown>;
}

/**
 * Parsed frontmatter map — open shape; per-type schemas enforce required
 * keys via ajv. We type the well-known fields for ergonomics, but keep the
 * index signature so per-doc-type extras (e.g. `status` on tasks, `source`
 * on captures) pass through without per-call casts.
 */
export interface FrontmatterMap {
  /** ULID (26 chars, Crockford base32). Immutable after creation. */
  id?: string;
  /** One of the DOC_TYPES values. */
  type?: DocType;
  /** Human-readable title. */
  title?: string;
  /** Creation ISO-8601 timestamp. Immutable after creation. */
  created?: string;
  /** Last-modified ISO-8601 timestamp. Bumped on each save. */
  updated?: string;
  /** Free-form tags. */
  tags?: string[];
  /** Aliases for the note (alternative names). */
  aliases?: string[];
  /**
   * Privacy tier for AI operations. When set to `"local-only"` the
   * LlmRouter is forced onto an `isLocal: true` provider regardless of
   * the user's global privacyTier setting. Absent = `"default"`.
   */
  privacy?: NotePrivacy;
  /**
   * Encoding-context captured at create-time. See `EncodedContext` and
   * `scoring/encodingContext.ts`. Optional — legacy notes have no block.
   */
  encoded?: EncodedContext;
  /** Per-doc-type extras (status, due, source, …) pass through here. */
  [key: string]: unknown;
}

/** Required base fields every doc carries (strict — for typed builders). */
export interface BaseFrontmatter {
  /** ULID (26 chars, Crockford base32). Immutable after creation. */
  id: string;
  /** One of the DOC_TYPES values. */
  type: DocType;
  /** Human-readable title. */
  title: string;
  /** Creation ISO-8601 timestamp. Immutable after creation. */
  created: string;
  /** Last-modified ISO-8601 timestamp. Bumped on each save. */
  updated: string;
  /** Optional privacy tier — see `NotePrivacy`. */
  privacy?: NotePrivacy;
  /** Optional encoding-context block — see `EncodedContext`. */
  encoded?: EncodedContext;
}

/** Ajv-style validation result wrapper. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationErrorDetail[];
}

export interface ValidationErrorDetail {
  /** JSON Pointer path inside the frontmatter. */
  instancePath: string;
  /** Ajv keyword that failed (e.g. "required", "pattern", "format"). */
  keyword: string;
  /** Human-readable message. */
  message: string;
  /** Additional Ajv params (e.g. `{missingProperty: "id"}`). */
  params: Record<string, unknown>;
}
