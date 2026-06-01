import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { coreConfig } from "../util/coreConfig.js";
import { save } from "../git/gitService.js";
import {
  generateUlid,
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
  type DocType,
  type FrontmatterMap,
} from "../frontmatter/index.js";
import { FrontmatterValidationError } from "../errors/FrontmatterValidationError.js";

/**
 * Story 12.3 (Epic 12) — `importSkill`: the SHARED core logic that imports an
 * Anthropic-format folder-skill (a `SKILL.md` plus `references/*.md` and
 * `templates/*` companions) into the vault. Consumed by BOTH the PWA upload
 * route AND the MCP import tool — neither re-implements frontmatter injection.
 *
 * Anthropic Agent Skills ship WITHOUT vault frontmatter. The lokyy-vault
 * pre-commit hook rejects any `.md` lacking SPEC-valid frontmatter, so this
 * function injects the right frontmatter per file BEFORE it ever reaches the
 * hook (Epic 12 design decision #3):
 *
 *   - `SKILL.md`           → `type: skill`  (+ skill_name/title/description/
 *                            execution; id/created/updated filled if missing).
 *                            An already-valid `type: skill` block is preserved;
 *                            only missing required fields are back-filled.
 *   - other `.md`          → `type: reference` (+ title; id/created/updated).
 *   - non-`.md` (e.g. .jsx,
 *     .json)               → written VERBATIM (the frontmatter hook only
 *                            inspects `.md`, so templates stay untouched).
 *
 * Every write goes through `gitService.save()` (the canonical add→commit→pull
 * --rebase→push path) — NO direct `fs` write. Re-importing the same skill is an
 * idempotent upsert: `save()` overwrites in place, and for `.md` files an
 * existing on-disk `id`/`created` is preserved so identity is stable on
 * re-import.
 */

/** One file to import, relative to the skill ROOT (e.g. `SKILL.md`). */
export interface ImportSkillFile {
  /**
   * Path relative to the skill directory, POSIX-style. Examples:
   * `"SKILL.md"`, `"references/layout.md"`, `"templates/dashboard.jsx"`.
   */
  relPath: string;
  /** UTF-8 file content (markdown body, JSX source, JSON text, …). */
  content: string;
}

/** Arguments for {@link importSkill}. */
export interface ImportSkillArgs {
  /** Human/source skill name; slugified to a lowercase-kebab directory name. */
  skillName: string;
  /** The skill's files, paths relative to the skill root. */
  files: ImportSkillFile[];
}

/** Result of an import: the (slugified) skill name + the vault paths written. */
export interface ImportSkillResult {
  /** The slugified skill name (the directory under `70_pai/skills/`). */
  skillName: string;
  /** Vault-relative paths actually written, in input order. */
  written: string[];
  /** Reserved for files intentionally not written (currently always empty). */
  skipped: string[];
}

/** Root folder for all skills in the vault (matches `listSkillNotes`). */
const SKILLS_ROOT = "70_pai/skills";

/**
 * Slugify a free-form skill name into a lowercase-kebab token that satisfies
 * the skill schema's `skill_name` pattern (`^[a-z0-9-]+$`). Collapses any run
 * of non-alphanumerics to a single hyphen and trims leading/trailing hyphens.
 */
export function slugifySkillName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "skill";
}

/**
 * Normalize a relPath to POSIX forward slashes and strip any leading slash.
 *
 * Path-traversal guard: the normalized rel is later joined as
 * `${SKILLS_ROOT}/${slug}/${rel}` and written via `save()` → `path.join`, which
 * collapses `..` — so a rel like `../../../50_decisions/evil.md` would escape
 * the skills dir (and, with enough `..`, the vault root). Any `..`/`.`/empty
 * segment is rejected here, in core, so BOTH the HTTP route and the MCP
 * `import_skill` handler are protected (the HTTP `sanitizeRelPath` stays in
 * place as belt-and-suspenders).
 */
