import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  coreConfig,
  createFolder,
  createNote,
  deleteEntry,
  generateUlid,
  getTree,
  moveEntry,
  saveBinary,
} from "@lokyy/core";

/**
 * Erlaubte Asset-MIME-Typen für `POST /api/vault/asset`.
 * Map auf die Dateiendung — die landet im Vault-Pfad.
 */
const ASSET_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const ASSET_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Content-Type Mapping für `GET /api/vault/file/...`.
 * Bewusst klein gehalten — alles Unbekannte fällt auf
 * `application/octet-stream` zurück, das ist sicherer als raten.
 */
const FILE_EXT_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

/**
 * /api/vault — Struktur des Vaults: der Datei-Baum und alle Operationen,
 * die Ordner/Notizen anlegen, umbenennen, verschieben oder löschen.
 *
 * Bewusst getrennt von /api/notes (Inhalt) — hier geht es nur um die
 * Ordnung, dort um den Text einer einzelnen Notiz.
 */
export const vaultRoutes = new Hono();

// GET /api/vault/tree -> TreeNode[]
vaultRoutes.get("/tree", async (c) => {
  return c.json(await getTree());
});

// POST /api/vault/note  { path, body? }  -> neue Notiz
vaultRoutes.post("/note", async (c) => {
  const { path, body } = await c.req.json<{ path: string; body?: string }>();
  if (!path) return c.json({ error: "path erforderlich" }, 400);
  try {
    return c.json(await createNote(path, body), 201);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Anlegen fehlgeschlagen" },
      409,
    );
  }
});

// POST /api/vault/folder  { path }  -> neuer Ordner
vaultRoutes.post("/folder", async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  if (!path) return c.json({ error: "path erforderlich" }, 400);
  try {
    await createFolder(path);
    return c.json({ ok: true }, 201);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Anlegen fehlgeschlagen" },
      409,
    );
  }
});

// POST /api/vault/move  { from, to, kind }  -> verschieben / umbenennen
vaultRoutes.post("/move", async (c) => {
  const { from, to, kind } = await c.req.json<{
    from: string;
    to: string;
    kind: "note" | "folder";
  }>();
  if (!from || !to || !kind) {
    return c.json({ error: "from, to, kind erforderlich" }, 400);
  }
  try {
    await moveEntry(from, to, kind);
    return c.json({ ok: true });
  } catch (err) {
    return c.json(
      {
        error:
          err instanceof Error ? err.message : "Verschieben fehlgeschlagen",
      },
      409,
    );
  }
});

// DELETE /api/vault/entry?path=…&kind=note|folder
vaultRoutes.delete("/entry", async (c) => {
  const path = c.req.query("path");
  const kind = c.req.query("kind") as "note" | "folder" | undefined;
  if (!path || !kind) {
    return c.json({ error: "path und kind erforderlich" }, 400);
  }
  try {
    await deleteEntry(path, kind);
    return c.json({ ok: true });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Löschen fehlgeschlagen" },
      409,
    );
  }
});

/**
 * POST /api/vault/asset — Bild-Upload (paste / drag-drop aus dem Editor).
 *
 * multipart/form-data, Feld `file`. Bytes landen unter
 * `30_captures/assets/{ULID}.{ext}` im Vault, commit + push direkt nach
 * Forgejo via `saveBinary` (kein Markdown — keine Frontmatter, der vault
 * pre-commit Hook prüft nur `.md`).
 */
vaultRoutes.post("/asset", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "multipart/form-data erwartet" }, 400);
  }

  const fileEntry = form.get("file");
  if (!(fileEntry instanceof File)) {
    return c.json({ error: "Feld 'file' erforderlich" }, 400);
  }

  if (fileEntry.size > ASSET_MAX_BYTES) {
    return c.json(
      { error: `Datei zu groß (max ${ASSET_MAX_BYTES} bytes).` },
      413,
    );
  }

  const ext = ASSET_MIME_EXT[fileEntry.type];
  if (!ext) {
    return c.json(
      { error: `MIME-Typ ${fileEntry.type || "unbekannt"} nicht erlaubt.` },
      415,
    );
  }

  const id = generateUlid();
  const relPath = `30_captures/assets/${id}.${ext}`;
  const buf = new Uint8Array(await fileEntry.arrayBuffer());

  try {
    await saveBinary(relPath, buf, `asset: ${id}.${ext}`);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Asset-Upload fehlgeschlagen" },
      409,
    );
  }

  return c.json(
    {
      url: `/api/vault/file/${relPath}`,
      relPath,
      id,
    },
    201,
  );
});

/**
 * GET /api/vault/file/:path{.+} — liest eine Datei aus dem Vault und
 * streamt die rohen Bytes. Für Asset-URLs aus `POST /asset` und
 * `<img src=...>` im Live-Preview.
 *
 * Pfad-Traversal (`..`) ist hart verboten — wir bauen den absoluten
 * Pfad selbst zusammen und prüfen, dass er weiterhin unter `vaultDir`
 * liegt (defense-in-depth).
 */
vaultRoutes.get("/file/:path{.+}", async (c) => {
  const relPath = c.req.param("path");
  if (!relPath || relPath.includes("..")) {
    return c.json({ error: "Ungültiger Pfad" }, 400);
  }

  const { vaultDir } = coreConfig();
  const abs = join(vaultDir, relPath);
  // defense-in-depth — falls join() etwas tut, das wir nicht erwarten
  if (!abs.startsWith(vaultDir)) {
    return c.json({ error: "Ungültiger Pfad" }, 400);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch {
    return c.json({ error: "Datei nicht gefunden" }, 404);
  }

  const dot = relPath.lastIndexOf(".");
  const ext = dot >= 0 ? relPath.slice(dot + 1).toLowerCase() : "";
  const contentType = FILE_EXT_CONTENT_TYPE[ext] ?? "application/octet-stream";

  c.header("Content-Type", contentType);
  c.header("Cache-Control", "private, max-age=3600");
  // Buffer ist ein Uint8Array → in einen frischen ArrayBuffer kopieren,
  // damit der Response-Body-Typ stabil ist.
  const body = new Uint8Array(bytes).buffer;
  return c.body(body);
});
