import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import {
  parseFrontmatter,
  validateFrontmatter,
  type FrontmatterMap,
} from "../frontmatter/index.js";
import { FrontmatterValidationError } from "../errors/FrontmatterValidationError.js";
import skillSchema from "../frontmatter/schemas/skill.json" with { type: "json" };

/**
 * Skill parser + token-renderer for `@lokyy/core` (Epic 9 / Story 9-2).
 *
 * A skill-note (`type: skill`) is a reusable prompt definition with an
 * execution target and an advisory `allowed_tools` list. This module is the
 * canonical surface the MCP layer (9-3) consumes to list skills and produce
 * filled prompts — it never implements parsing/validation itself.
 *
 * Everything here is a pure function (or a plain vault file-read). No
 * network, no LLM calls (PRD Q-Anti).
 */

/** Where a skill runs. Phase 1 only executes `client`. */
export type SkillExecution = "client" | "server";

/** Optional output hint a skill carries (folder/type/path_pattern). */
export interface SkillOutput {
  folder?: string;
  type?: string;
  path_pattern?: string;
  [key: string]: unknown;
}

/**
 * A companion `.md` reference doc that travels with a folder-skill (Anthropic
 * Agent Skills format, Epic 12). `path` is relative to the vault root; `title`
 * comes from the file's frontmatter `title` when present, else the filename.
 */
export interface SkillReference {
  path: string;
  title: string;
}

/**
 * A companion template file that travels with a folder-skill. Any extension
 * (e.g. `.jsx`, `.json`) — non-`.md` templates are not Vault-Contract notes.
 * `path` is relative to the vault root.
 */
export interface SkillTemplate {
  path: string;
}

/**
 * A typed skill definition parsed from a `type: skill` note. `prompt` is the
 * Markdown body below the frontmatter (the template that `renderPrompt`
 * substitutes tokens into).
 */
export interface SkillDef {
  skill_name: string;
  title: string;
  description: string;
  execution: SkillExecution;
  allowed_tools: string[];
  input_schema?: Record<string, unknown>;
  output?: SkillOutput;
  prompt: string;
  /**
   * Path of the skill (relative to the vault root). For a folder-skill this is
   * the skill DIRECTORY (`70_pai/skills/<name>`); for a single-note skill it is
   * the note path (`70_pai/skills/<name>.md`). Optional — populated by
   * `listSkillNotes` (file I/O), never by `parseSkill` (pure). (Epic 12)
   */
  basePath?: string;
  /**
   * Companion reference docs under `<skillDir>/references/` (folder-skills
   * only; empty/undefined for single-note skills). Progressive disclosure:
   * paths only — the body is loaded on demand via read_note. (Epic 12)
   */
  references?: SkillReference[];
  /**
   * Companion template files under `<skillDir>/templates/` (folder-skills
   * only; empty/undefined for single-note skills). (Epic 12)
   */
  templates?: SkillTemplate[];
}

/**
 * Parse a raw skill-note (frontmatter + body) into a typed `SkillDef`.
 * Validates the frontmatter against the `skill` schema; throws a typed
 * `FrontmatterValidationError` on failure so callers can distinguish a bad
 * skill from a generic error.
 */
export function parseSkill(raw: string): SkillDef {
  const { data, body } = parseFrontmatter(raw);
  const validation = validateFrontmatter(data, "skill");
  if (!validation.valid) {
    throw new FrontmatterValidationError({
      message: "Skill frontmatter failed validation.",
      noteId: (data.id as string | undefined) ?? null,
      errors: validation.errors,
    });
  }

  const execution: SkillExecution =
    (data.execution as SkillExecution | undefined) ?? "client";
  const allowed_tools = Array.isArray(data.allowed_tools)
    ? (data.allowed_tools as unknown[]).map(String)
    : [];

  return {
    skill_name: data.skill_name as string,
    title: data.title as string,
    description: data.description as string,
    execution,
    allowed_tools,
    ...(data.input_schema !== undefined
      ? { input_schema: data.input_schema as Record<string, unknown> }
      : {}),
    ...(data.output !== undefined
      ? { output: data.output as SkillOutput }
      : {}),
    prompt: body,
  };
}

