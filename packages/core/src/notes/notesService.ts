import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Note, NoteSummary, TreeNode } from "@lokyy/shared";
import { coreConfig } from "../util/coreConfig.js";
import { lastModified, move, pull, remove, save } from "../git/gitService.js";
import {
  parseAliases,
  parseLinks,
  parseTags,
  parseTitle,
} from "../graph/graphService.js";
import {
  generateUlid,
  isForgotten,
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
  type DocType,
  type EncodedContext,
  type FrontmatterMap,
} from "../frontmatter/index.js";
import { FrontmatterValidationError } from "../errors/FrontmatterValidationError.js";
import { TypeFolderMismatchError } from "../errors/TypeFolderMismatchError.js";
import { checkPathMatchesType } from "./folderMap.js";
import {
  queueSearchIndexRefresh,
  queueSearchIndexRemove,
} from "../memory/index.js";
import { syncWikilinksToTemporalEdges } from "../graph/temporalEdges.js";
import { invalidateUlidCache } from "./findByUlid.js";

/**
 * Default vault id used by the BM25 search-index hooks. The Story-2 hybrid
 * retrieval pipeline runs in single-active-vault dev mode (mirrors the
 * convention already used by `searchRoutes`). Story 3's per-vault route
 * migration will plumb the real vault id through here.
 */
const DEFAULT_VAULT_ID = process.env.LOKYY_DEFAULT_VAULT ?? "default";

/**
 * Phase C Wave C2 / Story 1 — fire-and-forget hook into the bi-temporal
 * edges table. NEVER blocks the save path. Errors are logged only — git
 * commit is the source of truth, temporal-edges are a derived index.
 */
