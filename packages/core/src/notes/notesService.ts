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
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
  type DocType,
  type EncodedContext,
  type FrontmatterMap,
} from "../frontmatter/index.js";
import { FrontmatterValidationError } from "../errors/FrontmatterValidationError.js";
import {
  queueSearchIndexRefresh,
  queueSearchIndexRemove,
} from "../memory/index.js";
import { syncWikilinksToTemporalEdges } from "../graph/temporalEdges.js";

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

  // 6. Fire-and-forget BM25 index refresh (Phase A Wave A1 / Story 2).
  //    Mirrors the existing Tier-2 embedding hook — never blocks the save
  //    path, errors are logged only.
  queueSearchIndexRefresh(
    DEFAULT_VAULT_ID,
    saved.id,
    saved.title,
    saved.body,
    saved.tags,
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
  // Phase A Wave A1 / Story 2 — keep the BM25 corpus in sync.
  queueSearchIndexRefresh(
    DEFAULT_VAULT_ID,
    created.id,
    created.title,
    created.body,
    created.tags,
  );
  // Phase C Wave C2 / Story 1 — bi-temporal-edge sync (fire-and-forget).
  queueTemporalEdgeSync(created.id, created.links, new Date(created.updatedAt));
  return created;
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

  // Phase A Wave A1 / Story 2 — keep BM25 corpus in sync on rename/move.
  // The note id == path-without-".md", so a move changes the id. Remove the
  // old row, then upsert the new one from the freshly read note.
  if (kind === "note") {
    queueSearchIndexRemove(from);
    const c = coreConfig();
    const newAbs = join(c.vaultDir, ...to.split("/")) + ".md";
    try {
      const moved = await readNoteFile(newAbs);
      queueSearchIndexRefresh(
        DEFAULT_VAULT_ID,
        moved.id,
        moved.title,
        moved.body,
        moved.tags,
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
}
