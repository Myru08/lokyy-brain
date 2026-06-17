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

import { type AnyDocType, type DocType } from "../frontmatter/types.js";
import {
  TYPE_FOLDER,
  isDatedType,
  derivePathForType,
} from "../notes/folderMap.js";
import {
  DEFAULT_VAULT_PROFILE,
  getProfileSpec,
  type VaultProfile,
} from "../frontmatter/profiles.js";
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
  type: AnyDocType;
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

/**
 * Per-doc-type frontmatter rule summary (profile-specific layers).
 *
 * Only populated for profiles whose layers carry their own required/optional
 * fields and conditional constraints beyond the base contract (today: the
 * karpathy RAW/Wiki/Outputs layers). PARA leaves this undefined — its per-type
 * schemas are summarised through the generic `frontmatter` block instead.
 */
export interface TypeFrontmatterRule {
  type: AnyDocType;
  /** Required fields beyond the base contract (id/type/title/created/updated). */
  requiredExtra: string[];
  /** Optional fields beyond the base contract. */
  optional: string[];
  /** Human-readable note on conditional constraints (e.g. sources-pflicht). */
  notes: string;
}

/** The full conventions payload returned to first-time agents. */
export interface VaultConventions {
  folders: FolderConvention[];
  types: TypeConvention[];
  frontmatter: FrontmatterConvention;
  wikilinks: string;
  tags: string;
  ids: string;
  /**
   * Files every vault of this profile MUST carry. Empty for PARA (no hard
   * file contract); populated for karpathy (AGENTS.md, CHANGELOG.md, …).
   */
  requiredFiles?: string[];
  /**
   * Per-layer frontmatter rules. Only set for profiles with layer-specific
   * contracts (karpathy). Undefined for PARA.
   */
  typeFrontmatter?: TypeFrontmatterRule[];
  /**
   * Status-trias meaning (gesichert | im Aufbau | These). Only set for the
   * karpathy profile, whose wiki-articles carry the trias.
   */
  statusTrias?: Record<string, string>;
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
  // Story S2 — Karpathy profile folders (RAW/Wiki/Outputs). Only advertised
  // when the active profile is `karpathy`. RAW darf Unterordner tragen;
  // `RAW/_<name>/` ist eine "Hände weg"-Zone (nicht automatisiert anfassen).
  // Wiki ist flach.
  RAW: "Verbatim captured sources (type: raw-source) — never rewritten. Unterordner erlaubt; `RAW/_<name>/` = Hände weg (manuell, nicht automatisiert anfassen).",
  Wiki: "Atomic distilled articles (type: wiki-article) with status-trias — flach (keine Unterordner).",
  Outputs: "Question reports (type: frage-report) — question + sources + answer.",
};

/** A profile-shaped view: its closed type list + that profile's type→folder map. */
interface ProfileView {
  profile: VaultProfile;
  docTypes: readonly AnyDocType[];
  typeFolder: Readonly<Record<string, string>>;
}

/** Build the dated/static path pattern for a folder, derived from folderMap. */
function pathPatternForFolder(folder: string, view: ProfileView): string {
  // Find a type that maps to this folder so we can ask folderMap whether the
  // canonical placement is dated — this keeps the dated/static decision in
  // ONE place (no second `DATED_TYPES` copy here). Only PARA types carry a
  // dated convention today (capture/task); karpathy folders are all static.
  const owningType = view.docTypes.find((t) => view.typeFolder[t] === folder);
  if (owningType && isParaType(owningType) && isDatedType(owningType)) {
    return `${folder}/{YYYY-MM-DD}-slug`;
  }
  return `${folder}/slug`;
}

/** Narrowing helper — `isDatedType` is typed for PARA `DocType` only. */
function isParaType(type: AnyDocType): type is DocType {
  return type in TYPE_FOLDER;
}

/**
 * Build the folder list: the union of every profile `typeFolder` value
 * (guarantees each doc type's folder is present — AC#3/AC#4) plus, for the
 * PARA profile, the descriptive top-level roots in `FOLDER_PURPOSE` that no
 * type owns yet. Deduped, sorted. The karpathy profile only advertises its own
 * RAW/Wiki/Outputs folders (it does not inherit the PARA roots).
 */
function buildFolders(view: ProfileView): FolderConvention[] {
  const paths = new Set<string>(Object.values(view.typeFolder));
  if (view.profile === "para") {
    for (const root of Object.keys(FOLDER_PURPOSE)) paths.add(root);
  }
  // Karpathy advertises its own RAW/Wiki/Outputs plus the SPEC-mandated
  // 00_meta root (which no type owns) — but NOT the PARA roots.
  if (view.profile === "karpathy") {
    paths.add("00_meta");
  }
  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({
      path,
      purpose: FOLDER_PURPOSE[path] ?? "(folder)",
      pathPattern: pathPatternForFolder(path, view),
    }));
}

/** Short meaning per doc type — keyed across every profile's closed type list. */
const TYPE_MEANING: Record<AnyDocType, string> = {
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
  // Story S2 — Karpathy profile (RAW / Wiki / Outputs).
  "raw-source": "Verbatim captured source, never rewritten (lives in RAW).",
  "wiki-article":
    "Atomic distilled article with status-trias gesichert|im Aufbau|These (lives in Wiki).",
  "frage-report": "Question + sources + answer report (lives in Outputs).",
};

/** Build the type list straight from the profile spec (no drift). */
function buildTypes(view: ProfileView): TypeConvention[] {
  return view.docTypes.map((type) => ({
    type,
    meaning: TYPE_MEANING[type],
    folder: view.typeFolder[type],
  }));
}

