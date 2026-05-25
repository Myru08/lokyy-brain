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
