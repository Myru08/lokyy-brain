import type {
  GraphData,
  ImportDefaults,
  ImportRequest,
  Note,
  NoteSummary,
  PipeJob,
  TreeNode,
} from "@lokyy/shared";

/**
 * Dataview query shape — kept in sync with `@lokyy/core`'s `DataviewQuery`.
 * Defined here (not imported) because `@lokyy/core` has node-only deps and
 * is forbidden from the PWA bundle.
 */
export interface DataviewQuery {
  from?: string;
  where?: Record<string, unknown>;
  select?: string[];
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
}

export type DataviewRow = Record<string, string | number | boolean | null>;

/**
 * API-Client. Dünne fetch-Wrapper. Der Server pullt vor jedem Lesen selbst —
 * der Client muss sich um Git nicht kümmern.
 *
 * TODO Offline: hier kommt der IndexedDB-Layer rein — bei fehlender
 * Verbindung aus dem Cache lesen und Saves in eine Queue legen, die beim
 * Reconnect über putNote() durchläuft.
 */

const BASE = "/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, err.error ?? "Anfrage fehlgeschlagen");
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
  /** true bei Merge-Konflikt — die UI kann dann gezielt darauf reagieren. */
  get isConflict() {
    return this.status === 409;
  }
}

export const api = {
  listNotes: () => fetch(`${BASE}/notes`).then(json<NoteSummary[]>),

  getNote: (id: string) =>
    fetch(`${BASE}/notes/${id}`).then(json<Note>),

  /** Speichern -> Server committet & pusht nach Forgejo.
   *  Bei Offline / Netzwerkfehler -> Eintrag in die Offline-Queue,
   *  Auto-Replay sobald wieder online (Story 4.2 + 4.3). */
  putNote: async (id: string, body: string): Promise<Note> => {
    const endpoint = `${BASE}/notes/${id}`;
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        credentials: "include",
      });
      if (!res.ok) throw new ApiError(res.status, await res.text());
      return (await res.json()) as Note;
    } catch (err) {
      if (!navigator.onLine || err instanceof TypeError) {
        const { enqueueWrite } = await import("./offline/queue.js");
        await enqueueWrite({ endpoint, method: "PUT", body: { body } });
        // Optimistic stub — caller treats this as "saved locally".
        return {
          id,
          path: id + ".md",
          title: id.split("/").pop() ?? id,
          body,
          tags: [],
          links: [],
          aliases: [],
          updatedAt: new Date().toISOString(),
        };
      }
      throw err;
    }
  },

  graph: () => fetch(`${BASE}/graph`).then(json<GraphData>),

  /** Welche Notes linken auf `id`? */
  backlinks: (id: string) =>
    fetch(`${BASE}/graph/backlinks/${id}`).then(
      json<{ backlinks: { noteId: string; title: string; context: string }[] }>,
    ),

  /** Alle Tags im Vault, mit Häufigkeit und referenzierenden Note-IDs. */
  listTags: async (): Promise<
    { tag: string; count: number; noteIds: string[] }[]
  > => {
    const r = await fetch(`${BASE}/graph/tags`, { credentials: "include" });
    if (!r.ok) throw new Error("listTags failed");
    return (await r.json()).tags;
  },

  /** Fuzzy-Search via Tier1+2 für Command-Palette. */
  search: (query: string, limit = 20) =>
    fetch(`${BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
    }).then(
      json<{
        results: {
          noteId: string;
          title: string;
          snippet?: string;
          score: number;
          tier: "t1" | "t2";
        }[];
      }>,
    ),

  pipes: () => fetch(`${BASE}/pipes`).then(json<PipeJob[]>),

  /* --- Vault-Struktur: Datei-Baum + Operationen --- */

  tree: () => fetch(`${BASE}/vault/tree`).then(json<TreeNode[]>),

  createNote: (path: string, body?: string) =>
    fetch(`${BASE}/vault/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, body }),
    }).then(json<Note>),

  createFolder: (path: string) =>
    fetch(`${BASE}/vault/folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).then(json<{ ok: true }>),

  /** Verschieben oder Umbenennen (Rename = Move im selben Ordner). */
  move: (from: string, to: string, kind: "note" | "folder") =>
    fetch(`${BASE}/vault/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, kind }),
    }).then(json<{ ok: true }>),

  remove: (path: string, kind: "note" | "folder") =>
    fetch(
      `${BASE}/vault/entry?path=${encodeURIComponent(path)}&kind=${kind}`,
      { method: "DELETE" },
    ).then(json<{ ok: true }>),

  /** Aktiver Import aus dem Import-Panel (Website, YouTube …). */
  importUrl: (req: ImportRequest) =>
    fetch(`${BASE}/pipes/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }).then(json<PipeJob>),

  /**
   * Liest PWA-relevante Defaults aus den System-Settings.
   *
   * Aktuell nur `defaultImportFolder` für das Import-Panel (Story 4b).
   * Antwort fällt server-seitig auf `"30_captures"` zurück, wenn der
   * Settings-Agent aus Wave 4a noch keinen Wert geschrieben hat — das
   * Panel sieht also nie ein `undefined`.
   */
  getImportDefaults: () =>
    fetch(`${BASE}/settings/import-defaults`).then(json<ImportDefaults>),

  /**
   * Asset (Bild) in den Vault hochladen. Server schreibt unter
   * `30_captures/assets/{ULID}.{ext}` und committet nach Forgejo.
   * Antwort enthält die URL, mit der der Client das Bild laden kann.
   */
  uploadAsset: async (
    file: File,
  ): Promise<{ url: string; relPath: string }> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE}/vault/asset`, {
      method: "POST",
      body: form,
      credentials: "include",
    });
    const data = await json<{ url: string; relPath: string; id: string }>(res);
    return { url: data.url, relPath: data.relPath };
  },

  /**
   * Templates — list reusable note templates from `00_meta/templates/`.
   * Returns the lightweight refs used by the template picker UI.
   */
  listTemplates: async (): Promise<
    { name: string; path: string; preview: string }[]
  > => {
    const r = await fetch(`${BASE}/templates`, { credentials: "include" });
    const data = await json<{
      templates: { name: string; path: string; preview: string }[];
    }>(r);
    return data.templates;
  },

  /** Fetch the full body of a single template by name (filename minus `.md`). */
  getTemplate: (name: string): Promise<{ name: string; body: string }> =>
    fetch(`${BASE}/templates/${encodeURIComponent(name)}`, {
      credentials: "include",
    }).then(json<{ name: string; body: string }>),

  /**
   * Dataview-like query — POST a `DataviewQuery` JSON, get back rows. The
   * CM6 dataview widget (`pwa/src/editor/dataviewWidget.ts`) is the primary
   * caller; nothing stops other UI from using it.
   */
  dataview: async (query: DataviewQuery): Promise<DataviewRow[]> => {
    const res = await fetch(`${BASE}/dataview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
      credentials: "include",
    });
    const data = await json<{ rows: DataviewRow[] }>(res);
    return data.rows;
  },
};
