import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { coreConfig } from "../util/coreConfig.js";
import { pull } from "../git/gitService.js";
import { parseFrontmatter } from "../frontmatter/index.js";
import { parseTags, parseTitle } from "../graph/graphService.js";

/**
 * Dataview-like query engine for lokyy-brain.
 *
 * Parses every .md file's frontmatter, filters by `from` (folder prefix) and
 * `where` (equality + special `tag` membership), projects `select` columns,
 * sorts and limits. Closed list of supported keys — full Obsidian DQL is
 * deliberately out of scope (KISS). See `pwa/src/editor/dataviewWidget.ts`
 * for the rendering side.
 */

export interface DataviewQuery {
  from?: string;
  where?: Record<string, unknown>;
  select?: string[];
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
}

export type DataviewRow = Record<string, string | number | boolean | null>;

const DEFAULT_SELECT = ["title", "type", "updated"];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Same walk pattern as graphService / notesService — skips hidden dirs. */
async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

/**
 * Read a .md file and return the projection needed for filtering + select.
 * Returns null if frontmatter is unreadable — the file is then skipped.
 */
interface NoteRecord {
  id: string;
  folder: string;
  title: string;
  inlineTags: string[];
  frontmatter: Record<string, unknown>;
}

async function readNoteRecord(
  abs: string,
  vaultDir: string,
): Promise<NoteRecord | null> {
  const relPath = relative(vaultDir, abs).split(sep).join("/");
  const id = relPath.replace(/\.md$/, "");
  const folder = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title
      : parseTitle(body, relPath);
  return {
    id,
    folder,
    title,
    inlineTags: parseTags(body),
    frontmatter: (data as Record<string, unknown>) ?? {},
  };
}

/**
 * Check a single `where` clause against a note. The special key `tag` means
 * "must include this tag" — checked against frontmatter `tags` (if array)
 * AND inline `#tag` membership. All other keys are equality comparisons
 * against frontmatter scalars (string/number/boolean), with `id` and
 * `title` available as synthetic fields.
 */
function matchesWhere(rec: NoteRecord, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "tag") {
      if (typeof expected !== "string") return false;
      const fmTags = rec.frontmatter.tags;
      const fmList = Array.isArray(fmTags)
        ? fmTags.filter((t): t is string => typeof t === "string")
        : [];
      const all = new Set<string>([...fmList, ...rec.inlineTags]);
      if (!all.has(expected)) return false;
      continue;
    }
    const actual = getField(rec, key);
    if (actual !== expected) return false;
  }
  return true;
}

/** Resolve a field name against a NoteRecord — synthetic id/title win. */
function getField(rec: NoteRecord, key: string): unknown {
  if (key === "id") return rec.id;
  if (key === "title") return rec.title;
  return rec.frontmatter[key];
}

/** Coerce arbitrary frontmatter values to the row's allowed scalar set. */
function toRowValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  if (v instanceof Date) return v.toISOString();
  // Arrays / objects — flatten to JSON so they're still visible in the table.
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Stable comparator on a single field — handles strings, numbers, nullish. */
function compareValues(
  a: string | number | boolean | null,
  b: string | number | boolean | null,
): number {
  if (a === b) return 0;
  if (a === null) return 1; // nulls last
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Run a Dataview query against the vault. Pulls first so the result reflects
 * the latest committed state (Forgejo is the truth).
 */
export async function queryNotes(query: DataviewQuery): Promise<DataviewRow[]> {
  await pull();
  const c = coreConfig();
  const files = await walk(c.vaultDir);

  const select = query.select && query.select.length > 0 ? query.select : DEFAULT_SELECT;
  const sortField = query.sort ?? "title";
  const order = query.order === "desc" ? "desc" : "asc";
  const limit = Math.max(1, Math.min(MAX_LIMIT, query.limit ?? DEFAULT_LIMIT));
  const from = query.from?.replace(/\/+$/, "") ?? "";
  const where = query.where ?? {};

  const records: NoteRecord[] = [];
  for (const abs of files) {
    const rec = await readNoteRecord(abs, c.vaultDir);
    if (!rec) continue;
    if (from) {
      // Folder-prefix match: either the note sits exactly at `from/...` or
      // its id itself starts with `from/`. We don't match partial segment
      // names — `20_proj` must not match `20_projects`.
      const inFolder = rec.id === from || rec.id.startsWith(from + "/");
      if (!inFolder) continue;
    }
    if (!matchesWhere(rec, where)) continue;
    records.push(rec);
  }

  // Sort first, then project, then slice — sorting on the source record
  // keeps the comparator working against the raw typed value rather than
  // the stringified row form.
  records.sort((a, b) => {
    const av = toRowValue(getField(a, sortField));
    const bv = toRowValue(getField(b, sortField));
    const cmp = compareValues(av, bv);
    return order === "desc" ? -cmp : cmp;
  });

  const sliced = records.slice(0, limit);
  return sliced.map((rec) => {
    const row: DataviewRow = {};
    for (const col of select) {
      row[col] = toRowValue(getField(rec, col));
    }
    // Always guarantee `id` and `title` so the widget can dispatch
    // lokyy-open-link on row click even if the user didn't select them.
    if (!("id" in row)) row.id = rec.id;
    if (!("title" in row)) row.title = rec.title;
    return row;
  });
}