/** Token pattern — `{{ key }}` / `{{key}}` / `{{ foo.bar }}`. */
const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Render a skill's prompt by substituting `{{token}}` against a flat context
 * built from (input params after `input_schema` defaults) + built-ins
 * (`today`, `user`, `vault_root`). Unknown tokens are left verbatim. No
 * conditionals/loops — a single regex replace (PRD Q1).
 */
export function renderPrompt(
  skill: SkillDef,
  input?: Record<string, unknown>,
): string {
  const { value } = validateSkillInput(skill, input);
  const context: Record<string, unknown> = {
    ...value,
    today: new Date().toISOString().slice(0, 10),
    user: input?.user ?? value.user ?? "",
    vault_root: input?.vault_root ?? value.vault_root ?? "",
  };

  return skill.prompt.replace(TOKEN_RE, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      const v = context[key];
      return v === undefined || v === null ? match : String(v);
    }
    return match;
  });
}

interface InputProperty {
  type?: string;
  required?: boolean;
  default?: unknown;
}

/** Extract the `properties` map from a skill's `input_schema`, if any. */
function inputProperties(skill: SkillDef): Record<string, InputProperty> {
  const schema = skill.input_schema;
  if (!schema || typeof schema !== "object") return {};
  const props = (schema as Record<string, unknown>).properties;
  if (props && typeof props === "object") {
    return props as Record<string, InputProperty>;
  }
  // Tolerate a flat `input_schema` where keys ARE the params (no nested
  // `properties` wrapper) — common in hand-written skill notes.
  return schema as Record<string, InputProperty>;
}

/** JSON-Schema-ish `required` array, if the schema uses the nested form. */
function requiredList(skill: SkillDef): string[] {
  const schema = skill.input_schema as Record<string, unknown> | undefined;
  const req = schema?.required;
  return Array.isArray(req) ? (req as unknown[]).map(String) : [];
}

function typeOfValue(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/**
 * Validate `input` against the skill's `input_schema` (type + required) and
 * return the filled `value` (defaults applied for absent keys). `ok` is false
 * with `errors` populated when a required field is missing or a present
 * field has the wrong primitive type.
 */
export function validateSkillInput(
  skill: SkillDef,
  input?: Record<string, unknown>,
): { ok: boolean; errors?: string[]; value: Record<string, unknown> } {
  const props = inputProperties(skill);
  const required = new Set(requiredList(skill));
  const supplied = input ?? {};
  const value: Record<string, unknown> = {};
  const errors: string[] = [];

  // Carry through any supplied keys (even ones not in the schema — the schema
  // is advisory; extra params are still usable as tokens).
  for (const [k, v] of Object.entries(supplied)) {
    value[k] = v;
  }

  for (const [key, spec] of Object.entries(props)) {
    const isRequired = required.has(key) || spec?.required === true;
    const present = Object.prototype.hasOwnProperty.call(supplied, key);

    if (!present) {
      if (spec && Object.prototype.hasOwnProperty.call(spec, "default")) {
        value[key] = spec.default;
        continue;
      }
      if (isRequired) {
        errors.push(`Missing required input "${key}".`);
      }
      continue;
    }

    if (spec?.type) {
      const actual = typeOfValue(supplied[key]);
      const expected =
        spec.type === "integer" || spec.type === "number"
          ? "number"
          : spec.type;
      if (actual !== expected) {
        errors.push(
          `Input "${key}" expected type ${spec.type}, got ${actual}.`,
        );
      }
    }
  }

  return errors.length > 0
    ? { ok: false, errors, value }
    : { ok: true, value };
}

/** Recursively collect all `.md` file paths under `dir` (skip dot-dirs). */
async function walkMarkdown(dir: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc; // dir does not exist — nothing to list
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkMarkdown(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

/** List immediate child file paths of `dir` (non-recursive; skip dot-files). */
async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // dir does not exist — nothing to list
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile()) out.push(join(dir, entry.name));
  }
  return out;
}

/** A vault-root-relative path with forward slashes (stable across platforms). */
function toVaultRelative(vaultRoot: string, absPath: string): string {
  return relative(vaultRoot, absPath).split(sep).join("/");
}

