import type { TreeNode } from "@lokyy/shared";

import {
  generateUlid,
  parseFrontmatter,
  serializeFrontmatter,
  type FrontmatterMap,
} from "../frontmatter/index.js";
import { getVaultConventions } from "../conventions/index.js";
import {
  DEFAULT_VAULT_PROFILE,
  type VaultProfile,
} from "../frontmatter/profiles.js";

/**
 * Deterministic vault INDEX generator (Story "Suchleiter + Pipeline", AC#1).
 *
 * WHY THIS EXISTS
 * An AI client that wants to know "what is in this vault" has, until now,
 * only had two options: `list_tree` (structure without meaning) or a
 * shotgun of `search_vault` calls. Both are expensive and neither answers
 * "which folder do I even look in". `00_meta/INDEX.md` is the cheap first
 * rung of the Brain-First search ladder: one read, whole-vault orientation,
 * then a targeted search, then exactly ONE `read_note`.
 *
 * NO LLM IS INVOLVED. The index is a pure function of the vault tree (plus
 * each folder's README first line, if present). Same vault ⇒ same bytes,
 * which is what makes it safe to regenerate on a timer without churning
 * the git history: an unchanged vault produces an unchanged body, and
 * `generateVaultIndex` then skips the write entirely.
 *
 * COMPACTNESS
 * A vault with thousands of notes must not produce a thousand-line index —
 * that would defeat the token-saving purpose. `renderVaultIndex` picks the
 * largest per-folder note limit from a FIXED ladder that still fits the
 * line budget, so compaction is a deterministic function of vault size,
 * never of wall-clock or iteration order.
 */

// ─── Public types ───────────────────────────────────────────────────────────

/** One note as it appears in the index. */
export interface IndexNoteEntry {
  title: string;
  /** Note id (path without `.md`). */
  path: string;
}

/** One folder with its purpose and the notes directly inside it. */
export interface IndexFolderEntry {
  /** Folder path, or `"/"` for notes sitting at the vault root. */
  path: string;
  /** Human-readable purpose. Empty string renders no purpose line. */
  purpose: string;
  /** Notes directly in this folder, sorted by path. */
  notes: IndexNoteEntry[];
  /** `notes.length` — kept explicit so callers may pre-truncate. */
  totalNotes: number;
}

export interface RenderIndexOpts {
  /** Hard line budget for the rendered body. Default 500. */
  maxLines?: number;
}

export interface BuildIndexDeps {
  getTree: () => Promise<TreeNode[]>;
  /** Used only to read folder READMEs for purpose text. May return null. */
  getNote: (id: string) => Promise<{ body: string } | null>;
  /** SPEC profile whose conventions supply fallback folder purposes. */
  profile?: VaultProfile;
  maxLines?: number;
}

export interface GenerateIndexOpts extends BuildIndexDeps {
  /**
   * Raw markdown of the current `00_meta/INDEX.md`, if it exists. Supplying
   * it enables the two idempotency guarantees: unchanged body ⇒ no write,
   * and `id`/`created` are carried over instead of regenerated.
   */
  existing?: string | null;
  /**
   * Injected write API — the gitService `save(relPath, content, message)`.
   * The return value is deliberately `unknown`: this module only cares that
   * the write resolved, so gitService can evolve its result shape (commit
   * SHA, richer SaveResult) without dragging the index generator along.
   */
  save?: (relPath: string, content: string, message: string) => Promise<unknown>;
  now?: Date;
}

export interface GenerateIndexResult {
  /** Note id, i.e. the path without `.md`. */
  path: string;
  /** Path relative to the vault root, WITH `.md`. */
  relPath: string;
  /** Full markdown incl. frontmatter — what is (or already was) on disk. */
  content: string;
  /** The rendered body without frontmatter. */
  body: string;
  /** True when the file was actually committed by this call. */
  written: boolean;
  /** Set when a write was attempted and failed (best-effort write path). */
  saveError?: string;
}

/** Note id of the generated index. */
export const VAULT_INDEX_PATH = "00_meta/INDEX";
/** Vault-relative file path of the generated index. */
export const VAULT_INDEX_REL_PATH = `${VAULT_INDEX_PATH}.md`;
/** Index older than this is considered stale by `isIndexStale`. */
export const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const INDEX_TITLE = "Vault-Index";
const DEFAULT_MAX_LINES = 500;

/**
 * Per-folder note limits tried in order, biggest first. The first entry
 * whose render fits `maxLines` wins. A fixed ladder (rather than a
 * computed budget split) keeps compaction reproducible: the same vault
 * always lands on the same rung.
 */
const NOTE_LIMIT_LADDER = [1000, 200, 100, 50, 25, 15, 10, 5, 3, 1, 0];

