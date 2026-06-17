/**
 * Canonical `type → folder` map for the lokyy-vault (Story 10.2, AC#3) and
 * profile-aware path-derivation (Story S3).
 *
 * Single source of truth: the create-path-derivation (`createNote`) and the
 * type/folder-mismatch guard both read from here, and Story 10.4
 * (`get_vault_conventions`) re-exports the same constants — no second
 * hand-maintained copy anywhere.
 *
 * ── Profile-awareness (Story S3) ────────────────────────────────────────
 * The path machinery (`derivePathForType`, `checkPathMatchesType`,
 * `folderForType`, `isDatedType`, `canonicalFolders`) takes an OPTIONAL
 * trailing `profile` argument (Default `para`, mirroring S2's
 * `validateFrontmatter(data, type, profile)` shape) so every existing
 * call-site stays byte-identical while karpathy vaults route into
 * RAW/Wiki/Outputs:
 *   - `raw-source`  → `RAW/`,     dated (`YYYY-MM-DD_slug`), sub-folders ok,
 *                     `RAW/_<name>/` Hände-weg-Zone is valid (not rejected).
 *   - `wiki-article`→ `Wiki/`,    FLACH (slug filename, no date); a path with
 *                     a Wiki sub-folder is REJECTED.
 *   - `frage-report`→ `Outputs/`, sub-folders allowed.
 * The PARA profile is untouched: identical folders, identical dated convention
 * (`{folder}/{YYYY-MM-DD}-{slug}` for capture/task), identical guard.
 *
 * The PARA folders below are verified against the live vault conventions, not
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
 *
 * The karpathy folders + dated/flat rules ← the maßgeblichen Kurs-Vertrag
 * (lokyy-kb-starter/00_meta/KONVENTIONEN.md) and S2's `KARPATHY_TYPE_FOLDER`.
 */

import { type AnyDocType, type DocType } from "../frontmatter/types.js";
import {
  DEFAULT_VAULT_PROFILE,
  KARPATHY_TYPE_FOLDER,
  getProfileSpec,
  type VaultProfile,
} from "../frontmatter/profiles.js";

/**
 * The canonical top-level (or namespaced) folder each PARA doc type lives in.
 * Used to DERIVE a path when the caller only supplies `type` + `slug`, and
 * to VALIDATE a caller-supplied full path against its declared type.
 *
 * This is the PARA profile's `type → folder` map. The S2 profile registry
 * re-exports the same data as `PARA_TYPE_FOLDER`; both are pinned against each
 * other by tests so drift fails the build. The karpathy map lives in S2's
 * `KARPATHY_TYPE_FOLDER` (re-used below).
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
 * Types whose canonical folder uses the chronological filename convention.
 *
 * PARA (`capture`, `task`) → `{folder}/{YYYY-MM-DD}-{slug}` (hyphen separator),
 * derived from the seeded skills' `path_pattern`
 * (`30_captures/{{today}}-{{slug}}`, `40_tasks/{{today}}-{{slug}}`) and the
 * MCP `create_note` advisory path pattern.
 *
 * karpathy (`raw-source`) → `RAW/{YYYY-MM-DD}_{slug}` (UNDERSCORE separator,
 * per KONVENTIONEN.md RAW-Dateinamen-Vertrag).
 */
const PARA_DATED_TYPES: ReadonlySet<DocType> = new Set<DocType>([
  "capture",
  "task",
]);
const KARPATHY_DATED_TYPES: ReadonlySet<string> = new Set<string>([
  "raw-source",
]);

/** Separator between the date prefix and the slug, per profile. */
const DATE_SEP: Readonly<Record<VaultProfile, string>> = {
  para: "-",
  karpathy: "_",
};

/**
 * karpathy types whose folder is FLAT (no sub-folders): a caller-supplied path
 * with a deeper sub-folder is rejected by `checkPathMatchesType`. Per the
 * KONVENTIONEN-Vertrag only `Wiki/` is flat; `RAW/` and `Outputs/` allow
 * sub-folders.
 */
const KARPATHY_FLAT_TYPES: ReadonlySet<string> = new Set<string>([
  "wiki-article",
]);

/** The `type → folder` map for a profile (PARA default). */
function typeFolderFor(profile: VaultProfile): Readonly<Record<string, string>> {
  return profile === "karpathy" ? KARPATHY_TYPE_FOLDER : TYPE_FOLDER;
}

/** The canonical folder for a doc type under the given profile (Default para). */
export function folderForType(
  type: AnyDocType,
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): string {
  return typeFolderFor(profile)[type];
}

/**
 * True when the type's canonical placement uses the dated filename pattern.
 * PARA: capture/task. karpathy: raw-source. (Default para.)
 */
export function isDatedType(
  type: AnyDocType,
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): boolean {
  return profile === "karpathy"
    ? KARPATHY_DATED_TYPES.has(type)
    : PARA_DATED_TYPES.has(type as DocType);
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
 * Derive a canonical note path (id without `.md`) from `type` + `slug` under
 * the given profile (Default `para`).
 *
 * Dated types get the `{folder}/{YYYY-MM-DD}{sep}{slug}` pattern (PARA `sep`
 * = `-`, karpathy `sep` = `_`); everything else `{folder}/{slug}`. `now` is
 * injectable for deterministic tests.
 */
export function derivePathForType(
  type: AnyDocType,
  slug: string,
  now: Date = new Date(),
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): string {
  const folder = folderForType(type, profile);
  const cleanSlug = slug.replace(/^\/+|\/+$/g, "");
  if (isDatedType(type, profile)) {
    return `${folder}/${dateStamp(now)}${DATE_SEP[profile]}${cleanSlug}`;
  }
  return `${folder}/${cleanSlug}`;
}

/** Structured result of validating a full path against its declared type. */
export type PathTypeCheck =
  | { ok: true }
  | { ok: false; type: AnyDocType; expectedFolder: string; gotPath: string };

/**
 * Check whether a caller-supplied full `path` is consistent with `type` under
 * the given profile (Default `para`).
 *
 * A path is consistent when its folder is the type's canonical folder OR a
 * deeper sub-folder underneath it (so capture sub-folders like
 * `30_captures/youtube/…` and karpathy `RAW/transkripte/…` + the
 * `RAW/_<name>/` Hände-weg-Zone stay valid — AC#1/AC#5). The match is
 * segment-aware: `20_notes` matches `20_notes/x` but never `20_notes_archive/x`.
 *
 * EXCEPTION: karpathy FLAT types (`wiki-article` → `Wiki/`) accept ONLY the
 * exact folder; any sub-folder (`Wiki/x/y`) is REJECTED (AC#1).
 *
 * Returns `{ ok:true }` on a match, otherwise a structured
 * `type-folder-mismatch` payload for the caller to surface verbatim.
 */
export function checkPathMatchesType(
  type: AnyDocType,
  path: string,
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): PathTypeCheck {
  const expectedFolder = folderForType(type, profile);
  const { dir } = splitPath(path);
  const isFlat = profile === "karpathy" && KARPATHY_FLAT_TYPES.has(type);
  const matches = isFlat
    ? dir === expectedFolder
    : dir === expectedFolder || dir.startsWith(`${expectedFolder}/`);
  return matches
    ? { ok: true }
    : { ok: false, type, expectedFolder, gotPath: path };
}

/**
 * The full set of canonical folders for a profile (one per type),
 * de-duplicated (Default `para`).
 */
export function canonicalFolders(
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): string[] {
  const spec = getProfileSpec(profile);
  const map = typeFolderFor(profile);
  return [...new Set(spec.docTypes.map((t) => map[t]))];
}
