import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { coreConfig } from "../util/coreConfig.js";
import { pull } from "../git/gitService.js";
import { parseFrontmatter } from "../frontmatter/index.js";
import { parseTitle } from "../graph/graphService.js";

/**
 * Loose-ends scanner (Story 11.11).
 *
 * Vault-wide body scan that surfaces every open work item the user left lying
 * around, so the dashboard can show "lose Enden" in one tile. Two signals are
 * collected (O-4 — BOTH, not either/or):
 *
 *   1. Open Markdown checkboxes:  `^\s*[-*] \[ \]` (unchecked task list items).
 *   2. Inline `#todo` tags anywhere in a body line.
 *
 * Walk pattern mirrors `dataview.walk` / `graphService` (skip hidden dirs,
 * `.md` only). This is a potentially expensive full-text pass, so it lives on
 * its OWN lazy endpoint (`GET /api/dashboard/loose-ends`), honors a `limit`
 * (default 50), and is memoized in-process for 60s — never folded into the
 * synchronous `/api/dashboard` summary.
 *
 * READ-ONLY: pulls first (Forgejo is the truth) then reads files; never writes.
 *
 * [Source: epic-11-architecture-addendum.md §5; Story 11.11 AC#4 / O-4]
 */

/** One open work item found in a note body. */
export interface LooseEnd {
  /** Note id (vault-relative path without `.md`). */
  noteId: string;
  /** Note display title (frontmatter `title` → H1 → filename). */
  title: string;
  /** 1-based line number of the match within the body (frontmatter excluded). */
  line: number;
  /** Trimmed text of the matching line. */
  text: string;
}

/** Result of a loose-ends scan: the (capped) items plus the true total found. */
export interface LooseEndsResult {
  items: LooseEnd[];
  /** Total matches across the vault BEFORE the `limit` cap. */
  total: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const CACHE_TTL_MS = 60_000;

/**
 * Folders excluded from the scan. Captures + the trash are inbox/archive zones,
 * not the user's active working notes — their stray checkboxes are noise on a
 * "loose ends" tile. (Optional per AC#4; we apply it as the sensible default.)
 */
const EXCLUDED_PREFIXES = ["30_captures/", ".trash/"];

/** Open Markdown task checkbox at line start (allowing leading indent). */
const OPEN_CHECKBOX_RE = /^\s*[-*]\s\[ \]/;
/** Inline `#todo` tag (word-boundary so `#todone`/`#todos` don't false-match). */
const TODO_TAG_RE = /(^|[^\w/#])#todo(?![\w/-])/i;

interface CacheEntry {
  expires: number;
  result: LooseEndsResult;
}
/**
 * Memo keyed by `vaultDir::limit` — different caps are different result sets,
 * and the vault path keys the entry so a hot-swapped vault (or a test asserting
 * a fresh vault) never reads a stale cross-vault result.
 */
const cache = new Map<string, CacheEntry>();

/** Same walk pattern as graphService / dataview — skips hidden dirs. */
async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function isExcluded(id: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => id === p.replace(/\/$/, "") || id.startsWith(p));
}

/**
 * Scan the vault for open checkboxes + `#todo` tags.
 *
 * Returns up to `limit` items (stable order: by note id, then line number) and
 * the true `total` across the whole vault. `limit` is clamped to `[1, 500]`;
 * a non-finite/non-positive value falls back to the default (50). Memoized for
 * 60s per `limit`.
 */
export async function looseEnds(limit = DEFAULT_LIMIT): Promise<LooseEndsResult> {
  const cap =
    Number.isFinite(limit) && limit > 0
      ? Math.min(MAX_LIMIT, Math.floor(limit))
      : DEFAULT_LIMIT;

  const now = Date.now();
  const c = coreConfig();
  const cacheKey = `${c.vaultDir}::${cap}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > now) return hit.result;

  await pull();
  const files = await walk(c.vaultDir);

  const items: LooseEnd[] = [];
  let total = 0;

  for (const abs of files) {
    const relPath = relative(c.vaultDir, abs).split(sep).join("/");
    const id = relPath.replace(/\.md$/, "");
    if (isExcluded(id)) continue;

    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      continue; // unreadable note — skip, never break the scan
    }

    const { data, body } = parseFrontmatter(raw);
    const title =
      typeof data.title === "string" && data.title.trim()
        ? data.title
        : parseTitle(body, relPath);

    // Line numbers are relative to the BODY (frontmatter stripped by
    // parseFrontmatter) — that's the user-meaningful line for a captured todo.
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      const isCheckbox = OPEN_CHECKBOX_RE.test(lineText);
      const hasTodo = TODO_TAG_RE.test(lineText);
      if (!isCheckbox && !hasTodo) continue;

      total += 1;
      if (items.length < cap) {
        items.push({
          noteId: id,
          title,
          line: i + 1,
          text: lineText.trim(),
        });
      }
    }
  }

  // Stable order: group by note, then by line within the note.
  items.sort(
    (a, b) => a.noteId.localeCompare(b.noteId) || a.line - b.line,
  );

  const result: LooseEndsResult = { items, total };
  cache.set(cacheKey, { expires: now + CACHE_TTL_MS, result });
  return result;
}