/**
 * Derive the frontmatter summary from `base.json`: `required` is the schema's
 * required array; per-field descriptions are short, hand-written blurbs keyed
 * to the schema fields (the schema's own `description` strings are verbose).
 */
function buildFrontmatter(view: ProfileView): FrontmatterConvention {
  const required = Array.isArray((baseSchema as { required?: unknown }).required)
    ? ((baseSchema as { required: string[] }).required as string[])
    : ["id", "type", "title", "created", "updated"];

  const fieldDescriptions: Record<string, string> = {
    id: "ULID (26 chars, Crockford base32). Stable on rename — never change it.",
    type: `One of the active "${view.profile}" profile's closed type list: ${view.docTypes.join(", ")}.`,
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
 * Karpathy contract surface (Story S2, Option-Y-Korrektur). Mirrors the
 * maßgeblichen Kurs-Vertrag (lokyy-kb-starter/00_meta/KONVENTIONEN.md) so a
 * first-time agent against a karpathy vault gets the real RAW/Wiki/Outputs
 * rules — not just the base contract. These are hand-maintained blurbs that
 * track the per-type schemas (raw-source/wiki-article/frage-report.json); the
 * conditional source-pflicht is enforced there, summarised here.
 */
const KARPATHY_REQUIRED_FILES: readonly string[] = [
  "AGENTS.md",
  "CHANGELOG.md",
  "RAW/_INGESTED.md",
  "Wiki/INDEX.md",
  "Wiki/QUESTIONS.md",
];

const KARPATHY_TYPE_FRONTMATTER: readonly TypeFrontmatterRule[] = [
  {
    type: "raw-source",
    requiredExtra: [
      "author",
      "source_url",
      "date_added",
      "date_published",
      "source_type",
    ],
    optional: ["tags"],
    notes:
      "RAW-Quelle. `author`/`source_url` Pflicht (\"unbekannt\" als Wert erlaubt). " +
      "`date_added` echtes Datum YYYY-MM-DD. `date_published` YYYY-MM-DD ODER \"unbekannt\". " +
      "`source_type` ∈ article|note|video|podcast|book|paper|thread|email|other.",
  },
  {
    type: "wiki-article",
    requiredExtra: ["status", "stand"],
    optional: ["sources", "tags"],
    notes:
      "Wiki-Artikel. `status` ∈ gesichert|im Aufbau|These. `stand` Pflicht (YYYY-MM-DD). " +
      "`sources` = Klartext-RAW-Dateinamen (KEINE [[Verweise]] — die gehören in den Body / S5). " +
      "Quellenpflicht (min 1) bei status ∈ {gesichert, im Aufbau}; bei status=These optional/leer erlaubt.",
  },
  {
    type: "frage-report",
    requiredExtra: ["question", "sources"],
    optional: ["stand", "tags"],
    notes:
      "Output-Report. `question` Pflicht. `sources` (min 1) Klartext-Referenzen auf RAW/Wiki. " +
      "`stand` optional (YYYY-MM-DD).",
  },
];

const KARPATHY_STATUS_TRIAS: Readonly<Record<string, string>> = {
  gesichert: "Belegt durch ≥1 Quelle — gilt als gesicherte Aussage.",
  "im Aufbau": "In Arbeit; trägt bereits ≥1 Quelle, ist aber noch nicht fertig destilliert.",
  These: "Persönliche Annahme/These ohne Belegpflicht — darf quellenlos sein.",
};

/**
 * Machine-readable vault conventions for first-time agents (Story 10.4).
 * Pure (no I/O) — derived entirely from the in-repo single sources of truth.
 *
 * The `_pathExample` built into `wikilinks`/`ids` notes are derived via
 * `derivePathForType` so the dated-path convention shown to agents matches
 * exactly what `createNote` would produce.
 */
export function getVaultConventions(
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): VaultConventions {
  const spec = getProfileSpec(profile);
  const view: ProfileView = {
    profile: spec.profile,
    docTypes: spec.docTypes,
    typeFolder: spec.typeFolder,
  };

  // Concrete dated example, derived (not hand-typed) so it never drifts from
  // folderMap's dated-path logic. Only PARA has a dated type (capture); the
  // karpathy profile is all-static, so it shows a static example instead.
  const datedExample =
    spec.profile === "para"
      ? derivePathForType("capture", "slug", new Date("2026-01-15T00:00:00.000Z"))
      : null;

  const isKarpathy = spec.profile === "karpathy";

  return {
    folders: buildFolders(view),
    types: buildTypes(view),
    frontmatter: buildFrontmatter(view),
    wikilinks:
      "Link notes with [[Note Title]] (Obsidian-style). The graph is derived " +
      "from these wikilinks; insert them to build relationships organically.",
    tags: "Inline #tags in the body and/or a `tags:` frontmatter array.",
    ids: datedExample
      ? "Every note carries a stable 26-char ULID in `id:`. Dated folders use " +
        `the {YYYY-MM-DD}-slug filename pattern, e.g. "${datedExample}".`
      : "Every note carries a stable 26-char ULID in `id:`. Folders in this " +
        "profile use the {folder}/slug filename pattern.",
    // Karpathy-only contract surface (Story S2, Option-Y-Korrektur). PARA
    // leaves these undefined so its payload stays bit-identical.
    ...(isKarpathy
      ? {
          requiredFiles: [...KARPATHY_REQUIRED_FILES],
          typeFrontmatter: KARPATHY_TYPE_FRONTMATTER.map((r) => ({
            ...r,
            requiredExtra: [...r.requiredExtra],
            optional: [...r.optional],
          })),
          statusTrias: { ...KARPATHY_STATUS_TRIAS },
        }
      : {}),
  };
}