function normalizeRel(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = norm.split("/");
  if (segments.some((seg) => seg === ".." || seg === "." || seg === "")) {
    throw new Error(
      `importSkill: illegal relPath "${relPath}" — segments must not be "..", "." or empty (path traversal rejected).`,
    );
  }
  return norm;
}

/** The basename of a relPath (last segment), used for filename fallbacks. */
function baseName(relPath: string): string {
  const parts = normalizeRel(relPath).split("/");
  return parts[parts.length - 1] ?? relPath;
}

/** First Markdown H1 (`# …`) in a body, trimmed; `null` when none present. */
function firstH1(body: string): string | null {
  for (const line of body.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m && m[1].trim().length > 0) return m[1].trim();
  }
  return null;
}

/** First non-blank, non-heading line — a sensible `description` fallback. */
function firstSenseLine(body: string): string | null {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    return line;
  }
  return null;
}

/** A `.md` relPath? (case-insensitive). */
function isMarkdown(relPath: string): boolean {
  return /\.md$/i.test(normalizeRel(relPath));
}

/** Is `relPath` (normalized) the skill's top-level `SKILL.md`? */
function isSkillManifest(relPath: string): boolean {
  return normalizeRel(relPath).toLowerCase() === "skill.md";
}

/** Title fallback from H1 → filename (without `.md`). */
function deriveTitle(body: string, relPath: string): string {
  const h1 = firstH1(body);
  if (h1) return h1;
  return baseName(relPath).replace(/\.md$/i, "");
}

/**
 * Build the SPEC-valid `SKILL.md` content. Existing frontmatter is honored:
 * a valid `type: skill` block is preserved and only missing required fields
 * (id/created/updated) are back-filled. Otherwise a complete skill frontmatter
 * is synthesized. `skill_name` is always forced to the imported (slugified)
 * name so the on-disk skill matches its directory.
 */
function buildSkillContent(
  file: ImportSkillFile,
  slug: string,
  now: string,
  onDisk: FrontmatterMap,
): string {
  const { data, body } = parseFrontmatter(file.content);
  const hasFm = Object.keys(data).length > 0;
  const isSkillFm = hasFm && data.type === "skill";

  // Start from incoming frontmatter when it already declares a skill; else {}.
  const base: FrontmatterMap = isSkillFm ? { ...data } : {};

  const merged: FrontmatterMap = {
    ...base,
    // Identity is stable across re-import: an existing on-disk id/created
    // always wins (upsert), then incoming, then freshly generated.
    id:
      (onDisk.id as string | undefined) ??
      (base.id as string | undefined) ??
      generateUlid(),
    type: "skill",
    title:
      (base.title as string | undefined) ?? deriveTitle(body, file.relPath),
    skill_name: slug,
    description:
      (base.description as string | undefined) ??
      firstSenseLine(body) ??
      `Imported skill ${slug}.`,
    execution: (base.execution as string | undefined) ?? "client",
    created:
      (onDisk.created as string | undefined) ??
      (base.created as string | undefined) ??
      now,
    updated: now,
  };

  return serializeFrontmatter(merged, body);
}

/**
 * Build a SPEC-valid `type: reference` companion-doc content. A non-skill
 * `.md` (Anthropic skills ship reference docs without frontmatter) gets
 * `type: reference` injected; an existing valid block is honored and only
 * id/created/updated are back-filled, `type` forced to `reference`.
 */
function buildReferenceContent(
  file: ImportSkillFile,
  now: string,
  onDisk: FrontmatterMap,
): string {
  const { data, body } = parseFrontmatter(file.content);
  const hasFm = Object.keys(data).length > 0;
  const base: FrontmatterMap = hasFm ? { ...data } : {};

  const merged: FrontmatterMap = {
    ...base,
    id:
      (onDisk.id as string | undefined) ??
      (base.id as string | undefined) ??
      generateUlid(),
    type: "reference",
    title:
      (base.title as string | undefined) ?? deriveTitle(body, file.relPath),
    created:
      (onDisk.created as string | undefined) ??
      (base.created as string | undefined) ??
      now,
    updated: now,
  };

  return serializeFrontmatter(merged, body);
}

