import type { ValidationErrorDetail } from "../frontmatter/types.js";

/**
 * Thrown when a frontmatter map fails its per-doc-type schema validation,
 * or when a write to the vault is rejected by the pre-commit hook for the
 * same reason.
 *
 * Distinct from generic Error / git errors so the route handlers in
 * `server` (and tool handlers in `mcp`) can surface it to the user as a
 * dedicated 400-style response instead of a generic 500.
 */
export class FrontmatterValidationError extends Error {
  readonly noteId: string | null;
  readonly errors: ValidationErrorDetail[];

  constructor(opts: {
    message: string;
    noteId?: string | null;
    errors: ValidationErrorDetail[];
    cause?: unknown;
  }) {
    super(opts.message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "FrontmatterValidationError";
    this.noteId = opts.noteId ?? null;
    this.errors = opts.errors;
  }
}
