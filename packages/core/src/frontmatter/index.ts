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
import peerSchema from "./schemas/peer.json" with { type: "json" };
import skillSchema from "./schemas/skill.json" with { type: "json" };
// Epic 10 / Story 10.15 — extended type enum (tool / resource / reference).
import toolSchema from "./schemas/tool.json" with { type: "json" };
import resourceSchema from "./schemas/resource.json" with { type: "json" };
import referenceSchema from "./schemas/reference.json" with { type: "json" };

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
  ["peer", ajv.compile(peerSchema as object)],
  ["skill", ajv.compile(skillSchema as object)],
  ["tool", ajv.compile(toolSchema as object)],
  ["resource", ajv.compile(resourceSchema as object)],
  ["reference", ajv.compile(referenceSchema as object)],
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
 * Recursively drop `undefined` values from an object/array tree. Returned
 * shape is structurally identical for fully-defined inputs (same keys, same
 * order, same primitive identity) so downstream YAML output stays
 * byte-identical for callers that never had undefineds in the first place.
 *
 * Why: `js-yaml`'s `dump` (used by `gray-matter` internally) throws
 * `unacceptable kind of an object to dump [object Undefined]` whenever a
 * map value is `undefined`. Helper paths like `captureEncodingContext`
 * intentionally produce partial objects with undefined sub-fields (the
 * JSON-Schema validator accepts the gaps via `additionalProperties`), so
 * we strip them just-in-time before serialization. Defense in depth —
 * frontend callers SHOULD avoid sending undefineds too, but a single
 * forgotten field shouldn't crash a save.
 *
 * Behaviour notes:
 *   - `null` is preserved (it's a valid YAML value, distinct from absent).
 *   - Arrays are recursed into; an explicit `undefined` slot becomes `null`
 *     (matches js-yaml's array semantics — arrays can't have "holes" in
 *     YAML maps the way objects can omit keys).
 *   - Nested objects are recursed into so an undefined sub-field on
 *     `encoded.app_state` is dropped without losing siblings.
 */
function stripUndefined<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) =>
      v === undefined ? null : stripUndefined(v),
    ) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = stripUndefined(v);
  }
  return out as T;
}

/**
 * Serialize a frontmatter map + body back to a Markdown document with a
 * YAML `---` frontmatter block. Preserves key order from `data`.
 *
 * Undefined values are stripped recursively before handing off to
 * `gray-matter`/`js-yaml`, which would otherwise throw
 * `unacceptable kind of an object to dump [object Undefined]`. For
 * fully-populated inputs this is a no-op and produces byte-identical
 * output to the previous implementation.
 */
export function serializeFrontmatter(
  data: FrontmatterMap,
  body: string,
): string {
  return matter.stringify(body, stripUndefined(data));
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

export { DOC_TYPES, PEER_TYPES, isPeerType, isForgotten } from "./types.js";
export type {
  DocType,
  FrontmatterMap,
  NotePrivacy,
  BaseFrontmatter,
  ValidationErrorDetail,
  ValidationResult,
  // Phase B Wave B3 / Story 1 — Encoding-Context-Match-Boost (Tulving 1973).
  EncodedContext,
  DeviceType,
  TimeOfDay,
  Weekday,
  // Phase C Wave C2 / Story 3 — Honcho peer abstraction.
  PeerType,
  PeerFrontmatter,
} from "./types.js";