/**
 * Read the frontmatter of the file already at `vaultPath`, if any. Used so a
 * re-import preserves the on-disk `id`/`created` (stable identity / upsert).
 * A missing/unreadable file yields `{}` — the first import path.
 */
async function readOnDiskFrontmatter(
  vaultDir: string,
  vaultPath: string,
): Promise<FrontmatterMap> {
  try {
    const raw = await readFile(join(vaultDir, ...vaultPath.split("/")), "utf8");
    return parseFrontmatter(raw).data;
  } catch {
    return {};
  }
}

/** Validate a built `.md`'s frontmatter; throw a typed error on failure. */
function assertValid(content: string, type: DocType, vaultPath: string): void {
  const { data } = parseFrontmatter(content);
  const validation = validateFrontmatter(data, type);
  if (!validation.valid) {
    throw new FrontmatterValidationError({
      message: `Imported skill file "${vaultPath}" produced invalid ${type} frontmatter.`,
      noteId: (data.id as string | undefined) ?? null,
      errors: validation.errors,
    });
  }
}

/**
 * Import an Anthropic-format folder-skill into the vault (Story 12.3).
 *
 * Target layout: `70_pai/skills/<slug>/<relPath>` where `<slug>` is the
 * slugified `skillName`. For each file:
 *   - `SKILL.md`   → frontmatter injected/merged as `type: skill`;
 *   - other `.md`  → frontmatter injected/merged as `type: reference`;
 *   - non-`.md`    → written verbatim (no frontmatter — the hook ignores it).
 *
 * Each file is written through `gitService.save()` (one commit per file via
 * the existing serialized write path). Re-importing the same skill is an
 * idempotent upsert (on-disk `id`/`created` preserved for `.md`).
 *
 * @throws FrontmatterValidationError if a built `.md` would fail SPEC
 *   validation (defensive — should not fire for well-formed inputs).
 * @throws Error if `files` is empty or no `SKILL.md` is present.
 */
export async function importSkill(
  args: ImportSkillArgs,
): Promise<ImportSkillResult> {
  const slug = slugifySkillName(args.skillName);
  if (!args.files || args.files.length === 0) {
    throw new Error(`importSkill("${args.skillName}"): no files supplied.`);
  }
  if (!args.files.some((f) => isSkillManifest(f.relPath))) {
    throw new Error(
      `importSkill("${args.skillName}"): a SKILL.md is required at the skill root.`,
    );
  }

  // `save` itself pulls on its push step; an explicit guard is unnecessary.
  const cfg = coreConfig(); // throws early if core was never initialized

  const now = new Date().toISOString();
  const written: string[] = [];

  for (const file of args.files) {
    const rel = normalizeRel(file.relPath);
    const vaultPath = `${SKILLS_ROOT}/${slug}/${rel}`;

    let content: string;
    if (isSkillManifest(rel)) {
      const onDisk = await readOnDiskFrontmatter(cfg.vaultDir, vaultPath);
      content = buildSkillContent({ ...file, relPath: rel }, slug, now, onDisk);
      assertValid(content, "skill", vaultPath);
    } else if (isMarkdown(rel)) {
      const onDisk = await readOnDiskFrontmatter(cfg.vaultDir, vaultPath);
      content = buildReferenceContent({ ...file, relPath: rel }, now, onDisk);
      assertValid(content, "reference", vaultPath);
    } else {
      // Non-.md (templates/*.jsx, *.json, …) — verbatim; the pre-commit
      // frontmatter hook only inspects `.md`, so these stay byte-for-byte.
      content = file.content;
    }

    await save(vaultPath, content, `skill import: ${slug}/${rel}`);
    written.push(vaultPath);
  }

  return { skillName: slug, written, skipped: [] };
}
