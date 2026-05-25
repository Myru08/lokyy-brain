import matter from "gray-matter";
import { ulid as ulidFn } from "ulid";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  DOC_TYPES,
  type DocType,
  type FrontmatterMap,
  type ValidationErrorDetail,
  type ValidationResult,
} from "./types.js";

import baseSchema from "./schemas/base.json" with { type: "json" };
import noteSchema from "./schemas/note.json" with { type: "json" };
import captureSchema from "./schemas/capture.json" with { type: "json" };
import projectSchema from "./schemas/project.json" with { type: "json" };
import taskSchema from "./schemas/task.json" with { type: "json" };
import decisionSchema from "./schemas/decision.json" with { type: "json" };
import meetingSchema from "./schemas/meeting.json" with { type: "json" };
import customerSchema from "./schemas/customer.json" with { type: "json" };
import workflowSchema from "./schemas/workflow.json" with { type: "json" };
import interventionSchema from "./schemas/intervention.json" with { type: "json" };
import contentSchema from "./schemas/content.json" with { type: "json" };

/**
 * Vault frontmatter utility for lokyy-brain.
 *
 * Every .md file in a lokyy-vault has a YAML frontmatter block. The
 * vault's pre-commit hook validates against the per-type JSON schemas in
 * `./schemas/`. This module is the canonical parse/serialize/validate
 * surface used by `notesService.createNote` / `saveNote` and the future
 * MCP tools to guarantee writes never reach the hook in an invalid shape.
 */

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validators = new Map<DocType, ValidateFunction>([
  ["note", ajv.compile(noteSchema as object)],
  ["capture", ajv.compile(captureSchema as object)],
  ["project", ajv.compile(projectSchema as object)],
  ["task", ajv.compile(taskSchema as object)],
  ["decision", ajv.compile(decisionSchema as object)],
  ["meeting", ajv.compile(meetingSchema as object)],
  ["customer", ajv.compile(customerSchema as object)],
  ["workflow", ajv.compile(workflowSchema as object)],
  ["intervention", ajv.compile(interventionSchema as object)],
  ["content", ajv.compile(contentSchema as object)],
]);

const baseValidator = ajv.compile(baseSchema as object);

/** Generate a new ULID (26 chars, Crockford base32). */
export function generateUlid(): string {
  return ulidFn();
}

/**
 * Parse a Markdown document into `{ data, body }`. Uses gray-matter, so a
 * doc without frontmatter returns `{ data: {}, body: <full text> }`.
 *
 * No validation is performed here — validation is a separate concern via
 * `validateFrontmatter`.
 */
export function parseFrontmatter(raw: string): {
  data: FrontmatterMap;
  body: string;
} {
  const parsed = matter(raw);
  return { data: parsed.data as FrontmatterMap, body: parsed.content };
}

/**
 * Serialize a frontmatter map + body back to a Markdown document with a
 * YAML `---` frontmatter block. Preserves key order from `data`.
 */
export function serializeFrontmatter(
  data: FrontmatterMap,
  body: string,
): string {
  return matter.stringify(body, data);
}

/**
 * Validate a parsed frontmatter map against the schema for `type`. Returns
 * `{ valid, errors }`. Callers that throw on invalid input should use
 * `FrontmatterValidationError`.
 *
 * If `type` is not a known doc type, falls back to the base schema and
 * adds a synthetic error so the caller still gets a typed signal.
 */
export function validateFrontmatter(
  data: FrontmatterMap,
  type: DocType,
): ValidationResult {
  const validator = validators.get(type);
  if (!validator) {
    const baseOk = baseValidator(data);
    return {
      valid: false,
      errors: [
        {
          instancePath: "/type",
          keyword: "enum",
          message: `Unknown doc type "${String(type)}". Expected one of: ${DOC_TYPES.join(", ")}.`,
          params: { allowedValues: [...DOC_TYPES] },
        },
        ...(baseOk ? [] : toDetails(baseValidator.errors)),
      ],
    };
  }
  const ok = validator(data);
  return {
    valid: ok,
    errors: ok ? [] : toDetails(validator.errors),
  };
}

function toDetails(errs: ErrorObject[] | null | undefined): ValidationErrorDetail[] {
  if (!errs) return [];
  return errs.map((e) => ({
    instancePath: e.instancePath,
    keyword: e.keyword,
    message: e.message ?? "validation failed",
    params: (e.params as Record<string, unknown>) ?? {},
  }));
}

export { DOC_TYPES };
export type {
  DocType,
  FrontmatterMap,
  ValidationErrorDetail,
  ValidationResult,
} from "./types.js";
