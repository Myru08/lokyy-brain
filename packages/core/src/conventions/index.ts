/**
 * Vault conventions surface (Story 10.4) — `getVaultConventions()`.
 *
 * An agent working with a lokyy-vault for the first time needs a
 * machine-readable description of the folder layout, doc types, and
 * frontmatter contract so it does NOT have to guess paths/types (the gap
 * that today produces mis-placed notes). The MCP `get_vault_conventions()`
 * tool (Agent C) returns this object verbatim.
 *
 * Single source of truth (AC#1/AC#5 — no drifting copy):
 *   - the `type → folder` map and dated-path detection come from
 *     `notes/folderMap.ts` (`TYPE_FOLDER`, `isDatedType`, `derivePathForType`),
 *   - the doc-type enum comes from `frontmatter/types.ts` (`DOC_TYPES`),
 *   - the required-frontmatter summary comes from `frontmatter/schemas/base.json`.
 * Nothing here hand-maintains a second folder map.
 */

import { DOC_TYPES, type DocType } from "../frontmatter/types.js";
import {
  TYPE_FOLDER,
  isDatedType,
  derivePathForType,
} from "../notes/folderMap.js";
import baseSchema from "../frontmatter/schemas/base.json" with { type: "json" };

/** One vault folder with its purpose and (where dated) filename pattern. */
export interface FolderConvention {
  /** Canonical folder path, e.g. `30_captures` or `70_pai/skills`. */
  path: string;
  /** Human-readable purpose of the folder. */
  purpose: string;
  /**
   * Path pattern for new entries in this folder, e.g.
   * `30_captures/{YYYY-MM-DD}-slug` for dated folders or `20_notes/slug`.
   */
  pathPattern: string;
}

/** One doc type, what it means, and which folder it lives in. */
export interface TypeConvention {
  type: DocType;
  meaning: string;
  folder: string;
}

/** Summary of one frontmatter field (whether required + a short note). */
export interface FrontmatterFieldConvention {
  field: string;
  required: boolean;
  description: string;
}

/** Frontmatter contract summary derived from `base.json`. */
export interface FrontmatterConvention {
  required: string[];
  fields: FrontmatterFieldConvention[];
}

/** The full conventions payload returned to first-time agents. */
export interface VaultConventions {
  folders: FolderConvention[];
  types: TypeConvention[];
  frontmatter: FrontmatterConvention;
  wikilinks: string;
  tags: string;
  ids: string;
}

/**
 * Purpose blurbs for the canonical top-level (and namespaced) folders.
 *
 * Keyed by the folder paths that the `type → folder` map (`folderMap.ts`)
 * actually produces, plus the SPEC top-level roots that have no own type yet
 * (`00_meta`, `90_ideas`, `99_archive`, `35_tools`, `70_pai/sessions`). We
 * intentionally describe a slightly larger set than `TYPE_FOLDER` so the
 * agent sees the whole structure; every type folder is guaranteed present
 * because `buildFolders()` unions `TYPE_FOLDER` with this map (AC#3/AC#4).
 */
const FOLDER_PURPOSE: Record<string, string> = {
  "00_meta": "Vault metadata: JSON schemas, mcp-scopes.yaml, templates.",
  "10_projects": "Project notes (type: project) — ongoing initiatives.",
  "20_notes": "General notes & insights (type: note) — the default home.",
  "30_captures":
    "Captured external sources (type: capture) from pipes: urls, youtube, voice, pdfs sub-folders.",
  "35_tools": "Tool docs / references (exists in the live vault).",
  "40_tasks": "Dated task lists (type: task).",
  "40_customers": "Customer notes (type: customer).",
  "40_daily": "Daily notes / journal.",
  "50_decisions": "Decisions & ADRs (type: decision) — trade-offs recorded.",
  "60_meetings": "Meeting notes (type: meeting).",
  "70_pai": "PAI workspace root (interventions, skills, sessions, workflows, peers).",
  "70_pai/interventions":
    "Proactive suggestions the agent surfaces (type: intervention).",
  "70_pai/skills": "Reusable skill definitions (type: skill) — see get_skill_schema.",
  "70_pai/sessions": "Session summaries / write-it-all-down notes (type: note).",
  "70_pai/workflows": "Workflow definitions (type: workflow).",
  "70_pai/peers": "Peer profiles (type: peer) — people/orgs/agents.",
  "80_brand": "Brand / content material (type: content).",
  "90_ideas": "Idea backlog / scratch (type: note).",
  "99_archive": "Archived & soft-deleted notes (incl. _trash/ — see delete_note).",
};