/**
 * Collect the `references/` (`.md`, title from frontmatter or filename) and
 * `templates/` (any extension) companion files of a folder-skill directory.
 * Pure file I/O — returns vault-relative paths. Missing subdirs yield [].
 */
async function collectSkillStructure(
  vaultRoot: string,
  skillDir: string,
): Promise<{ references: SkillReference[]; templates: SkillTemplate[] }> {
  const references: SkillReference[] = [];
  for (const file of await listFiles(join(skillDir, "references"))) {
    if (!file.endsWith(".md")) continue;
    let title = basename(file, ".md");
    try {
      const { data } = parseFrontmatter(await readFile(file, "utf8"));
      if (typeof data.title === "string" && data.title.trim().length > 0) {
        title = data.title;
      }
    } catch {
      // unreadable/invalid reference → fall back to filename title
    }
    references.push({ path: toVaultRelative(vaultRoot, file), title });
  }

  const templates: SkillTemplate[] = (
    await listFiles(join(skillDir, "templates"))
  ).map((file) => ({ path: toVaultRelative(vaultRoot, file) }));

  return { references, templates };
}

/**
 * List all skills under a vault root (Epic 12). A skill is either:
 *   - a FOLDER skill: `<dir>/SKILL.md` (`type: skill`) → the DIRECTORY is the
 *     skill; its `references/` + `templates/` companions are collected and
 *     `basePath` points at the directory; or
 *   - a SINGLE-NOTE skill: any other `<name>.md` with `type: skill` → as before,
 *     `references`/`templates` left undefined and `basePath` is the note path.
 *
 * Companion `.md` docs (e.g. `references/foo.md` with `type: reference`) are not
 * `type: skill`, so they are never loaded as standalone skills. A skill that
 * fails to parse/validate is skipped with a logged warning — this NEVER throws
 * because of a single broken skill (AC#3, preserved from Story 9-2).
 */
