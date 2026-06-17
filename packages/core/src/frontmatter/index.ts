import matter from "gray-matter";
import { ulid as ulidFn } from "ulid";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  type AnyDocType,
  type FrontmatterMap,
  type ValidationErrorDetail,
  type ValidationResult,
} from "./types.js";

import {
  DEFAULT_VAULT_PROFILE,
  getProfileSpec,
  type VaultProfile,
  type VaultProfileSpec,
} from "./profiles.js";

import baseSchema from "./schemas/base.json" with { type: "json" };

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

/**
 * Per-profile compiled-validator maps (Story S2 / B1). Each profile's schema
 * set is compiled lazily once and memoized. The `para` profile reproduces the
 * exact validator set that previously lived inline here, so PARA validation is
 * bit-identical. `karpathy` carries the RAW/Wiki/Outputs validators.
 */
const profileValidators = new Map<VaultProfile, Map<string, ValidateFunction>>();

function validatorsFor(spec: VaultProfileSpec): Map<string, ValidateFunction> {
  let map = profileValidators.get(spec.profile);
  if (!map) {
    map = new Map<string, ValidateFunction>();
    for (const [type, schema] of Object.entries(spec.schemas)) {
      map.set(type, ajv.compile(schema));
    }
    profileValidators.set(spec.profile, map);
  }
  return map;
}

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
 * Validate a parsed frontmatter map against the schema for `type`, in the
 * given SPEC-profile. Returns `{ valid, errors }`. Callers that throw on
 * invalid input should use `FrontmatterValidationError`.
 *
 * Story S2 / B1 — the optional `profile` argument selects the active SPEC
 * profile; it defaults to `"para"` so EVERY existing call-site
 * (`validateFrontmatter(data, type)`) keeps its exact previous behaviour and
 * server/mcp run without changes. Pass `"karpathy"` to validate against the
 * RAW/Wiki/Outputs schema set.
 *
 * If `type` is not a known doc type IN THE ACTIVE PROFILE, falls back to the
 * base schema and adds a synthetic error listing the profile's allowed types
 * so the caller still gets a typed signal.
 */
export function validateFrontmatter(
  data: FrontmatterMap,
  type: AnyDocType,
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): ValidationResult {
  const spec = getProfileSpec(profile);
  const validator = validatorsFor(spec).get(type);
  if (!validator) {
    const baseOk = baseValidator(data);
    const allowed = spec.docTypes;
    return {
      valid: false,
      errors: [
        {
          instancePath: "/type",
          keyword: "enum",
          message: `Unknown doc type "${String(type)}" for profile "${spec.profile}". Expected one of: ${allowed.join(", ")}.`,
          params: { allowedValues: [...allowed] },
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

export {
  DOC_TYPES,
  // Story S2 — Karpathy-Profil-Typen (RAW/Wiki/Outputs).
  KARPATHY_DOC_TYPES,
  PEER_TYPES,
  isPeerType,
  isForgotten,
} from "./types.js";
export type {
  DocType,
  // Story S2 — Karpathy + cross-profile type unions.
  KarpathyDocType,
  AnyDocType,
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

// Story S2 / B1 — Vault-SPEC-Profil-Registry (para / karpathy).
export {
  VAULT_PROFILES,
  DEFAULT_VAULT_PROFILE,
  KARPATHY_TYPE_FOLDER,
  isVaultProfile,
  getProfileSpec,
  resolveVaultProfile,
  type VaultProfile,
  type VaultProfileSpec,
} from "./profiles.js";
