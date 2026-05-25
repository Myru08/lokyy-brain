import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { coreConfig } from "../util/coreConfig.js";
import { pull } from "../git/gitService.js";

/**
 * Templates service.
 *
 * Reusable note templates live as plain .md files under `00_meta/templates/`
 * in the vault. Templates do not require frontmatter — they are a *body*
 * fragment that the PWA fills in (variables like `{{date}}`, `{{title}}`,
 * `{{user}}`, `{{id}}`) and then feeds into the normal `createNote` flow,
 * which adds SPEC-valid frontmatter.
 *
 * Discovery is intentionally NOT recursive: only direct children of
 * `00_meta/templates/` are surfaced. This keeps the model simple and avoids
 * accidental inclusion of nested vault content.
 */

const TEMPLATES_DIR = "00_meta/templates";

/** Lightweight summary of a template — what the picker shows. */
export interface TemplateRef {
  /** Filename without `.md`. */
  name: string;
  /** Path inside the vault, e.g. `00_meta/templates/meeting.md`. */
  path: string;
  /** First ~80 chars of the body (frontmatter stripped, single-line). */
  preview: string;
}

/** Strip a leading YAML frontmatter block, if any. */
function stripFrontmatter(body: string): string {
  return body.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** Single-line preview, max 80 chars, frontmatter stripped. */
function buildPreview(body: string): string {
  const stripped = stripFrontmatter(body)
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 80 ? stripped.slice(0, 80) : stripped;
}

/**
 * List all templates in `00_meta/templates/`. Pulls first — Forgejo is the
 * truth. Returns alphabetically sorted by name.
 */
export async function listTemplates(): Promise<TemplateRef[]> {
  await pull();
  const c = coreConfig();
  const absDir = join(c.vaultDir, TEMPLATES_DIR);

  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    // Directory does not exist yet — no templates.
    return [];
  }

  const refs: TemplateRef[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (!entry.endsWith(".md")) continue;
    const abs = join(absDir, entry);
    const st = await stat(abs);
    if (!st.isFile()) continue;
    const body = await readFile(abs, "utf8");
    refs.push({
      name: entry.replace(/\.md$/, ""),
      path: `${TEMPLATES_DIR}/${entry}`,
      preview: buildPreview(body),
    });
  }
  refs.sort((a, b) => a.name.localeCompare(b.name));
  return refs;
}

/**
 * Fetch a single template's full body by name (filename without `.md`).
 * Returns `null` if not found. Pulls first.
 */
export async function getTemplate(
  name: string,
): Promise<{ name: string; body: string } | null> {
  // Defensive — name is a path segment, not a path. Reject separators.
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }
  await pull();
  const c = coreConfig();
  const abs = join(c.vaultDir, TEMPLATES_DIR, `${name}.md`);
  try {
    await stat(abs);
  } catch {
    return null;
  }
  const body = await readFile(abs, "utf8");
  return { name, body };
}