export async function listSkillNotes(vaultRoot: string): Promise<SkillDef[]> {
  // Prefer the conventional `70_pai/skills/` subtree when present; otherwise
  // fall back to walking the whole vault root.
  const skillsDir = join(vaultRoot, "70_pai", "skills");
  let files = await walkMarkdown(skillsDir);
  if (files.length === 0) {
    files = await walkMarkdown(vaultRoot);
  }

  const skills: SkillDef[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      console.warn(
        `[listSkillNotes] could not read ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    // Cheap pre-filter: only attempt to parse notes that declare `type: skill`.
    // Companion `references/*.md` carry `type: reference`, so they fall out here
    // and never become their own skill (Epic 12 discovery hygiene).
    const { data } = parseFrontmatter(raw);
    if (data.type !== "skill") continue;

    let skill: SkillDef;
    try {
      skill = parseSkill(raw);
    } catch (err) {
      console.warn(
        `[listSkillNotes] skipping invalid skill ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    // A `type: skill` note named `SKILL.md` denotes a FOLDER skill — its parent
    // directory IS the skill; collect references/templates and set basePath to
    // the directory. Any other `<name>.md` is a single-note skill (basePath =
    // the note path, no companions). The SKILL.md itself is only enumerated
    // once by the walk, so it never double-appears as a child skill.
    if (basename(file) === "SKILL.md") {
      const skillDir = dirname(file);
      const { references, templates } = await collectSkillStructure(
        vaultRoot,
        skillDir,
      );
      skill.basePath = toVaultRelative(vaultRoot, skillDir);
      skill.references = references;
      skill.templates = templates;
    } else {
      skill.basePath = toVaultRelative(vaultRoot, file);
    }

    skills.push(skill);
  }
  return skills;
}

/* ------------------------------------------------------------------ *
 *  Story 10.5 — get_skill_schema()
 *
 *  An agent that wants to author a skill needs the REAL skill-frontmatter
 *  schema PLUS a working example PLUS per-field docs, so it can create a
 *  valid skill in a SINGLE create_note({ type: "skill", ... }) call instead
 *  of guessing the shape by trial & error. The MCP `get_skill_schema()` tool
 *  (Agent C) returns this object verbatim.
 *
 *  No new template system is invented (AC#5): the example below is parsed by
 *  the SAME `parseSkill`/`validateSkillInput` the runtime uses, and the
 *  `{{var}}` substitution it shows is exactly what `renderPrompt` performs.
 * ------------------------------------------------------------------ */

/** One field's short doc (whether required + a one-line description). */
export interface SkillFieldDoc {
  field: string;
  required: boolean;
  description: string;
}

/** Return shape of `getSkillSchema()`. */
export interface SkillSchemaInfo {
  /** The actual `frontmatter/schemas/skill.json` JSON-Schema object. */
  schema: Record<string, unknown>;
  /** A complete, schema-valid example skill note (frontmatter + body). */
  example: string;
  /** Per-field docs for the skill frontmatter (required + optional fields). */
  fieldDocs: SkillFieldDoc[];
}

/**
 * A complete example skill note. It is schema-valid AND parses via
 * `parseSkill`; the test `getSkillSchema()` proves both. The body uses the
 * `{{var}}` tokens that `renderPrompt` substitutes (`{{today}}` is a built-in;
 * `{{topic}}`/`{{days}}` come from `input_schema`), so the example doubles as
 * a live demonstration of the substitution engine (AC#2).
 */
const EXAMPLE_SKILL = `---
id: 01JXYZABCDEFGHJKMNPQRSTVWX
type: skill
title: Weekly Review
skill_name: weekly-review
description: Summarize the last N days of notes on a topic.
execution: client
allowed_tools:
  - search_vault
  - read_note
input_schema:
  properties:
    days:
      type: integer
      default: 7
    topic:
      type: string
created: "2026-05-24T10:00:00.000Z"
updated: "2026-05-24T10:00:00.000Z"
---
Review the last {{days}} days of notes about {{topic}} (today is {{today}}).
Cite related notes via [[wikilinks]].
`;

/** Required-field docs (the schema's `required` array). */
const REQUIRED_FIELD_DOCS: SkillFieldDoc[] = [
  { field: "id", required: true, description: "ULID (26 chars). Use create_note to have it generated." },
  { field: "type", required: true, description: 'Must be the literal "skill".' },
  { field: "title", required: true, description: "Human-readable title (non-empty)." },
  { field: "skill_name", required: true, description: "Stable machine name, lowercase + digits + hyphens (^[a-z0-9-]+$). The handle run_skill uses." },
  { field: "description", required: true, description: "One-line description of what the skill does (non-empty)." },
  { field: "created", required: true, description: "ISO-8601 creation timestamp." },
  { field: "updated", required: true, description: "ISO-8601 last-modified timestamp." },
];

/** Optional-field docs. */
const OPTIONAL_FIELD_DOCS: SkillFieldDoc[] = [
  { field: "execution", required: false, description: "'client' | 'server' (default 'client'). Phase 1 only runs 'client'; 'server' is schema-valid but rejected at runtime by run_skill." },
  { field: "input_schema", required: false, description: "JSON-Schema-ish object describing prompt params. Its keys become {{tokens}} substituted by run_skill (renderPrompt); supports `default` and `required`." },
  { field: "allowed_tools", required: false, description: "Advisory list of vault tools the skill expects (not enforced in Phase 1)." },
  { field: "output", required: false, description: "Optional output hint { folder, type, path_pattern } for notes the skill produces." },
  { field: "tags", required: false, description: "Optional free-form tag list." },
];

/**
 * Return the official skill frontmatter schema, a working example, and
 * per-field docs (Story 10.5, AC#1). Pure — no I/O. The `schema` is the live
 * `skill.json` (no re-invented schema); the `example` is parseable via
 * `parseSkill`/`validateSkillInput` (proven by the unit test, AC#3); the
 * `fieldDocs` note that `input_schema` keys become `{{var}}` tokens that
 * `renderPrompt` substitutes (AC#2).
 */
export function getSkillSchema(): SkillSchemaInfo {
  return {
    schema: skillSchema as Record<string, unknown>,
    example: EXAMPLE_SKILL,
    fieldDocs: [...REQUIRED_FIELD_DOCS, ...OPTIONAL_FIELD_DOCS],
  };
}