// ─── Tree → folder list ─────────────────────────────────────────────────────

/**
 * Flatten the vault tree into a path-sorted list of folders, each carrying
 * the notes directly inside it (not those of its sub-folders — those get
 * their own entry). Empty folders are dropped: an index exists to point at
 * content, and `list_tree` already shows the bare skeleton.
 *
 * Sorting is by raw code-unit comparison, NOT `localeCompare`, because
 * locale collation is environment-dependent and would break byte-identity
 * between a developer machine and the server.
 */
export function collectIndexFolders(tree: TreeNode[]): IndexFolderEntry[] {
  const out: IndexFolderEntry[] = [];

  const visit = (nodes: TreeNode[], folderPath: string): void => {
    const notes: IndexNoteEntry[] = [];
    for (const node of nodes) {
      if (node.type === "note") {
        notes.push({ title: node.name, path: node.path });
      }
    }
    if (notes.length > 0) {
      notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      out.push({
        path: folderPath === "" ? "/" : folderPath,
        purpose: "",
        notes,
        totalNotes: notes.length,
      });
    }
    for (const node of nodes) {
      if (node.type === "folder") visit(node.children, node.path);
    }
  };

  visit(tree, "");
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * The ladder preamble. Duplicated (in spirit) in the MCP server
 * instructions on purpose: a client that only ever reads the index still
 * learns the cost discipline, even if its host swallowed the MCP
 * `instructions` field.
 */
const LADDER_SECTION = [
  "## Suchleiter — in dieser Reihenfolge, wegen Token-Kosten",
  "",
  "1. **Dieser Index** — Orientierung: welcher Ordner, welche Notiz überhaupt.",
  "2. **`search_vault`** (Default `mode: \"fast\"`) — Volltext + Semantik, sofort und kostenlos.",
  "3. **`search_vault` mit `mode: \"deep\"`** — nur wenn `fast` nichts Brauchbares",
  "   liefert. Läuft die 8-Stufen-Pipeline (Intent, RAG-Fusion, Graph-Spreading,",
  "   Re-Ranking) und kostet LLM-Aufrufe.",
  "4. **`read_note`** — genau EINE Datei, die beste aus Schritt 2/3. Nicht mehrere",
  "   auf Verdacht öffnen.",
  "",
].join("\n");

function renderWithLimit(
  folders: IndexFolderEntry[],
  perFolderLimit: number,
): string {
  const lines: string[] = [
    `# ${INDEX_TITLE}`,
    "",
    "> Deterministisch aus dem Vault-Baum erzeugt (kein LLM). Der Index ist die",
    "> erste, billigste Stufe der Suche: erst hier orientieren, dann gezielt suchen,",
    "> dann genau eine Notiz öffnen.",
    "",
    LADDER_SECTION,
    "## Ordner",
    "",
  ];

  for (const folder of folders) {
    const label = folder.totalNotes === 1 ? "Notiz" : "Notizen";
    lines.push(`### ${folder.path} — ${folder.totalNotes} ${label}`);
    if (folder.purpose) lines.push(folder.purpose);
    const shown = folder.notes.slice(0, perFolderLimit);
    for (const n of shown) {
      lines.push(`- ${n.title} — \`${n.path}\``);
    }
    const hidden = folder.totalNotes - shown.length;
    if (hidden > 0) {
      lines.push(
        `- … und ${hidden} weitere Notizen in diesem Ordner ` +
          `(\`list_notes\` mit \`folder: "${folder.path}"\`).`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render the index body. Picks the largest per-folder note limit from
 * `NOTE_LIMIT_LADDER` that keeps the result inside `maxLines`; if even the
 * smallest rung overflows (a vault with hundreds of folders), the smallest
 * rung is used anyway — a slightly over-budget index beats no index.
 */
export function renderVaultIndex(
  folders: IndexFolderEntry[],
  opts: RenderIndexOpts = {},
): string {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  let last = "";
  for (const limit of NOTE_LIMIT_LADDER) {
    last = renderWithLimit(folders, limit);
    if (last.split("\n").length <= maxLines) return last;
  }
  return last;
}

// ─── Purpose resolution ─────────────────────────────────────────────────────

/**
 * First prose line of a README body — the folder's own description of
 * itself, which beats any hardcoded blurb. Skips the frontmatter, headings,
 * blockquotes, list items and wikilink-only lines, and collapses the result
 * to a single line so the index layout stays predictable.
 */
export function readmePurpose(raw: string): string {
  const { body } = parseFrontmatter(raw);
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#") || line.startsWith(">") || line.startsWith("-")) continue;
    if (line.startsWith("|") || line.startsWith("```")) continue;
    const collapsed = line.replace(/\s+/g, " ");
    return collapsed.length > 160 ? `${collapsed.slice(0, 157)}…` : collapsed;
  }
  return "";
}

async function resolvePurposes(
  folders: IndexFolderEntry[],
  deps: BuildIndexDeps,
): Promise<IndexFolderEntry[]> {
  const conventions = new Map(
    getVaultConventions(deps.profile ?? DEFAULT_VAULT_PROFILE).folders.map(
      (f) => [f.path, f.purpose] as const,
    ),
  );

  return await Promise.all(
    folders.map(async (folder) => {
      // A README inside the folder is the most specific source; a missing or
      // unreadable one is not an error — the conventions blurb takes over.
      let purpose = "";
      const readmeId = folder.notes.find((n) =>
        /\/README$/i.test(n.path) || n.path.toUpperCase() === "README",
      )?.path;
      if (readmeId) {
        try {
          const note = await deps.getNote(readmeId);
          if (note) purpose = readmePurpose(note.body);
        } catch {
          purpose = "";
        }
      }
      if (!purpose) purpose = conventions.get(folder.path) ?? "";
      return { ...folder, purpose };
    }),
  );
}

/** Build the index body from the live vault tree. */
export async function buildVaultIndexBody(deps: BuildIndexDeps): Promise<string> {
  const tree = await deps.getTree();
  const folders = await resolvePurposes(collectIndexFolders(tree), deps);
  return renderVaultIndex(folders, {
    ...(deps.maxLines !== undefined ? { maxLines: deps.maxLines } : {}),
  });
}

// ─── Freshness ──────────────────────────────────────────────────────────────

/**
 * Is the index due for a regeneration? Missing or unparsable `updated`
 * counts as stale — an index we can't date is an index we can't trust.
 */
export function isIndexStale(
  data: FrontmatterMap,
  now: Date = new Date(),
  maxAgeMs: number = INDEX_MAX_AGE_MS,
): boolean {
  const updated = data.updated;
  if (typeof updated !== "string") return true;
  const ts = Date.parse(updated);
  if (Number.isNaN(ts)) return true;
  return now.getTime() - ts > maxAgeMs;
}

// ─── Write path ─────────────────────────────────────────────────────────────

/**
 * Regenerate `00_meta/INDEX.md` and persist it through the injected save
 * API (in production: gitService's `save`, which this module only ever
 * CALLS — the git layer is owned elsewhere).
 *
 * Three properties matter here:
 *   - **Idempotent:** identical body ⇒ no write, no commit, no `updated` bump.
 *   - **Stable identity:** `id` and `created` survive every regeneration, so
 *     wikilinks and ULID lookups keep resolving.
 *   - **Best effort:** a failing write (Forgejo down, hook rejection) still
 *     returns the fresh content, so `get_index` can answer from memory rather
 *     than failing the caller's whole turn.
 */
export async function generateVaultIndex(
  opts: GenerateIndexOpts,
): Promise<GenerateIndexResult> {
  const now = opts.now ?? new Date();
  const body = await buildVaultIndexBody(opts);

  const previous = opts.existing ? parseFrontmatter(opts.existing) : null;

  if (previous && previous.body.trim() === body.trim()) {
    return {
      path: VAULT_INDEX_PATH,
      relPath: VAULT_INDEX_REL_PATH,
      content: opts.existing as string,
      body: previous.body,
      written: false,
    };
  }

  const prevId = previous?.data.id;
  const prevCreated = previous?.data.created;
  const nowIso = now.toISOString();
  const data: FrontmatterMap = {
    id: typeof prevId === "string" && prevId.length === 26 ? prevId : generateUlid(),
    type: "reference",
    title: INDEX_TITLE,
    created: typeof prevCreated === "string" ? prevCreated : nowIso,
    updated: nowIso,
    tags: ["index", "meta"],
  };
  const content = serializeFrontmatter(data, body);

  if (!opts.save) {
    return {
      path: VAULT_INDEX_PATH,
      relPath: VAULT_INDEX_REL_PATH,
      content,
      body,
      written: false,
    };
  }

  try {
    await opts.save(
      VAULT_INDEX_REL_PATH,
      content,
      "chore(index): regenerate vault INDEX",
    );
    return {
      path: VAULT_INDEX_PATH,
      relPath: VAULT_INDEX_REL_PATH,
      content,
      body,
      written: true,
    };
  } catch (err) {
    return {
      path: VAULT_INDEX_PATH,
      relPath: VAULT_INDEX_REL_PATH,
      content,
      body,
      written: false,
      saveError: err instanceof Error ? err.message : String(err),
    };
  }
}
