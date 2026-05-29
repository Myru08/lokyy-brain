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

/**
 * Voice-capture defaults — server shape from `/api/voice/settings`.
 * 1:1 with `VoiceDefaults` in `@lokyy/core/setup/voiceDefaults.ts`
 * (core is node-only and forbidden from the PWA bundle, so the shape is
 * inlined here — keep field names in sync).
 */
export type VoiceMode = "live" | "whisper-cloud" | "whisper-selfhosted";

export interface VoiceSettings {
  mode: VoiceMode;
  folder: string;
  titlePattern: string;
  language: string | null;
  /** Opt-in AI title generation from transcript. Server default `false`. */
  aiTitle: boolean;
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
 * Runtime/operator-visible settings — single source of truth for what
 * env-vars the running server is actually using (DB host, Ollama host,
 * MCP public URL) plus the active vault row from Postgres.
 *
 * Backed by `GET /api/settings/runtime`. The endpoint may not exist yet
 * (older server build) — callers should treat 404 as "fall back to
 * legacy fields" and never crash on a missing payload.
 */
export interface RuntimeSettings {
  vault: {
    id: string;
    name: string;
    slug: string;
    gitRemote: string;
    gitBranch: string;
  } | null;
  env: {
    databaseHost: string;
    ollamaHost: string;
    /** Public MCP URL — e.g. "https://mcp.example.de/mcp". Empty string when not set. */
    mcpPublicUrl: string;
  };
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

/* ──────────────────────────────────────────────────────────────────────────
 * Agent-Review aggregated queue (Phase C Wave C3 / Story 1).
 *
 * Three pending-review streams the server stitches into one response:
 *   - mem0           Mem0 classifier suggestions awaiting accept/reject
 *   - lint           Karpathy-lint findings still in `status=open`
 *   - topicNotes     Topic-synthesis notes from `70_pai/topics/auto-*`
 *                    with frontmatter `origin: agent`
 *
 * Keep shapes in lockstep with `server/src/routes/agent-review.ts`.
 * ────────────────────────────────────────────────────────────────────── */

export type Mem0Operation = "ADD" | "UPDATE" | "DELETE" | "NOOP";
export type Mem0ReviewStatus = "pending" | "accepted" | "rejected" | "applied";

export interface Mem0ReviewItem {
  id: string;
  noteId: string;
  operation: Mem0Operation;
  targetNoteId: string | null;
  confidence: number;
  reasoning: string;
  payload: Record<string, unknown> | null;
  status: Mem0ReviewStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export type LintKind =
  | "orphan"
  | "contradiction"
  | "missing_link"
  | "schema_drift"
  | "duplicate";

export type LintSeverity = "info" | "warning" | "error";

export type LintStatus = "open" | "acknowledged" | "fixed" | "dismissed";

export interface LintFindingItem {
  id: string;
  kind: LintKind;
  noteIds: string[];
  severity: LintSeverity;
  message: string;
  evidence: Record<string, unknown> | null;
  status: LintStatus;
  detectedAt: string;
  resolvedAt: string | null;
}

export interface TopicNoteItem {
  id: string;
  title: string;
  confidence: number | null;
  sourceNotes: string[];
  bodyPreview: string;
  generatedAt: string | null;
  communityId: string | null;
}

export interface AgentReviewQueue {
  mem0: Mem0ReviewItem[];
  lint: LintFindingItem[];
  topicNotes: TopicNoteItem[];
  totalPending: number;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Diagnostics + Logs (Observability — in-app self-test suite + log viewer).
 *
 * Shapes mirror `server/src/routes/diagnostics.ts` + `server/src/routes/logs.ts`.
 * The server's checks never 500 — a failed service surfaces as a check with
 * `ok:false` + `detail`. The PWA renders these grouped by `service`.
 * ────────────────────────────────────────────────────────────────────── */

export type DiagnosticSeverity = "info" | "warn" | "error";

export interface DiagnosticCheck {
  /** Stable service tag — `forgejo`, `postgres`, `ollama`, `embeddings`, `search`, `sleep-agent`, `mcp`, `git`. */
  service: string;
  /** Human-readable check name within the service. */
  name: string;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
  severity?: DiagnosticSeverity;
}

export interface DiagnosticsResult {
  checks: DiagnosticCheck[];
  /** ISO timestamp of when the suite ran. */
  ranAt: string;
}

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  /** ISO-8601 timestamp (UTC). */
  ts: string;
  level: LogLevel;
  service?: string;
  message: string;
}

export interface LogsResult {
  /** Newest-first. */
  logs: LogEntry[];
}

export interface LogsQuery {
  limit?: number;
  level?: LogLevel;
  service?: string;
}

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
/* ──────────────────────────────────────────────────────────────────────────
 * Encoding-Context (Phase B Wave B3 / Story 1 — Tulving 1973).
 *
 * The PWA assembles a thin client-side context block at create-time —
 * device class from `navigator.userAgent` + caller-supplied
 * preceding-notes / session-duration / app_state. Everything else
 * (time-of-day, weekday) is derived server-side from the wall clock.
 *
 * Keep this shape compatible with `EncodedContext` in @lokyy/core; the
 * server merges it via `captureEncodingContext`.
 * ────────────────────────────────────────────────────────────────────── */
export type ClientDevice = "laptop" | "desktop" | "mobile" | "tablet" | "api" | "mcp";

export interface ClientEncodingInput {
  device?: ClientDevice;
  app_state?: string;
  preceding_notes?: string[];
  session_duration_min?: number;
  word_count_session?: number;
  source?: Record<string, unknown>;
}

/**
 * Lightweight UA → device classifier for the PWA. The server runs the
 * same heuristic against the `User-Agent` header — we send a hint
 * client-side so the request still works without a UA header (some
 * service-worker re-issues drop it). The server-side mapping wins when
 * the client omits the field.
 */
export function detectClientDevice(): ClientDevice {
  if (typeof navigator === "undefined") return "api";
  const ua = navigator.userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(ua)) return "tablet";
  if (/iphone|ipod|android.*mobile|mobile.*safari|opera mini|iemobile/.test(ua)) {
    return "mobile";
  }
  if (/windows nt|macintosh|mac os x|linux x86|x11/.test(ua)) return "laptop";
  return "api";
}

/**
 * Build the default client-side encoding hint — just the device. Callers
 * that want to attach preceding-notes / session_duration override this
 * by passing an explicit input to `api.createNote`.
 */
export function buildClientEncoding(
  extra: Omit<ClientEncodingInput, "device"> = {},
): ClientEncodingInput {
  return { device: detectClientDevice(), ...extra };
}

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

