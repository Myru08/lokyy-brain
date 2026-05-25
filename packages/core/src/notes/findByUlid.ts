import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { coreConfig } from "../util/coreConfig.js";
import { parseFrontmatter, type FrontmatterMap } from "../frontmatter/index.js";
import { parseTitle } from "../graph/graphService.js";

/**
 * ID-Badge / AI-Prompt feature — resolve a note by its frontmatter ULID.
 *
 * Every lokyy-vault note carries a stable ULID in its frontmatter (see
 * `frontmatter/index.ts`). The standard `getNote(id)` lookup keys by path
 * (e.g. `30_captures/youtube/foo`), which changes on rename/move. The
 * ULID is the only truly stable handle — share it in an "AI prompt" copy
 * from the editor and a downstream MCP-equipped AI can resolve it back
 * to a note via `findByUlid(ulid)` no matter where the note has moved.
 *
 * Implementation: walks the vault, parses each `.md`'s frontmatter, picks
 * the matching `id`. Result is cached in-process for 60s to keep repeated
 * lookups cheap; any write through `notesService` (create / save / move /
 * delete) must call `invalidateUlidCache()` so stale paths never surface.
 */

/** Crockford-base32, 26 chars, no I/L/O/U. The ULID library guarantees this. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Returned to callers; identical shape MCP `resolve_by_id` returns. */
export interface ResolvedNote {
  /** Frontmatter ULID — same as the query. */
  id: string;
  /** Vault-relative path WITHOUT `.md` (e.g. `30_captures/youtube/foo`). */
  path: string;
  /** Title from frontmatter (or first `#` heading, or filename). */
  title: string;
  /** Markdown body INCLUDING frontmatter block. */
  body: string;
  /** Parsed frontmatter as-is. */
  frontmatter: FrontmatterMap;
}

interface CacheEntry {
  result: ResolvedNote | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * Drop all cached entries. Called by `notesService.createNote`,
 * `saveNote`, `moveEntry`, `deleteEntry` so a freshly written note is
 * immediately resolvable (and a moved one stops resolving to its old
 * path). Public because the MCP server's create_note / update_note
 * handlers go through the same notesService methods which already wire
 * this call — no MCP-side caller should need it directly.
 */
export function invalidateUlidCache(): void {
  cache.clear();
}

/** Validate ULID shape without allocating an error. */
export function isUlid(s: string): boolean {
  return ULID_RE.test(s);
}

/** Recursive walk; mirrors `notesService.walk` (private) but local to this file. */
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
 * Find a note by its frontmatter ULID. Returns `null` if no match.
 *
 * Cached for 60s in-process. Cache is cleared on any notes-service
 * write op via `invalidateUlidCache`.
 */
export async function findByUlid(ulid: string): Promise<ResolvedNote | null> {
  if (!isUlid(ulid)) return null;

  const now = Date.now();
  const hit = cache.get(ulid);
  if (hit && hit.expiresAt > now) {
    return hit.result;
  }

  const c = coreConfig();
  const files = await walk(c.vaultDir);

  for (const abs of files) {
    const raw = await readFile(abs, "utf8");
    const { data } = parseFrontmatter(raw);
    const fmId = typeof data.id === "string" ? data.id : "";
    if (fmId !== ulid) continue;

    const relPath = relative(c.vaultDir, abs).split(sep).join("/");
    const pathWithoutExt = relPath.replace(/\.md$/, "");
    const title =
      (typeof data.title === "string" && data.title.trim()) ||
      parseTitle(raw, relPath);

    const result: ResolvedNote = {
      id: ulid,
      path: pathWithoutExt,
      title,
      body: raw,
      frontmatter: data,
    };
    cache.set(ulid, { result, expiresAt: now + CACHE_TTL_MS });
    return result;
  }

  // Negative cache too — repeated lookups of a non-existent ULID
  // (e.g. a typo'd share-link) shouldn't trigger a vault-walk every time.
  cache.set(ulid, { result: null, expiresAt: now + CACHE_TTL_MS });
  return null;
}
