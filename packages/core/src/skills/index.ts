import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseFrontmatter,
  validateFrontmatter,
  type FrontmatterMap,
} from "../frontmatter/index.js";
import { FrontmatterValidationError } from "../errors/FrontmatterValidationError.js";

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

/**
 * List all `type: skill` notes under a vault root (searched recursively;
 * skills primarily live in `70_pai/skills/` but any path is honored). A
 * skill that fails to parse/validate is skipped with a logged warning —
 * this NEVER throws because of a single broken skill (AC#3).
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
    const { data } = parseFrontmatter(raw);
    if (data.type !== "skill") continue;
    try {
      skills.push(parseSkill(raw));
    } catch (err) {
      console.warn(
        `[listSkillNotes] skipping invalid skill ${file}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return skills;
}