  /**
   * Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
   *
   * `forgetNote` sets `frontmatter.forgotten` to an ISO-timestamp; the
   * server's search-layer filters (Tier1-BM25, Tier2-embeddings, hybrid,
   * PPR) then skip the note. `unforgetNote` removes the field. The note
   * itself stays in the vault — neither call deletes anything from disk.
   *
   * Both calls are idempotent: re-forgetting refreshes the timestamp,
   * unforgetting an already-active note is a no-op.
   */
  forgetNote: async (noteId: string): Promise<Note> => {
    const res = await fetch(`${BASE}/notes/${noteId}/forget`, {
      method: "POST",
      credentials: "include",
    });
    const data = await json<{ ok: true; noteId: string; note: Note }>(res);
    return data.note;
  },

  unforgetNote: async (noteId: string): Promise<Note> => {
    const res = await fetch(`${BASE}/notes/${noteId}/unforget`, {
      method: "POST",
      credentials: "include",
    });
    const data = await json<{ ok: true; noteId: string; note: Note }>(res);
    return data.note;
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

  /**
   * Reconcile the working copy with Forgejo (Story: separate Save & Sync
   * buttons). Server runs `git pull --rebase` + pushes any unpushed commits
   * inside the git lock — NO note content is written. `changed` reports
   * whether the reconcile moved local↔remote state (pull brought commits or
   * we pushed unpushed ones); `false` means everything was already in sync.
   *
   * On a git failure the server returns `{ ok:false, … }` with 409/503 — `json`
   * turns that into an `ApiError` (with `.isConflict` for the 409 case) so the
   * caller can surface it through the same banner as a save conflict.
   */
  sync: () =>
    fetch(`${BASE}/vault/sync`, {
      method: "POST",
      credentials: "include",
    }).then(json<{ ok: boolean; changed: boolean }>),

  /**
   * Create a new note. Optionally carries a partial encoding-context
   * (Phase B Wave B3 / Story 1 — Tulving 1973) for the server to merge
   * with time/weekday + UA-derived device. Caller passes preceding-notes
   * + session-duration from `App.tsx`; the server fills in the rest.
   */
  createNote: (
    path: string,
    body?: string,
    encoded?: ClientEncodingInput,
  ) =>
    fetch(`${BASE}/vault/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, body, encoded: encoded ?? buildClientEncoding() }),
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
   * Voice-capture defaults (server: `/api/voice/settings`). Mirrors the
   * `VoiceDefaults` shape in `@lokyy/core/setup/voiceDefaults.ts`. The
   * Settings Voice tab edits these; App.tsx reads `aiTitle` to decide
   * whether to auto-generate a title on voice insert.
   */
  getVoiceSettings: (): Promise<VoiceSettings> =>
    fetch(`${BASE}/voice/settings`, { credentials: "include" }).then(
      json<VoiceSettings>,
    ),

  putVoiceSettings: (patch: Partial<VoiceSettings>): Promise<VoiceSettings> =>
    fetch(`${BASE}/voice/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(patch),
    }).then(json<VoiceSettings>),

