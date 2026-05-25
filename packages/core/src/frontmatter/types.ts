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

/** Parsed frontmatter map — open shape; per-type schemas enforce required keys. */
export type FrontmatterMap = Record<string, unknown>;

/** Required base fields every doc carries. */
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
