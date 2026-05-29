/**
 * Canonical `type → folder` map for the lokyy-vault (Story 10.2, AC#3).
 *
 * Single source of truth: the create-path-derivation (`createNote`) and the
 * type/folder-mismatch guard both read from here, and Story 10.4
 * (`get_vault_conventions`) will re-export the same constant — no second
 * hand-maintained copy anywhere.
 *
 * The folders below are verified against the live vault conventions, not
 * guessed:
 *   - top-level roots ← `setup/voiceDefaults.ts` VAULT_ROOTS + CLAUDE.md
 *     "Vault Contract" (00_meta, 10_projects, 20_notes, 30_captures,
 *     40_customers, 40_daily, 50_decisions, 60_meetings, 70_pai, 80_brand,
 *     90_ideas, 99_archive).
 *   - per-type placement ← the seeded production skills
 *     (`server/setup/seedSkills.ts`: capture→30_captures, task→40_tasks,
 *     intervention→70_pai/interventions) and the legacy type-inference pass
 *     (`sleep-agent/passes/ulidBackfill.ts inferTypeFromPath`: 30_captures→
 *     capture, 10_projects→project, 50_decisions→decision, 60_meetings→
 *     meeting, 40_customers→customer, peer-notes→peer) and the MCP server
 *     instructions (note→20_notes, decision→50_decisions,
 *     intervention→70_pai/interventions).
 *   - skill→70_pai/skills ← `skills/index.ts listSkillNotes` + `list_skills`.
 */

import { DOC_TYPES, type DocType } from "../frontmatter/types.js";

/**
 * The canonical top-level (or namespaced) folder each doc type lives in.
 * Used to DERIVE a path when the caller only supplies `type` + `slug`, and
 * to VALIDATE a caller-supplied full path against its declared type.
 */
export const TYPE_FOLDER: Readonly<Record<DocType, string>> = {
  note: "20_notes",
  capture: "30_captures",
  project: "10_projects",
  task: "40_tasks",
  decision: "50_decisions",
  meeting: "60_meetings",
  customer: "40_customers",
  workflow: "70_pai/workflows",
  intervention: "70_pai/interventions",
  content: "80_brand",
  peer: "70_pai/peers",
  skill: "70_pai/skills",
  // Epic 10 / Story 10.15 — extended type enum. Static (non-dated) placement:
  //   tool      → 35_tools     (durable tool/utility records)
  //   resource  → 30_captures  (external resources, alongside captures)
  //   reference → 20_notes     (durable reference/lookup material)
  tool: "35_tools",
  resource: "30_captures",
  reference: "20_notes",
} as const;

/**
 * Types whose canonical folder uses the chronological filename convention
 * `{folder}/{YYYY-MM-DD}-{slug}` (captures + dated task lists + session
 * logs). Derived from the seeded skills' `path_pattern`
 * (`30_captures/{{today}}-{{slug}}`, `40_tasks/{{today}}-{{slug}}`) and the
 * MCP `create_note` advisory path pattern.
 */
const DATED_TYPES: ReadonlySet<DocType> = new Set<DocType>(["capture", "task"]);

/** The canonical folder for a doc type. */
export function folderForType(type: DocType): string {
  return TYPE_FOLDER[type];
}

/** True when the type's canonical placement uses the dated filename pattern. */
export function isDatedType(type: DocType): boolean {
  return DATED_TYPES.has(type);
}

/** A note path is `{prefix}/{name}` — split it into folder prefix + leaf name. */
function splitPath(path: string): { dir: string; name: string } {
  const norm = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const slash = norm.lastIndexOf("/");
  if (slash < 0) return { dir: "", name: norm };
  return { dir: norm.slice(0, slash), name: norm.slice(slash + 1) };
}

/** ISO date stamp `YYYY-MM-DD` from a Date (UTC, matches createNote's `now`). */
function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Derive a canonical note path (id without `.md`) from `type` + `slug`.
 * Dated types get the `{folder}/{YYYY-MM-DD}-{slug}` pattern; everything
 * else `{folder}/{slug}`. `now` is injectable for deterministic tests.
 */
export function derivePathForType(
  type: DocType,
  slug: string,
  now: Date = new Date(),
): string {
  const folder = folderForType(type);
  const cleanSlug = slug.replace(/^\/+|\/+$/g, "");
  if (isDatedType(type)) {
    return `${folder}/${dateStamp(now)}-${cleanSlug}`;
  }
  return `${folder}/${cleanSlug}`;
}

/** Structured result of validating a full path against its declared type. */
export type PathTypeCheck =
  | { ok: true }
  | { ok: false; type: DocType; expectedFolder: string; gotPath: string };

/**
 * Check whether a caller-supplied full `path` is consistent with `type`.
 *
 * A path is consistent when its folder is the type's canonical folder OR a
 * deeper sub-folder underneath it (so capture sub-folders like
 * `30_captures/youtube/…` stay valid — AC#5). The match is segment-aware:
 * `20_notes` matches `20_notes/x` but never `20_notes_archive/x`.
 *
 * Returns `{ ok:true }` on a match, otherwise a structured
 * `type-folder-mismatch` payload for the caller to surface verbatim.
 */
export function checkPathMatchesType(
  type: DocType,
  path: string,
): PathTypeCheck {
  const expectedFolder = folderForType(type);
  const { dir } = splitPath(path);
  const matches = dir === expectedFolder || dir.startsWith(`${expectedFolder}/`);
  return matches
    ? { ok: true }
    : { ok: false, type, expectedFolder, gotPath: path };
}

/** The full set of canonical folders (one per type), de-duplicated. */
export function canonicalFolders(): string[] {
  return [...new Set(DOC_TYPES.map((t) => TYPE_FOLDER[t]))];
}