  /**
   * Opt-in AI title suggestion for a voice note (server:
   * `POST /api/voice/suggest-title`). Best-effort — callers MUST treat any
   * thrown error or empty string as "no title" and fall back to their own
   * default name. Returns the trimmed title, or "" when the server gave
   * nothing usable.
   */
  suggestVoiceTitle: async (
    text: string,
    language?: string,
  ): Promise<string> => {
    const res = await fetch(`${BASE}/voice/suggest-title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(language ? { text, language } : { text }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      throw new ApiError(
        res.status,
        data.message ?? data.error ?? "Titel-Vorschlag fehlgeschlagen",
      );
    }
    const data = (await res.json().catch(() => ({}))) as { title?: string };
    return typeof data.title === "string" ? data.title.trim() : "";
  },

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

  /* ──── Agent-Review (Phase C Wave C3 / Story 1) ──── */

  /**
   * Aggregated pending-review queue. Limit is a per-stream cap, NOT a global
   * one — the server returns up to `limit` rows from each of mem0, lint and
   * topic-notes (so the total can be up to `limit * 3`).
   */
  getAgentReviewQueue: (limit = 30): Promise<AgentReviewQueue> =>
    fetch(`${BASE}/agent-review/queue?limit=${limit}`, {
      credentials: "include",
    }).then(json<AgentReviewQueue>),

  /** Apply a pending Mem0 classifier decision (ADD/UPDATE/DELETE/NOOP). */
  acceptMem0Review: async (id: string): Promise<void> => {
    const res = await fetch(
      `${BASE}/mem0/review/${encodeURIComponent(id)}/accept`,
      { method: "POST", credentials: "include" },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, err.error ?? "accept failed");
    }
  },

  /** Reject a pending Mem0 classifier decision. */
  rejectMem0Review: async (id: string): Promise<void> => {
    const res = await fetch(
      `${BASE}/mem0/review/${encodeURIComponent(id)}/reject`,
      { method: "POST", credentials: "include" },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, err.error ?? "reject failed");
    }
  },

  /**
   * Promote an auto-generated topic note to a user-curated one. Updates the
   * frontmatter (origin → curated, confidence → 1.0) and moves the file out
   * of `70_pai/topics/auto-*` into the user-visible topics folder.
   */
  acceptTopicNote: async (noteId: string): Promise<void> => {
    const res = await fetch(
      `${BASE}/agent-review/topic-note/${noteId}/accept`,
      { method: "POST", credentials: "include" },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, err.error ?? "accept failed");
    }
  },

  /** Delete an auto-generated topic note. */
  rejectTopicNote: async (noteId: string): Promise<void> => {
    const res = await fetch(
      `${BASE}/agent-review/topic-note/${noteId}/reject`,
      { method: "POST", credentials: "include" },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, err.error ?? "reject failed");
    }
  },

  /** Move a lint finding from `open` → `acknowledged`. */
  acknowledgeLintFinding: async (id: string): Promise<void> => {
    const res = await fetch(
      `${BASE}/lint/findings/${encodeURIComponent(id)}/acknowledge`,
      { method: "POST", credentials: "include" },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, err.error ?? "acknowledge failed");
    }
  },

  /** Move a lint finding from `open` → `dismissed`. */
  dismissLintFinding: async (id: string): Promise<void> => {
    const res = await fetch(
      `${BASE}/lint/findings/${encodeURIComponent(id)}/dismiss`,
      { method: "POST", credentials: "include" },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, err.error ?? "dismiss failed");
    }
  },

  /** Move a lint finding from `open` → `fixed`. */
  markLintFindingFixed: async (id: string): Promise<void> => {
    const res = await fetch(
      `${BASE}/lint/findings/${encodeURIComponent(id)}/mark-fixed`,
      { method: "POST", credentials: "include" },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, err.error ?? "mark-fixed failed");
    }
  },

  /* ──── ULID-Backfill (Phase D Wave D1 / Story 1) ──── */

  /**
   * Pending-count of legacy notes that still lack a frontmatter `id:`. The
   * server caps the scan at 500 notes — `scanLimited: true` signals that
   * `totalNotes` exceeded that cap and `withoutUlid` is only a lower bound.
   */
  getBackfillStatus: (): Promise<{
    totalNotes: number;
    scanned: number;
    withoutUlid: number;
    scanLimited: boolean;
  }> =>
    fetch(`${BASE}/backfill/status`, { credentials: "include" }).then(
      json<{
        totalNotes: number;
        scanned: number;
        withoutUlid: number;
        scanLimited: boolean;
      }>,
    ),

  /**
   * Manually trigger the NREM sleep phase (which includes the
   * ulid-backfill pass). Caps at 50 commits per run — re-trigger for
   * larger vaults. Returns 409 with `ok: false` when another sleep-run
   * is already in flight.
   */
  runBackfill: async (): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch(`${BASE}/backfill/ulid`, {
      method: "POST",
      credentials: "include",
    });
    if (res.status === 409) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      return { ok: false, error: data.error ?? "sleep-agent already running" };
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new ApiError(res.status, data.error ?? "backfill failed");
    }
    return { ok: true };
  },

  /* ──── Diagnostics + Logs (Observability) ──── */

  /**
   * Run the in-app per-service diagnostics suite. The server runs each check
   * defensively (a failing service yields `ok:false` + `detail`, never a 500),
   * so this resolves with a full `DiagnosticsResult` whenever the endpoint is
   * reachable. The UI groups `checks` by `service`.
   */
  getDiagnostics: (): Promise<DiagnosticsResult> =>
    fetch(`${BASE}/diagnostics`, { credentials: "include" }).then(
      json<DiagnosticsResult>,
    ),

  /**
   * Read recent important events from the server's in-process ring buffer.
   * Optional filters: `limit` (default server-side 100, cap 500), `level`,
   * and `service`. Newest-first. No Coolify/SSH needed to read it.
   */
  getLogs: (opts: LogsQuery = {}): Promise<LogsResult> => {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.level) params.set("level", opts.level);
    if (opts.service) params.set("service", opts.service);
    const qs = params.toString();
    return fetch(`${BASE}/logs${qs ? `?${qs}` : ""}`, {
      credentials: "include",
    }).then(json<LogsResult>);
  },
};
