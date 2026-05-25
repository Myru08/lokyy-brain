import type {
  GraphData,
  ImportDefaults,
  ImportRequest,
  Note,
  NoteSummary,
  PipeJob,
  TreeNode,
} from "@lokyy/shared";

/* ──────────────────────────────────────────────────────────────────────────
 * LLM provider / routing types — sync with packages/core/src/llm/types.ts.
 * Inlined here because @lokyy/core has node-only deps and is forbidden
 * from the PWA bundle. Keep field names + shapes 1:1 with the source.
 * ────────────────────────────────────────────────────────────────────── */

export type LlmRole =
  | "embedding"
  | "rerank"
  | "topic-synthesis"
  | "query-rewrite"
  | "hyde"
  | "self-rag"
  | "lint"
  | "ner"
  | "mem0-classifier"
  | "intent-classifier";

export type PrivacyTier =
  | "always_local"
  | "local_for_personal_folders"
  | "cloud_ok";

export interface ProviderConfig {
  name: string;
  preset?: string;
  /** When read back from server this is a masked form like `sk-•••…abc4`. */
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  enabled: boolean;
  monthlyBudgetUsd?: number;
}

export interface LlmRoutingConfig {
  roles: Partial<Record<LlmRole, { provider: string; model?: string }>>;
  fallbacks?: Partial<Record<LlmRole, string[]>>;
  privacyTier: PrivacyTier;
  privacyTierFolders?: string[];
}

export interface UsageStats {
  provider: string;
  monthInputTokens: number;
  monthOutputTokens: number;
  monthCostUsd: number;
  budgetUsd?: number;
  budgetPercent?: number;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  modelsAvailable?: string[];
}

/** Sync with packages/core/src/llm/providers/openai-compat.ts → PresetConfig. */
export interface OpenAICompatPreset {
  name: string;
  label: string;
  baseUrl: string;
  defaultChatModel: string;
  defaultEmbedModel?: string;
  supportsEmbed: boolean;
  isLocal: boolean;
  apiKeyRequired: boolean;
}

export interface LlmConfigResponse {
  providers: ProviderConfig[];
  routing: LlmRoutingConfig;
  usage: UsageStats[];
}

/**
 * Embedding-migration progress shape. Sync with
 * `packages/core/src/llm/embeddingsMigration.ts → MigrationProgress`.
 */
export interface MigrationProgress {
  migrationId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  totalNotes: number;
  processedNotes: number;
  currentNote?: string;
  errorCount: number;
  elapsedMs: number;
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  errorMessage?: string;
}

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

/* ──────────────────────────────────────────────────────────────────────────
 * Retrieval-Trace-Log (Phase A Wave A1 / Story 3 — Multi-Trace-Theory).
 *
 * Closed list of PWA-side retrieval sources. Keep in sync with
 * `RetrievalSource` in `@lokyy/core/scoring/retrievalLog`. The PWA only
 * emits the non-API sources — server-side `/api/notes/:id` GETs are logged
 * server-side directly.
 * ────────────────────────────────────────────────────────────────────── */
export type RetrievalSource =
  | "search"
  | "wikilink"
  | "cmd-k"
  | "cmd-o"
  | "hover"
  | "embed"
  | "api"
  | "mcp";

export interface TraceEvent {
  noteId: string;
  source: RetrievalSource;
  query?: string;
  /** Prior notes opened in this session — caller decides what to pass. */
  preceding?: string[];
  context?: Record<string, unknown>;
}

/**
 * Fire-and-forget trace logging. Never throws. Caller does NOT need to
 * await this — the helper swallows network and HTTP errors so a backend
 * outage cannot break UI flows (cmd-k click, wikilink open, hover, embed).
 *
 * We don't read the response body — the server returns 202 on success
 * regardless of whether the DB write succeeded (telemetry is best-effort
 * by design; the server-side `logRetrieval` is itself fire-and-forget).
 */
export function logTrace(event: TraceEvent): void {
  try {
    void fetch(`${BASE}/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      credentials: "include",
      // `keepalive` lets the request finish even if the page is closing.
      // We don't await the response, so this is a no-op for most calls,
      // but useful when triggered by a navigation handler.
      keepalive: true,
    }).catch(() => {
      // Swallow — telemetry must not surface as a UI error.
    });
  } catch {
    // `fetch` itself synchronously threw (rare, e.g. invalid URL). Swallow.
  }
}

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

  /* ──── LLM provider config (Wave C, AI-Provider Settings UI) ──── */

  /** Read current provider configs (masked API keys), routing + usage. */
  getLlmConfig: (): Promise<LlmConfigResponse> =>
    fetch(`${BASE}/llm/config`, { credentials: "include" }).then(
      json<LlmConfigResponse>,
    ),

  /** Persist provider configs + routing. Server returns the updated config. */
  setLlmConfig: (body: {
    providers: ProviderConfig[];
    routing: LlmRoutingConfig;
  }): Promise<LlmConfigResponse> =>
    fetch(`${BASE}/llm/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    }).then(json<LlmConfigResponse>),

  /** Ping a single configured provider; returns latency + reachable models. */
  testLlmConnection: (providerName: string): Promise<TestConnectionResult> =>
    fetch(`${BASE}/llm/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerName }),
      credentials: "include",
    }).then(json<TestConnectionResult>),

  /** Static list of the 8 OpenAI-compatible presets (openrouter, …, custom). */
  getOpenAICompatPresets: (): Promise<OpenAICompatPreset[]> =>
    fetch(`${BASE}/llm/presets/openai-compat`, {
      credentials: "include",
    }).then(json<OpenAICompatPreset[]>),

  /* ──── Embedding-Migration (Phase-0 Wave D / Agent 1) ──── */

  /** Kick off a re-embed of the entire vault under a new provider/model. */
  startEmbeddingMigration: (
    toProvider: string,
    toModel?: string,
  ): Promise<{ migrationId: string }> =>
    fetch(`${BASE}/llm/migration/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toProvider, toModel }),
      credentials: "include",
    }).then(json<{ migrationId: string }>),

  /** Snapshot progress of an active or completed migration. */
  getMigrationStatus: (id: string): Promise<MigrationProgress> =>
    fetch(`${BASE}/llm/migration/${encodeURIComponent(id)}/status`, {
      credentials: "include",
    }).then(json<MigrationProgress>),

  /** Best-effort cancel. Worker stops between notes. */
  cancelMigration: async (id: string): Promise<void> => {
    const res = await fetch(
      `${BASE}/llm/migration/${encodeURIComponent(id)}/cancel`,
      { method: "POST", credentials: "include" },
    );
    if (!res.ok && res.status !== 204) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, err.error ?? "cancel failed");
    }
  },

  /**
   * Subscribe to a migration's progress via Server-Sent Events. Returns an
   * abort function — call it to close the underlying EventSource.
   *
   * `onProgress` fires for each progress event (~1/s).
   * `onClose` fires once the stream is closed (terminal state OR aborted).
   */
  streamMigration: (
    id: string,
    onProgress: (p: MigrationProgress) => void,
    onClose: () => void,
  ): (() => void) => {
    const url = `${BASE}/llm/migration/${encodeURIComponent(id)}/stream`;
    const es = new EventSource(url, { withCredentials: true });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      es.close();
      onClose();
    };
    es.addEventListener("progress", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as MigrationProgress;
        onProgress(data);
      } catch {
        // ignore malformed event
      }
    });
    es.addEventListener("done", () => close());
    es.addEventListener("error", () => close());
    return close;
  },
};