function queueTemporalEdgeSync(
  noteId: string,
  wikilinkTargets: string[],
  updatedAt: Date,
): void {
  if (wikilinkTargets.length === 0) return;
  void syncWikilinksToTemporalEdges(noteId, wikilinkTargets, updatedAt).catch(
    (err) => {
      console.warn(
        `[notesService] temporal-edge sync failed for ${noteId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    },
  );
}

/**
 * Notizen-Service. Eine Notiz == eine .md-Datei im Vault. Kein Cache, keine
 * DB — gelesen wird direkt von Disk, geschrieben über den Git-Service.
 */

/** Rekursiv alle .md-Pfade im Vault einsammeln (ohne .git, ohne Hidden). */
async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

/** path "pai/hermes.md" -> id "pai/hermes" (immer mit "/" als Trenner). */
function pathToId(relPath: string): string {
  return relPath.replace(/\.md$/, "").split(sep).join("/");
}

/** Vollständige Notiz aus einer absoluten Datei bauen. */
async function readNoteFile(absPath: string): Promise<Note> {
  const c = coreConfig();
  const relPath = relative(c.vaultDir, absPath).split(sep).join("/");
  const body = await readFile(absPath, "utf8");
  return {
    id: pathToId(relPath),
    path: relPath,
    title: parseTitle(body, relPath),
    body,
    tags: parseTags(body),
    links: parseLinks(body),
    aliases: parseAliases(body),
    updatedAt: await lastModified(relPath),
  };
}

/** Liste aller Notizen (ohne Body). Pullt vorher, damit die Liste aktuell ist. */
export async function listNotes(): Promise<NoteSummary[]> {
  await pull();
  const c = coreConfig();
  const files = await walk(c.vaultDir);
  const notes = await Promise.all(files.map(readNoteFile));
  return notes
    .map(({ body, ...summary }) => summary)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Einzelne Notiz lesen. Pullt vorher — Forgejo ist die Wahrheit. */
export async function getNote(id: string): Promise<Note | null> {
  await pull();
  const c = coreConfig();
  const abs = join(c.vaultDir, ...id.split("/")) + ".md";
  try {
    await stat(abs);
  } catch {
    return null;
  }
  return readNoteFile(abs);
}

/**
 * Notiz speichern: schreibt die .md und committet/pusht über den Git-Service.
 * Gibt die frisch gelesene Notiz zurück (inkl. aktualisiertem updatedAt).
 *
 * Story 1.7 — frontmatter lifecycle rules:
 *   - `id` and `created` from the on-disk version always win (identity is
 *     immutable once a note exists).
 *   - `updated` becomes "now" on every save.
 *   - Other fields (title, tags, custom keys) from the supplied body's
 *     frontmatter (if any) override the on-disk values.
 *   - If the file does not yet exist, this acts as an upsert: ULID is
 *     generated, `created = updated = now`.
 *   - The merged frontmatter is validated against its type schema; failure
 *     throws `FrontmatterValidationError` BEFORE any git operation.
 */
export async function saveNote(id: string, body: string): Promise<Note> {
  const c = coreConfig();
  const relPath = id + ".md";
  const abs = join(c.vaultDir, ...id.split("/")) + ".md";

  // 1. Load existing on-disk frontmatter, if any.
  let existing: FrontmatterMap = {};
  try {
    const onDisk = await readFile(abs, "utf8");
    existing = parseFrontmatter(onDisk).data;
  } catch {
    // file does not exist — upsert path
  }

  // 2. Parse the incoming body. If it has frontmatter, use it; otherwise
  //    treat the entire input as body and reuse existing frontmatter.
  const incoming = parseFrontmatter(body);
  const incomingHasFrontmatter = Object.keys(incoming.data).length > 0;
  const incomingData = incomingHasFrontmatter ? incoming.data : existing;
  const bodyText = incomingHasFrontmatter ? incoming.body : body;

  // 3. Merge — incoming wins for everything EXCEPT id/created (and except
  //    when there's no existing record, in which case generate).
  const now = new Date().toISOString();
  const merged: FrontmatterMap = {
    ...incomingData,
    id: (existing.id as string | undefined) ?? (incomingData.id as string | undefined) ?? generateUlid(),
    type: (incomingData.type as DocType | undefined) ?? (existing.type as DocType | undefined) ?? "note",
    title:
      (incomingData.title as string | undefined) ??
      (existing.title as string | undefined) ??
      (id.split("/").pop() ?? id),
    created: (existing.created as string | undefined) ?? (incomingData.created as string | undefined) ?? now,
    updated: now,
  };

  // 4. Validate before commit.
  const type = merged.type as DocType;
  const validation = validateFrontmatter(merged, type);
  if (!validation.valid) {
    throw new FrontmatterValidationError({
      message: `Frontmatter for save of "${id}" failed validation.`,
      noteId: id,
      errors: validation.errors,
    });
  }

  // 5. Serialize and commit.
  const content = serializeFrontmatter(merged, bodyText);
  await save(relPath, content, `notiz: ${id}`);
  const saved = await readNoteFile(abs);
  // ID-Badge / AI-Prompt feature — drop the ULID cache so a freshly
  // saved note's path (or a renamed id field, defensive) is resolvable
  // immediately on the next findByUlid call.
  invalidateUlidCache();

  // 6. Fire-and-forget BM25 index refresh (Phase A Wave A1 / Story 2).
  //    Mirrors the existing Tier-2 embedding hook — never blocks the save
  //    path, errors are logged only.
  //
  //    Phase C Wave C3 / Story 2 — Cognee `forget()` primitive: the merged
  //    frontmatter's `forgotten` field is mirrored into the search corpus
  //    so the next query naturally hides this note. The frontmatter is
  //    still the source of truth; the DB column is the index.
  queueSearchIndexRefresh(
    DEFAULT_VAULT_ID,
    saved.id,
    saved.title,
    saved.body,
    saved.tags,
    isForgotten(merged),
  );
  // 7. Phase C Wave C2 / Story 1 — bi-temporal-edge sync. Fire-and-forget;
  //    git commit already succeeded, this is derived index maintenance.
  queueTemporalEdgeSync(saved.id, saved.links, new Date(saved.updatedAt));
  return saved;
}

/* ------------------------------------------------------------------ *
 *  Datei-Baum & Struktur-Operationen
 *
 *  Der Vault IST die Ordnerstruktur — eine Notiz-id wie "pai/hermes"
 *  ist schlicht ihr Pfad. Hier wird daraus ein verschachtelter Baum
 *  gebaut und es gibt Operationen zum Anlegen, Umbenennen, Verschieben
 *  und Löschen. Alles geht über den Git-Service, also direkt nach
 *  Forgejo.
 * ------------------------------------------------------------------ */

/** Rekursiv einen Verzeichnis-Teilbaum als TreeNode[] aufbauen. */
async function buildTreeDir(
  absDir: string,
  relDir: string,
): Promise<TreeNode[]> {
  const entries = await readdir(absDir, { withFileTypes: true });
  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .git, .gitkeep …
    const abs = join(absDir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      nodes.push({
        type: "folder",
        name: entry.name,
        path: rel,
        children: await buildTreeDir(abs, rel),
      });
    } else if (entry.name.endsWith(".md")) {
      // Obsidian-treu: im Baum zählt der Dateiname, nicht die H1.
      // Dadurch ist "Umbenennen" = Datei umbenennen, ohne Mismatch.
      nodes.push({
        type: "note",
        name: entry.name.replace(/\.md$/, ""),
        path: rel.replace(/\.md$/, ""),
        children: [],
      });
    }
  }

  // Ordner zuerst, dann Notizen — innerhalb alphabetisch.
  nodes.sort((a, b) =>
    a.type !== b.type
      ? a.type === "folder"
        ? -1
        : 1
      : a.name.localeCompare(b.name),
  );
  return nodes;
}

/** Kompletter Datei-Baum des Vaults. Pullt vorher. */
export async function getTree(): Promise<TreeNode[]> {
  await pull();
  const c = coreConfig();
  return buildTreeDir(c.vaultDir, "");
}

export interface CreateNoteOpts {
  /** Doc type. Defaults to "note". Must be a SPEC DOC_TYPES value. */
  type?: DocType;
  /** Caller-supplied ULID. If absent, generated. */
  id?: string;
  /** Human title. Defaults to the last path segment of the note id. */
  title?: string;
  /** Extra frontmatter fields merged in (e.g. `source: "youtube"` for captures). */
  extra?: FrontmatterMap;
  /**
   * Story 10.2 (AC#5) — when `true`, the supplied `id` (note path) is
   * checked against the canonical folder for `type`; a contradictory path
   * (folder ≠ canonical folder and not an allowed sub-folder) throws
   * `TypeFolderMismatchError` BEFORE any git operation. Default `false` so
   * existing callers (the REST route, sleep passes) keep their freeform
   * placement — only the MCP `create_note` tool opts in.
   */
  validatePlacement?: boolean;
  /**
   * Phase B Wave B3 / Story 1 — Encoding-Context (Tulving 1973). Captured
   * at create-time and persisted as `encoded:` in the frontmatter. The
   * server route assembles it from the request (User-Agent device,
   * current weekday/time-of-day, recently-opened notes); the helper
   * `captureEncodingContext` in `scoring/encodingContext.ts` does the
   * derivation. NEVER updated by `saveNote` — encoding is a one-shot event.
   */
  encoded?: EncodedContext;
}

/**
 * Neue Notiz anlegen. `id` ist der Pfad ohne ".md" (z.B. "pai/neue-notiz").
 * Wirft, falls schon vorhanden — kein versehentliches Überschreiben.
 *
 * Story 1.6: writes SPEC-valid frontmatter so the lokyy-vault pre-commit
 * hook never rejects an app-initiated write. Throws
 * `FrontmatterValidationError` if the synthesized frontmatter would fail
 * validation (defensive — should not fire under normal use).
 */
export async function createNote(
  id: string,
  body?: string,
  opts: CreateNoteOpts = {},
): Promise<Note> {
  const c = coreConfig();
  const abs = join(c.vaultDir, ...id.split("/")) + ".md";
  try {
    await stat(abs);
    throw new Error(`Notiz "${id}" existiert bereits.`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("existiert bereits")) {
      throw err;
    }
    // stat hat geworfen -> Datei gibt es nicht, weiter geht's
  }

  const type: DocType = opts.type ?? "note";

  // Story 10.2 (AC#5) — opt-in placement guard. The folder of the supplied
  // path must be the type's canonical folder or a sub-folder of it
  // (e.g. `30_captures/youtube/…`). Throws BEFORE any git op so the caller
  // can surface a `type-folder-mismatch` correction.
  if (opts.validatePlacement) {
    const placement = checkPathMatchesType(type, id);
    if (!placement.ok) {
      throw new TypeFolderMismatchError({
        type: placement.type,
        expectedFolder: placement.expectedFolder,
        gotPath: placement.gotPath,
      });
    }
  }

  const title = opts.title ?? (id.split("/").pop() ?? id);
  const now = new Date().toISOString();
  const frontmatter: FrontmatterMap = {
    id: opts.id ?? generateUlid(),
    type,
    title,
    created: now,
    updated: now,
    ...(opts.extra ?? {}),
  };
  // Encoding-context (Tulving 1973) — only attach when the caller supplied
  // a block. `extra` may have already provided one for tests; we override
  // with the explicit `opts.encoded` so the route-level capture wins.
  if (opts.encoded) {
    frontmatter.encoded = opts.encoded;
  }

  const validation = validateFrontmatter(frontmatter, type);
  if (!validation.valid) {
    throw new FrontmatterValidationError({
      message: `Frontmatter for new note "${id}" failed validation.`,
      noteId: id,
      errors: validation.errors,
    });
  }

  const noteBody = body ?? `# ${title}\n\n`;
  const content = serializeFrontmatter(frontmatter, noteBody);
  await save(id + ".md", content, `notiz angelegt: ${id}`);
  const created = await readNoteFile(abs);
  // ID-Badge / AI-Prompt feature — drop the ULID cache so the new
  // note's ULID immediately resolves via findByUlid.
  invalidateUlidCache();
  // Phase A Wave A1 / Story 2 — keep the BM25 corpus in sync.
  //
  // Phase C Wave C3 / Story 2 — pass the just-written `forgotten` flag from
  // the frontmatter (newly created notes are almost always not forgotten,
  // but `opts.extra` could in principle carry the field e.g. for a pipe
  // that imports archived material).
  queueSearchIndexRefresh(
    DEFAULT_VAULT_ID,
    created.id,
    created.title,
    created.body,
    created.tags,
    isForgotten(frontmatter),
  );
  // Phase C Wave C2 / Story 1 — bi-temporal-edge sync (fire-and-forget).
  queueTemporalEdgeSync(created.id, created.links, new Date(created.updatedAt));
  return created;
}

/* ------------------------------------------------------------------ *
 *  Story 10.10 — Bulk-Ops: createNotes / updateNotes (atomar)
 *
 *  Goal: an agent setting up a project writes N notes in ONE call instead
 *  of N round-trips. Contract: "all or nothing on validation" — every item
 *  is pre-flight validated (frontmatter synthesis + Story-10.2 type→folder
 *  rules) BEFORE any git write; if a single item fails validation, NOTHING
 *  is written and a structured result names the offending item + reason.
 *
 *  ── Atomicity caveat (documented gap) ───────────────────────────────
 *  True single-commit atomicity (stage all files → one commit) is NOT
 *  achievable here: `gitService` only exposes a per-file `save()` (each call
 *  is its own add→commit→pull→push), and its serialization `lock` is module-
 *  private — there is no public batch-commit entry point. Editing
 *  `gitService.ts` is out of scope this wave (owned by Agent G / Story 10.12).
 *
 *  Best-available approach implemented here:
 *    1. PRE-FLIGHT: validate ALL items first (existence, synthesized
 *       frontmatter, placement). On any failure → write nothing, return the
 *       structured failure. This fully satisfies AC#2 for the validation
 *       case (the overwhelmingly common failure mode).
 *    2. WRITE: replay each item through the existing createNote/saveNote.
 *       Each is committed individually.
 *  Residual gap: a *git-level* failure on item k>0 (e.g. a mid-batch merge
 *  conflict — not a validation error) leaves items 0..k-1 already committed.
 *  That partial state is reported via `committed` so the caller can react;
 *  it is NOT silently swallowed. Closing this gap requires a batch-commit
 *  API on gitService (Story 10.12).
 * ------------------------------------------------------------------ */

/** One note to create in a bulk `createNotes` call. Mirrors createNote args. */
export interface BulkCreateItem {
  /** Note id == path without ".md" (e.g. "20_notes/idea"). */
  id: string;
  /** Optional markdown body. Defaults to `# {title}` like createNote. */
  body?: string;
  /** Per-item createNote options (type, title, extra, validatePlacement…). */
  opts?: CreateNoteOpts;
}

/** One note to update in a bulk `updateNotes` call. Mirrors saveNote args. */
export interface BulkUpdateItem {
  /** Note id == path without ".md" of an existing note. */
  id: string;
  /** New body (with or without frontmatter — same rules as saveNote). */
  body: string;
}

/** Structured failure for a single offending item in a bulk op. */
export interface BulkItemError {
  /** The id of the item that failed pre-flight validation. */
  id: string;
  /** Machine-readable reason class. */
  reason:
    | "already-exists"
    | "not-found"
    | "frontmatter-invalid"
    | "type-folder-mismatch"
    | "duplicate-id"
    | "unknown";
  /** Human-readable message (the underlying error message). */
  message: string;
}

/** Result of a bulk op. `ok:false` ⇒ nothing was written (validation gate). */
export type BulkResult<T> =
  | { ok: true; notes: T[] }
  | {
      ok: false;
      /** The single item that tripped the pre-flight validation gate. */
      error: BulkItemError;
      /**
       * Ids already committed before a *git-level* (non-validation) failure
       * mid-write. Empty for the pure validation-failure path (the common
       * case), which writes nothing at all. See the atomicity caveat above.
       */
      committed: string[];
    };

/**
 * Pre-flight a single create item WITHOUT touching git: replays exactly the
 * checks `createNote` performs before its first `save()` call — existence,
 * type→folder placement (when opted in), and synthesized-frontmatter
 * validation. Returns `null` on success, or a structured error otherwise.
 *
 * Keeping this in lock-step with `createNote` is the whole point: if it
 * passes here, the real `createNote` will not reject for a validation reason.
 */
async function preflightCreate(
  item: BulkCreateItem,
): Promise<BulkItemError | null> {
  const { id } = item;
  const opts = item.opts ?? {};
  const c = coreConfig();
  const abs = join(c.vaultDir, ...id.split("/")) + ".md";

  // (a) must not already exist — mirrors createNote's stat guard.
  try {
    await stat(abs);
    return {
      id,
      reason: "already-exists",
      message: `Notiz "${id}" existiert bereits.`,
    };
  } catch {
    // not present — good, continue.
  }

  const type: DocType = opts.type ?? "note";

  // (b) opt-in placement guard (Story 10.2) — same as createNote.
  if (opts.validatePlacement) {
    const placement = checkPathMatchesType(type, id);
    if (!placement.ok) {
      return {
        id,
        reason: "type-folder-mismatch",
        message:
          `type "${placement.type}" expects folder "${placement.expectedFolder}" ` +
          `but path is "${placement.gotPath}".`,
      };
    }
  }

  // (c) synthesize the exact frontmatter createNote would build and validate
  //     it — catches a malformed caller-supplied id, bad extra fields, etc.
  const title = opts.title ?? (id.split("/").pop() ?? id);
  const now = new Date().toISOString();
  const frontmatter: FrontmatterMap = {
    id: opts.id ?? generateUlid(),
    type,
    title,
    created: now,
    updated: now,
    ...(opts.extra ?? {}),
  };
  if (opts.encoded) frontmatter.encoded = opts.encoded;

  const validation = validateFrontmatter(frontmatter, type);
  if (!validation.valid) {
    return {
      id,
      reason: "frontmatter-invalid",
      message: `Frontmatter for new note "${id}" failed validation: ${validation.errors
        .map((e) => e.message)
        .join("; ")}`,
    };
  }
  return null;
}

/**
 * Pre-flight a single update item WITHOUT touching git: replays saveNote's
 * pre-commit checks — the target must exist, and the merged frontmatter must
 * validate. Bulk-update is an UPDATE, not an upsert, so a missing target is a
 * validation failure (the bulk caller wants "all or nothing on a known set").
 */
async function preflightUpdate(
  item: BulkUpdateItem,
): Promise<BulkItemError | null> {
  const { id, body } = item;
  const c = coreConfig();
  const abs = join(c.vaultDir, ...id.split("/")) + ".md";

  // (a) target must exist — bulk update never creates.
  let existing: FrontmatterMap = {};
  try {
    const onDisk = await readFile(abs, "utf8");
    existing = parseFrontmatter(onDisk).data;
  } catch {
    return {
      id,
      reason: "not-found",
      message: `Notiz "${id}" existiert nicht.`,
    };
  }

  // (b) mirror saveNote's merge + validation exactly.
  const incoming = parseFrontmatter(body);
  const incomingHasFrontmatter = Object.keys(incoming.data).length > 0;
  const incomingData = incomingHasFrontmatter ? incoming.data : existing;

  const now = new Date().toISOString();
  const merged: FrontmatterMap = {
    ...incomingData,
    id:
      (existing.id as string | undefined) ??
      (incomingData.id as string | undefined) ??
      generateUlid(),
    type:
      (incomingData.type as DocType | undefined) ??
      (existing.type as DocType | undefined) ??
      "note",
    title:
      (incomingData.title as string | undefined) ??
      (existing.title as string | undefined) ??
      (id.split("/").pop() ?? id),
    created:
      (existing.created as string | undefined) ??
      (incomingData.created as string | undefined) ??
      now,
    updated: now,
  };

  const type = merged.type as DocType;
  const validation = validateFrontmatter(merged, type);
  if (!validation.valid) {
    return {
      id,
      reason: "frontmatter-invalid",
      message: `Frontmatter for save of "${id}" failed validation: ${validation.errors
        .map((e) => e.message)
        .join("; ")}`,
    };
  }
  return null;
}

/** Catch in-batch duplicate ids before writing (two items same path). */
function firstDuplicateId(ids: string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/**
 * Bulk-create notes atomically with respect to VALIDATION: every item is
 * pre-flighted (frontmatter + Story-10.2 placement) before any git write. If
 * a single item fails, nothing is written and the offending item + reason is
 * returned. See the atomicity caveat at the top of this section for the
 * residual git-level gap.
 */
export async function createNotes(
  items: BulkCreateItem[],
): Promise<BulkResult<Note>> {
  // (0) in-batch duplicate-id guard — two items targeting the same path would
  //     otherwise see the second fail as "already-exists" only AFTER the first
  //     is committed. Reject up front so the batch stays write-nothing.
  const dup = firstDuplicateId(items.map((i) => i.id));
  if (dup !== null) {
    return {
      ok: false,
      error: {
        id: dup,
        reason: "duplicate-id",
        message: `Duplicate id "${dup}" appears more than once in the batch.`,
      },
      committed: [],
    };
  }

  // (1) PRE-FLIGHT all items — write nothing if any fails validation.
  for (const item of items) {
    const err = await preflightCreate(item);
    if (err) return { ok: false, error: err, committed: [] };
  }

  // (2) WRITE — replay through the existing createNote (per-item commit).
  const created: Note[] = [];
  for (const item of items) {
    try {
      created.push(await createNote(item.id, item.body, item.opts));
    } catch (err) {
      // A non-validation (git-level) failure mid-batch. Pre-flight already
      // cleared validation, so this is e.g. a transient git error. Report the
      // partial state honestly rather than masking it.
      return {
        ok: false,
        error: {
          id: item.id,
          reason: "unknown",
          message: err instanceof Error ? err.message : String(err),
        },
        committed: created.map((n) => n.id),
      };
    }
  }
  return { ok: true, notes: created };
}

/**
 * Bulk-update notes atomically with respect to VALIDATION: every item is
 * pre-flighted (existence + merged-frontmatter validity) before any git
 * write. A missing target is treated as a validation failure (bulk update is
 * not an upsert). On any failure nothing is written. See the atomicity caveat
 * above for the residual git-level gap.
 */
export async function updateNotes(
  items: BulkUpdateItem[],
): Promise<BulkResult<Note>> {
  const dup = firstDuplicateId(items.map((i) => i.id));
  if (dup !== null) {
    return {
      ok: false,
      error: {
        id: dup,
        reason: "duplicate-id",
        message: `Duplicate id "${dup}" appears more than once in the batch.`,
      },
      committed: [],
    };
  }

  // (1) PRE-FLIGHT all items — write nothing if any fails validation.
  for (const item of items) {
    const err = await preflightUpdate(item);
    if (err) return { ok: false, error: err, committed: [] };
  }

  // (2) WRITE — replay through the existing saveNote (per-item commit).
  const saved: Note[] = [];
  for (const item of items) {
    try {
      saved.push(await saveNote(item.id, item.body));
    } catch (err) {
      return {
        ok: false,
        error: {
          id: item.id,
          reason: "unknown",
          message: err instanceof Error ? err.message : String(err),
        },
        committed: saved.map((n) => n.id),
      };
    }
  }
  return { ok: true, notes: saved };
}

/**
 * Neuen (leeren) Ordner anlegen. Git trackt keine leeren Verzeichnisse,
 * daher legen wir eine `.gitkeep` an — beim ersten echten Inhalt kann sie
 * weg, muss aber nicht.
 */
export async function createFolder(path: string): Promise<void> {
  await save(`${path}/.gitkeep`, "", `ordner angelegt: ${path}`);
}

/**
 * Verschieben oder Umbenennen. `kind` entscheidet, ob ".md" angehängt wird;
 * für Ordner werden die Pfade direkt durchgereicht. Rename ist nur ein
 * Move mit gleichbleibendem Elternverzeichnis.
 */
export async function moveEntry(
  from: string,
  to: string,
  kind: "note" | "folder",
): Promise<void> {
  const fromRel = kind === "note" ? `${from}.md` : from;
  const toRel = kind === "note" ? `${to}.md` : to;
  await move(fromRel, toRel, `${kind} verschoben: ${from} -> ${to}`);
  // ID-Badge / AI-Prompt feature — drop the ULID cache so the moved
  // note's new path is what findByUlid returns. The ULID itself is
  // stable across moves; only the cached `path` field becomes stale.
  invalidateUlidCache();

  // Phase A Wave A1 / Story 2 — keep BM25 corpus in sync on rename/move.
  // The note id == path-without-".md", so a move changes the id. Remove the
  // old row, then upsert the new one from the freshly read note.
  if (kind === "note") {
    queueSearchIndexRemove(from);
    const c = coreConfig();
    const newAbs = join(c.vaultDir, ...to.split("/")) + ".md";
    try {
      const moved = await readNoteFile(newAbs);
      // Phase C Wave C3 / Story 2 — carry the `forgotten` flag across the
      // rename. Parse the moved file's frontmatter on the fly.
      let movedForgotten = false;
      try {
        movedForgotten = isForgotten(parseFrontmatter(moved.body).data);
      } catch {
        movedForgotten = false;
      }
      queueSearchIndexRefresh(
        DEFAULT_VAULT_ID,
        moved.id,
        moved.title,
        moved.body,
        moved.tags,
        movedForgotten,
      );
    } catch {
      // Note disappeared between move and read — ignore.
    }
  }
}

/** Notiz oder Ordner löschen. */
export async function deleteEntry(
  path: string,
  kind: "note" | "folder",
): Promise<void> {
  const rel = kind === "note" ? `${path}.md` : path;
  await remove(rel, `${kind} gelöscht: ${path}`);
  if (kind === "note") {
    // Phase A Wave A1 / Story 2 — drop the BM25 row.
    queueSearchIndexRemove(path);
  }
  // ID-Badge / AI-Prompt feature — drop the ULID cache so a deleted
  // note stops resolving via findByUlid.
  invalidateUlidCache();
}

/* ------------------------------------------------------------------ *
 *  Story 10.3 — delete_note: soft-delete (trash) + hard-delete
 *
 *  The MCP `delete_note(path, hard?)` tool (Agent C) wires these two
 *  helpers: `hard=false` (default) → `trashEntry` (a recoverable Move into
 *  `99_archive/_trash/`); `hard=true` → the existing `deleteEntry`. Both
 *  run through `gitService` (no direct `fs.unlink` — AC#6).
 * ------------------------------------------------------------------ */

/** Canonical trash folder for soft-deleted notes (Story 10.3, AC#1). */
export const TRASH_FOLDER = "99_archive/_trash";

/** ISO date stamp `YYYY-MM-DD` (UTC) for the dated trash path. */
function trashDateStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Result of a soft-delete: where the note now lives + its original path. */
export interface TrashResult {
  /** The note id (path without `.md`) the note had before the move. */
  from: string;
  /** The note id it now lives at under `99_archive/_trash/`. */
  to: string;
}

/**
 * Soft-delete a note by MOVING it to `99_archive/_trash/{YYYY-MM-DD}-{slug}`
 * (Story 10.3, AC#1). The original leaf name is the slug; a date prefix keeps
 * the trash chronologically sorted and avoids collisions when the same note
 * name is trashed on different days. Goes through the existing `moveEntry`,
 * so the move is committed via `gitService` and the BM25 index is updated to
 * the new path (AC#3 — the note stays indexed under its trash path, which is
 * acceptable; a follow-up re-index is unnecessary).
 *
 * Throws when the source note does not exist (`not-found` is the caller's
 * concern — Agent C checks existence first; this guard is defensive so a
 * race never produces an empty commit). Folders are not soft-deleted — the
 * MCP tool routes folder hard-deletes straight to `deleteEntry`.
 *
 * `now` is injectable for deterministic tests.
 */
export async function trashEntry(
  path: string,
  now: Date = new Date(),
): Promise<TrashResult> {
  const c = coreConfig();
  const abs = join(c.vaultDir, ...path.split("/")) + ".md";
  try {
    await stat(abs);
  } catch {
    throw new Error(`Notiz "${path}" existiert nicht.`);
  }

  const slug = path.split("/").pop() ?? path;
  const to = `${TRASH_FOLDER}/${trashDateStamp(now)}-${slug}`;
  // moveEntry handles the git move + ULID-cache + BM25 reindex under the new id.
  await moveEntry(path, to, "note");
  return { from: path, to };
}