/** Build the dated/static path pattern for a folder, derived from folderMap. */
function pathPatternForFolder(folder: string): string {
  // Find a type that maps to this folder so we can ask folderMap whether the
  // canonical placement is dated — this keeps the dated/static decision in
  // ONE place (no second `DATED_TYPES` copy here).
  const owningType = DOC_TYPES.find((t) => TYPE_FOLDER[t] === folder);
  if (owningType && isDatedType(owningType)) {
    return `${folder}/{YYYY-MM-DD}-slug`;
  }
  return `${folder}/slug`;
}

/**
 * Build the folder list: the union of every `TYPE_FOLDER` value (guarantees
 * each doc type's folder is present — AC#3/AC#4) plus the descriptive
 * top-level roots in `FOLDER_PURPOSE` that no type owns yet. Deduped, sorted.
 */
function buildFolders(): FolderConvention[] {
  const paths = new Set<string>([
    ...Object.values(TYPE_FOLDER),
    ...Object.keys(FOLDER_PURPOSE),
  ]);
  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({
      path,
      purpose: FOLDER_PURPOSE[path] ?? "(folder)",
      pathPattern: pathPatternForFolder(path),
    }));
}

/** Short meaning per doc type — keyed by the closed `DOC_TYPES` list. */
const TYPE_MEANING: Record<DocType, string> = {
  note: "General insight or knowledge note.",
  capture: "External source captured via a pipe (url, youtube, voice, pdf).",
  project: "An ongoing project / initiative.",
  task: "A dated task or task list.",
  decision: "A trade-off / architecture decision record.",
  meeting: "Meeting notes.",
  customer: "A customer record.",
  workflow: "A workflow definition.",
  intervention: "A proactive suggestion the agent surfaces to the user.",
  content: "Brand / content material.",
  peer: "Profile of a person/org/agent the user interacts with.",
  skill: "Reusable prompt definition runnable via run_skill (see get_skill_schema).",
  // Epic 10 / Story 10.15 — extended type enum (auto-propagates via DOC_TYPES).
  tool: "A software tool / utility record (lives in 35_tools).",
  resource: "An external resource captured for later reference (lives in 30_captures).",
  reference: "Durable reference / lookup material (lives in 20_notes).",
};

/** Build the type list straight from `DOC_TYPES` + `TYPE_FOLDER` (no drift). */
function buildTypes(): TypeConvention[] {
  return DOC_TYPES.map((type) => ({
    type,
    meaning: TYPE_MEANING[type],
    folder: TYPE_FOLDER[type],
  }));
}

/**
 * Derive the frontmatter summary from `base.json`: `required` is the schema's
 * required array; per-field descriptions are short, hand-written blurbs keyed
 * to the schema fields (the schema's own `description` strings are verbose).
 */
function buildFrontmatter(): FrontmatterConvention {
  const required = Array.isArray((baseSchema as { required?: unknown }).required)
    ? ((baseSchema as { required: string[] }).required as string[])
    : ["id", "type", "title", "created", "updated"];

  const fieldDescriptions: Record<string, string> = {
    id: "ULID (26 chars, Crockford base32). Stable on rename — never change it.",
    type: `One of the closed DOC_TYPES list: ${DOC_TYPES.join(", ")}.`,
    title: "Human-readable title (non-empty).",
    created: "ISO-8601 creation timestamp. Immutable after creation.",
    updated: "ISO-8601 last-modified timestamp. The save path bumps it automatically.",
    tags: "Optional free-form tag list (array of strings).",
    privacy: "Optional 'default' | 'local-only' — local-only forces a local LLM.",
  };

  const requiredSet = new Set(required);
  const allFields = [...required, "tags", "privacy"];
  return {
    required,
    fields: allFields.map((field) => ({
      field,
      required: requiredSet.has(field),
      description: fieldDescriptions[field] ?? "(see base.json)",
    })),
  };
}

/**
 * Machine-readable vault conventions for first-time agents (Story 10.4).
 * Pure (no I/O) — derived entirely from the in-repo single sources of truth.
 *
 * The `_pathExample` built into `wikilinks`/`ids` notes are derived via
 * `derivePathForType` so the dated-path convention shown to agents matches
 * exactly what `createNote` would produce.
 */
export function getVaultConventions(): VaultConventions {
  // Concrete dated example, derived (not hand-typed) so it never drifts from
  // folderMap's dated-path logic.
  const captureExample = derivePathForType(
    "capture",
    "slug",
    new Date("2026-01-15T00:00:00.000Z"),
  );

  return {
    folders: buildFolders(),
    types: buildTypes(),
    frontmatter: buildFrontmatter(),
    wikilinks:
      "Link notes with [[Note Title]] (Obsidian-style). The graph is derived " +
      "from these wikilinks; insert them to build relationships organically.",
    tags: "Inline #tags in the body and/or a `tags:` frontmatter array.",
    ids:
      "Every note carries a stable 26-char ULID in `id:`. Dated folders use " +
      `the {YYYY-MM-DD}-slug filename pattern, e.g. "${captureExample}".`,
  };
}
