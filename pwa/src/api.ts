import type {
  GraphData,
  ImportDefaults,
  ImportRequest,
  Note,
  NoteSummary,
  PipeJob,
  SharePayload,
  TreeNode,
} from "@lokyy/shared";

/**
 * A note as it comes back from a save, plus the sync verdict.
 *
 * `synced: false` does NOT mean "not saved" — the server has committed the
 * note to git; only the push to Forgejo is outstanding (Forgejo unreachable,
 * or the write is sitting in the offline queue). The next successful save or
 * a manual sync carries it upstream, so the UI shows a quiet hint instead of
 * an error. `undefined` = an older server that doesn't report the field; treat
 * it as synced.
 */
export interface SavedNote extends Note {
  synced?: boolean;
}

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
 * Sleep-Agent ("Kurator") — background consolidation runs.
 *
 * Mirrors `SleepRun` from `@lokyy/core` (sleep-agent/types.ts). The server
 * serialises the in-memory record straight to JSON via `c.json(run)`, so the
 * `Date` fields arrive as ISO-8601 strings here. `passStats` is free-form
 * per-pass output; we keep it opaque — the Kurator UI reads `notesProcessed`
 * plus the phase/status/timestamps, not the raw pass payloads.
 * ────────────────────────────────────────────────────────────────────── */

export type SleepPhase = "nrem" | "rem" | "lint" | "dream" | "manual";
export type SleepTrigger = "idle" | "nightly" | "manual";
export type SleepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface SleepRunItem {
  id: string;
  phase: SleepPhase;
  trigger: SleepTrigger;
  status: SleepStatus;
  /** ISO-8601 — `new Date(startedAt)` to render. */
  startedAt: string;
  /** ISO-8601, absent while still running. */
  finishedAt?: string | null;
  passesCompleted: string[];
  passStats: Record<string, unknown>;
  errorMessage?: string | null;
  notesProcessed: number;
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

/* ──────────────────────────────────────────────────────────────────────────
 * Dashboard-Home (Epic 11 / Story 11.11).
 *
 * Inline-Spiegel der Response-Shapes aus `server/src/routes/dashboard.ts`
 * (selbst 1:1 mit `epic-11-architecture-addendum.md §5`). @lokyy/core ist
 * node-only und im PWA-Bundle verboten (§0), darum leben die Typen hier —
 * Feldnamen + Form strikt deckungsgleich mit der Server-Route halten.
 *
 * Zwei Latenz-Klassen (Addendum §5):
 *   getDashboard()         → billige Kacheln, synchron (`DashboardSummary`).
 *   getDashboardActivity() → teure git-log Heatmap/Streak, lazy.
 *   getDashboardLooseEnds()→ teurer vault-weiter #todo/Checkbox-Scan, lazy.
 * ────────────────────────────────────────────────────────────────────── */

export interface DashboardSummary {
  counts: { notes: number; byType: Record<string, number>; tags: number };
  health: {
    brokenLinks: number;
    brokenTop: { sourceId: string; target: string }[];
  };
  /** `updated` = ISO-8601. */
  recent: { id: string; title: string; updated: string }[];
  today: { id: string; title: string } | null;
  serendipity: { id: string; title: string } | null;
  system: { syncState: string; vaultId: string };
}

export interface DashboardActivityDay {
  /** `YYYY-MM-DD` (committer-date UTC day-bucket). */
  date: string;
  commits: number;
}

export interface DashboardActivity {
  /** Lückenlos gap-gefüllt über das Fenster (`commits: 0` für ruhige Tage). */
  days: DashboardActivityDay[];
  currentStreak: number;
  longestStreak: number;
}

export interface DashboardLooseEnd {
  noteId: string;
  title: string;
  /** 1-basierte Zeilennummer im Body (Frontmatter ausgenommen). */
  line: number;
  text: string;
}

export interface DashboardLooseEnds {
  items: DashboardLooseEnd[];
  /** Echte Gesamtzahl im Vault (kann `> items.length` sein). */
  total: number;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Lokyy-Workspace sidebar menu (Epic 11 / Story 11.1).
 *
 * Inlined structural mirror of `MenuItem` / `ViewType` / `MenuConfig` from
 * `packages/core/src/workspace/menuConfig.ts`. @lokyy/core is node-only and
 * forbidden from the PWA bundle (§0), so the shapes live here — keep field
 * names + the closed `ViewType` enum 1:1 with the source. The view-type
 * registry in `pwa/src/sidebar/views/registry.ts` mirrors the same union.
 *
 * `kind:"system"` items (Home, Skills) are code constants merged in front by
 * the server and are NEVER persisted; `putMenu` sends only the user's custom
 * items, and the server re-drops any incoming system item defensively.
 * ────────────────────────────────────────────────────────────────────── */
export type ViewType = "tree" | "skills" | "dashboard"; // closed list v1

export interface MenuItem {
  id: string; // ULID for custom items; reserved "system:*" for system items
  label: string;
  icon: string; // lucide-react icon name
  folder: string; // vault-relative path, "" = root
  viewType: ViewType;
  shortcut: string | null;
  kind: "system" | "custom";
}

export interface MenuConfig {
  version: number;
  items: MenuItem[];
}

/* ──────────────────────────────────────────────────────────────────────────
 * Multi-tenant — customer/shared vaults (M3 / LBMT-1.5). Mirrors
 * `server/src/routes/tenants.ts`. Token plaintext is returned ONCE on create
 * and never again (only the hash is stored server-side).
 * ────────────────────────────────────────────────────────────────────── */
/** Owner vault-switcher entry (LBMT-C). */
export interface VaultListItem {
  id: string;
  name: string;
  slug: string;
  kind: string;
  isDefault: boolean;
}

/**
 * Active-vault selector (LBMT-C). A `lokyy_vault` cookie tells the server which
 * vault to bind API requests to (notes/tree/graph). Same-origin → the cookie
 * rides along on every fetch automatically; no per-call header needed.
 */
export function setActiveVaultCookie(vaultId: string | null): void {
  if (typeof document === "undefined") return;
  document.cookie = vaultId
    ? `lokyy_vault=${encodeURIComponent(vaultId)}; path=/; max-age=31536000; samesite=lax`
    : "lokyy_vault=; path=/; max-age=0";
}

export function getActiveVaultCookie(): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(/(?:^|;\s*)lokyy_vault=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export interface TenantTokenMeta {
  id: string;
  agentId: string;
  role: "read" | "write";
  label: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface TenantVault {
  vaultId: string;
  name: string;
  slug: string;
  kind: string;
  /** Credentials already stripped server-side. */
  gitRemote: string;
  tokens: TenantTokenMeta[];
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  agentId: string;
  kind?: "shared" | "company" | "personal";
  role?: "read" | "write";
}

export interface CreateTenantResult {
  vaultId: string;
  slug: string;
  kind: string;
  agentId: string;
  role: string;
  scope: { read: string[]; write: string[] };
  /** Plaintext bearer — show once, then it's gone. */
  token: string;
  connector: string;
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

/**
 * Own-vault MCP token metadata (Story 7.10). Deliberately has NO plaintext
 * field: only the SHA-256 of a bearer is stored, so an existing token can never
 * be shown again — the UI shows metadata and offers revoke + reissue.
 */
export interface OwnMcpTokenMeta {
  id: string;
  agentId: string;
  role: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface OwnMcpTokenList {
  vaultId: string | null;
  vaultName: string | null;
  tokens: OwnMcpTokenMeta[];
  /**
   * State of the legacy `LOKYY_MCP_TOKEN`. `shared: true` means the install is
   * still on the publicly-known default from the compose file — accepted, but
   * insecure, and flagged as such in the UI (AC#7).
   */
  envToken: { configured: boolean; shared: boolean };
}

/** Creation response — `token` is the one-time plaintext bearer. */
export interface OwnMcpTokenCreated extends OwnMcpTokenMeta {
  vaultId: string;
  token: string;
  connector: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Story 7.12 — Versionsprüfung und Ein-Klick-Update.
 *
 * Shapes mirror `UpdateCheckResult` in `@lokyy/core/version` and `JobSnapshot`
 * in `updater/src/update.ts`. Both are node-side sources the PWA bundle may
 * not import, so the shapes are inlined here — keep the field names 1:1.
 * ────────────────────────────────────────────────────────────────────── */

/** `GET /api/system/version` — deliberately NOT admin-gated (see the route). */
export interface SystemVersion {
  /** Version of the running build; `null` when unreadable. */
  running: string | null;
  /** Build SHA, display only — `null` unless the build arg was set. */
  buildSha: string | null;
  /** Newest remote version, or `null` when the check could not run. */
  latest: string | null;
  updateAvailable: boolean;
  /** RAW markdown lines from the changelog — render via `update/changelogMarkdown`. */
  highlights: string[];
  checkedAt: string | null;
  status: "ok" | "disabled" | "unknown";
}

/**
 * `POST /api/system/version/check` — the same payload plus why it is that.
 *
 * `throttled: true` means the server served its cached answer instead of
 * re-checking (at most one real check per 30 s). Not an error: the numbers are
 * still true, just up to half a minute old.
 */
export interface SystemVersionCheck extends SystemVersion {
  throttled: boolean;
  /** Seconds until another check is accepted. `0` when it really checked. */
  retryAfterSeconds: number;
}

/** Why an installation cannot update itself. Shared by capability and 503s. */
export type UpdateBlockedReason = "managed" | "off" | "blocked" | "unreachable";

/**
 * Whether THIS installation can update itself — `GET /api/system/update`.
 * Capability-based, never env-sniffed (AC#11), and always answered with 200:
 * "cannot update" is an answer, not an error.
 *
 * Render rule, in full: `canUpdate === true` → button. Otherwise → `message`
 * as text. Never both, never a dead button.
 */
export interface UpdateCapability {
  canUpdate: boolean;
  /** Effective mode after `LOKYY_UPDATE_MODE` and capability detection. */
  mode?: "local" | "managed" | "off";
  /** `null` when `canUpdate`. */
  reason?: UpdateBlockedReason | null;
  /** One ready-to-render sentence. `null` when `canUpdate`. */
  message?: string | null;
  /**
   * Only ever non-empty when `reason === "blocked"` — an updater IS present
   * but misconfigured. Actionable, so these are shown to the admin.
   */
  blockers?: string[];
  /** A job the updater is running RIGHT NOW — the UI attaches to it. */
  currentJobId?: string | null;
  /** Compose project, display only. */
  project?: string | null;
}

export type UpdatePhase =
  | "queued"
  | "preflight"
  | "pull"
  | "build"
  | "switch"
  | "verify"
  | "rollback"
  | "done";

export type UpdateResult =
  | "success"
  | "already-up-to-date"
  | "aborted"
  | "build-failed"
  | "rolled-back"
  | "failed";

/**
 * A refused update call — start or poll.
 *
 * Carries the three fields the shared `json()` helper would throw away, each
 * of which decides UI behaviour:
 *
 * - `retryable` — the server's own verdict on whether waiting can help. The
 *   UI branches on THIS, not on the status code: a 503 during the restart
 *   window is `true`, a 503 because no updater exists is `false`.
 * - `currentJobId` — from a 409, which always means "a job is already
 *   running, follow that one" and never anything else.
 * - `reason` — `managed` / `off` / `blocked` / `unreachable`.
 */
export class UpdateApiError extends ApiError {
  constructor(
    status: number,
    message: string,
    public currentJobId: string | null = null,
    public reason: UpdateBlockedReason | null = null,
    /** `null` when the server said nothing — then fall back to the status. */
    public retryable: boolean | null = null,
  ) {
    super(status, message);
  }
}

/** Body shape shared by the update endpoints' error responses. */
interface UpdateErrorBody {
  error?: string;
  message?: string;
  reason?: UpdateBlockedReason;
  currentJobId?: string;
  retryable?: boolean;
}

/** Turn a non-2xx update response into an `UpdateApiError`. */
async function updateError(res: Response, fallback: string): Promise<UpdateApiError> {
  const body = (await res.json().catch(() => ({}))) as UpdateErrorBody;
  return new UpdateApiError(
    res.status,
    body.message ?? fallback,
    body.currentJobId ?? null,
    body.reason ?? null,
    typeof body.retryable === "boolean" ? body.retryable : null,
  );
}

/** One update job as the updater reports it, proxied 1:1 by the server. */
export interface UpdateJob {
  id: string;
  phase: UpdatePhase;
  running: boolean;
  result?: UpdateResult;
  message?: string;
  startedAt: string;
  finishedAt?: string;
  project: string;
  targetServices: string[];
  fromSha?: string;
  toSha?: string;
  log: string[];
}

export const api = {
  listNotes: () => fetch(`${BASE}/notes`).then(json<NoteSummary[]>),

  /**
   * Story 7.12 — running version + cached update-check result.
   *
   * Never throws: this is called on every app start, and AC#3 requires a
   * failed check to be invisible and inconsequential. A failure yields a
   * `status: "unknown"` payload, which means "no banner".
   */
  getSystemVersion: async (): Promise<SystemVersion> => {
    const offline: SystemVersion = {
      running: null,
      buildSha: null,
      latest: null,
      updateAvailable: false,
      highlights: [],
      checkedAt: null,
      status: "unknown",
    };
    try {
      const res = await fetch(`${BASE}/system/version`, { credentials: "include" });
      if (!res.ok) return offline;
      return (await res.json()) as SystemVersion;
    } catch {
      return offline;
    }
  },

  /**
   * „Jetzt prüfen" — force a check now, ignoring the server's 6 h cache.
   *
   * `null` means the check could not run at all (offline, server down, 5xx).
   * The caller shows a quiet note for that; it must never be dressed up as a
   * failure of the installation. A throttled answer is NOT null — it comes
   * back as a normal payload with `throttled: true`.
   */
  checkSystemVersionNow: async (): Promise<SystemVersionCheck | null> => {
    try {
      const res = await fetch(`${BASE}/system/version/check`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return null;
      return (await res.json()) as SystemVersionCheck;
    } catch {
      return null;
    }
  },

  /**
   * Story 7.12 — can this installation update itself? Admin-only server-side,
   * and always a 200 when it answers at all.
   *
   * Never throws: any transport failure resolves to `canUpdate: false` with a
   * German fallback sentence. A dead button is explicitly forbidden
   * (AC#5/#11), so "cannot tell" has to mean "show the note, not the button".
   */
  getUpdateCapability: async (): Promise<UpdateCapability> => {
    const unreachable: UpdateCapability = {
      canUpdate: false,
      reason: "unreachable",
      message:
        "Der Update-Status lässt sich gerade nicht abfragen. " +
        "Der manuelle Weg aus dem README funktioniert unverändert.",
    };
    try {
      const res = await fetch(`${BASE}/system/update`, { credentials: "include" });
      if (!res.ok) return unreachable;
      return (await res.json()) as UpdateCapability;
    } catch {
      return unreachable;
    }
  },

  /**
   * Story 7.12 — start an update.
   *
   * Deliberately NOT using the shared `json()` helper: that one surfaces the
   * machine-readable `error` field ("job-running"), and this message goes in
   * front of a non-technical user. We read `message` instead, and carry
   * `currentJobId` out of a 409 so the UI can attach to the job that is
   * already running rather than reporting a failure.
   */
  startUpdate: async (): Promise<UpdateJob> => {
    const res = await fetch(`${BASE}/system/update`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) return (await res.json()) as UpdateJob;
    throw await updateError(
      res,
      res.status === 403
        ? "Nur Administratoren dürfen ein Update starten."
        : "Das Update konnte nicht gestartet werden.",
    );
  },

  /**
   * Story 7.12 — poll one job. Throws on failure BY DESIGN: during the switch
   * phase the brain restarts and this call fails, which the progress view must
   * read as "restarting" and retry (AC#6). Swallowing it here would hide the
   * very state the UI needs to distinguish. The thrown `UpdateApiError`
   * carries `retryable`, which is what the caller branches on.
   */
  getUpdateJob: async (id: string): Promise<UpdateJob> => {
    const res = await fetch(`${BASE}/system/update/${encodeURIComponent(id)}`, {
      credentials: "include",
    });
    if (res.ok) return (await res.json()) as UpdateJob;
    throw await updateError(res, "Der Update-Status ist gerade nicht abrufbar.");
  },

  getNote: (id: string) =>
    fetch(`${BASE}/notes/${id}`).then(json<Note>),

  /** Speichern -> Server committet & pusht nach Forgejo.
   *  Bei Offline / Netzwerkfehler -> Eintrag in die Offline-Queue,
   *  Auto-Replay sobald wieder online (Story 4.2 + 4.3). */
  putNote: async (id: string, body: string): Promise<SavedNote> => {
    const endpoint = `${BASE}/notes/${id}`;
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        credentials: "include",
      });
      if (!res.ok) throw new ApiError(res.status, await res.text());
      return (await res.json()) as SavedNote;
    } catch (err) {
      if (!navigator.onLine || err instanceof TypeError) {
        const { enqueueWrite } = await import("./offline/queue.js");
        await enqueueWrite({ endpoint, method: "PUT", body: { body } });
        // Optimistic stub — caller treats this as "saved locally".
        // `synced: false` is literally true here: the write sits in the
        // offline queue and reaches Forgejo on replay.
        return {
          id,
          path: id + ".md",
          title: id.split("/").pop() ?? id,
          body,
          tags: [],
          links: [],
          aliases: [],
          updatedAt: new Date().toISOString(),
          synced: false,
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

  /**
   * Rebuild the Tier-1 BM25 search index (`note_search`) from every note on
   * disk. One-shot maintenance action exposed in the Wartung tab: pre-existing
   * notes that were never touched since the BM25 fast-path landed aren't in the
   * corpus and hit the slow fallback — this populates them. Returns the number
   * of notes (re)indexed and the wall-clock duration.
   */
  reindexSearch: (): Promise<{ indexed: number; ms: number }> =>
    fetch(`${BASE}/search/reindex`, {
      method: "POST",
      credentials: "include",
    }).then(json<{ indexed: number; ms: number }>),

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
   * Web-Share-Target (Story 11.8) — dünner Wrapper auf das bestehende
   * `POST /api/pipes/share` (Addendum §6 / K-4: KEIN neuer Endpoint). Nimmt
   * eine `SharePayload` (title/text/url + optionale base64-Datei) und gibt den
   * erzeugten `PipeJob` zurück. ShareTarget.tsx zeigt daraus eine Quittung —
   * niemals die rohe JSON-Antwort (YouTube-JSON-Bugfix).
   */
  share: (payload: SharePayload) =>
    fetch(`${BASE}/pipes/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "include",
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
   * Import a FOLDER skill (Story 12.3). Posts a multipart/form-data body to
   * `POST /api/skills/import`: a `skillName` field, every file under the
   * repeated `files` field, and a positional `paths` JSON array carrying each
   * file's path RELATIVE to the skill root (`SKILL.md`, `references/x.md`, …).
   *
   * The `paths` array is the authoritative source of relative paths server-side
   * (it survives proxies that strip directory info from the filename); we pass
   * it alongside the files so the import does not depend on `webkitRelativePath`
   * surviving the wire. `files` and `paths` are positionally aligned.
   *
   * On a non-2xx the server returns a structured `{ error, message? }` body —
   * we surface `message` (falling back to `error`) through `ApiError` so the
   * caller can show a clean receipt instead of the raw response.
   */
  importSkill: async (
    skillName: string,
    files: { relPath: string; file: File }[],
  ): Promise<{ skillName: string; written: string[]; skipped: string[] }> => {
    const form = new FormData();
    form.append("skillName", skillName);
    const paths: string[] = [];
    for (const { relPath, file } of files) {
      paths.push(relPath);
      // Keep the relative path on the part name too, so the server's
      // filename-fallback resolves correctly even without the `paths` field.
      form.append("files", file, relPath);
    }
    form.append("paths", JSON.stringify(paths));
    const res = await fetch(`${BASE}/skills/import`, {
      method: "POST",
      body: form,
      credentials: "include",
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      throw new ApiError(
        res.status,
        data.message ?? data.error ?? "Skill-Import fehlgeschlagen",
      );
    }
    return (await res.json()) as {
      skillName: string;
      written: string[];
      skipped: string[];
    };
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

  /* ──── Sleep-Agent ("Kurator") ──── */

  /**
   * Recent sleep-agent runs, newest-first. `limit` is capped server-side
   * (1..200). Each run's `Date` fields arrive as ISO strings.
   */
  getSleepRuns: (opts: { limit?: number } = {}): Promise<{ runs: SleepRunItem[] }> => {
    const limit = opts.limit ?? 20;
    return fetch(`${BASE}/sleep-agent/runs?limit=${limit}`, {
      credentials: "include",
    }).then(json<{ runs: SleepRunItem[] }>);
  },

  /**
   * Manually trigger a sleep-agent phase.
   *
   * `phase: "rem"` is the run that produces the connections ("Bezüge") — the
   * topic-synthesis pass runs in REM and writes the auto topic-notes that
   * surface in the agent-review queue. `phase: "nrem"` only does maintenance
   * passes (importance recompute, ulid-backfill, synaptic pruning) and does
   * NOT create connections.
   *
   * Returns `{ ok: true, run }` on success, or `{ ok: false, error }` with a
   * 409 when another run is already in-flight (the agent's idempotency guard).
   */
  triggerSleepPhase: async (
    phase: SleepPhase,
  ): Promise<{ ok: true; run: SleepRunItem } | { ok: false; error: string }> => {
    const res = await fetch(`${BASE}/sleep-agent/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phase }),
      credentials: "include",
    });
    if (res.status === 409) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: data.error ?? "sleep-agent already running" };
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, data.error ?? "sleep-agent trigger failed");
    }
    const run = (await res.json()) as SleepRunItem;
    return { ok: true, run };
  },

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

  /* ──── Dashboard-Home (Epic 11 / Story 11.11) ──── */

  /**
   * Billige Dashboard-Kacheln, synchron (`DashboardSummary`). Eine Anfrage
   * bündelt counts/health/recent/today/serendipity/system — alles aus
   * vorhandenen Core-Surfaces server-seitig zusammengesetzt.
   */
  getDashboard: (): Promise<DashboardSummary> =>
    fetch(`${BASE}/dashboard`, { credentials: "include" }).then(
      json<DashboardSummary>,
    ),

  /**
   * Git-Activity-Heatmap + Streaks (`DashboardActivity`), lazy. Teurer
   * vault-weiter `git log` — server-seitig 60s-memoisiert. Default 365 Tage.
   */
  getDashboardActivity: (days = 365): Promise<DashboardActivity> =>
    fetch(`${BASE}/dashboard/activity?days=${days}`, {
      credentials: "include",
    }).then(json<DashboardActivity>),

  /**
   * Offene Punkte (offene Checkboxen + `#todo`) vault-weit (`DashboardLooseEnds`),
   * lazy. Teurer Volltext-Scan — server-seitig 60s-memoisiert. `total` kann
   * größer als `items.length` sein (per-Stream-Cap `limit`).
   */
  getDashboardLooseEnds: (limit = 50): Promise<DashboardLooseEnds> =>
    fetch(`${BASE}/dashboard/loose-ends?limit=${limit}`, {
      credentials: "include",
    }).then(json<DashboardLooseEnds>),

  /* ──── Workspace sidebar menu (Epic 11 / Story 11.1) ──── */

  /**
   * Read the merged sidebar menu config — System-Items (Home, Skills) merged
   * in front of the user's custom items. The server degrades to System-Defaults
   * internally on a missing/invalid `00_meta/sidebar-menu.yaml`, so this resolves
   * with a usable `{ version, items }` whenever the endpoint is reachable.
   */
  getMenu: (): Promise<MenuConfig> =>
    fetch(`${BASE}/workspace/menu`, { credentials: "include" }).then(
      json<MenuConfig>,
    ),

  /**
   * Persist the user's custom menu items. The server rejects every incoming
   * `kind:"system"` item before persistence (System-Items are code constants,
   * never written), then commits the custom-only config via gitService. Returns
   * the freshly merged config (System + persisted custom). Throws `ApiError`
   * (400) on schema-invalid items.
   */
  putMenu: (items: MenuItem[]): Promise<MenuConfig> =>
    fetch(`${BASE}/workspace/menu`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
      credentials: "include",
    }).then(json<MenuConfig>),

  /* ──── Owner vault-switcher (LBMT-C) ──── */

  /** All vaults the owner can open, with kind + which is the default singleton. */
  getVaults: (): Promise<{ defaultVaultId: string; vaults: VaultListItem[] }> =>
    fetch(`${BASE}/vaults`, { credentials: "include" }).then(
      json<{ defaultVaultId: string; vaults: VaultListItem[] }>,
    ),

  /* ──── Multi-tenant — customer/shared vaults (LBMT-1.5) ──── */

  /** List provisioned vaults + their token metadata (no plaintext). */
  listTenants: (): Promise<{ tenants: TenantVault[] }> =>
    fetch(`${BASE}/tenants`, { credentials: "include" }).then(
      json<{ tenants: TenantVault[] }>,
    ),

  /** Provision an isolated customer vault; returns the token ONCE. */
  createTenant: (input: CreateTenantInput): Promise<CreateTenantResult> =>
    fetch(`${BASE}/tenants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    }).then(json<CreateTenantResult>),

  // ── Own-vault MCP tokens (Story 7.10) ────────────────────────────────
  // Separate from the `*TenantToken` calls above: those manage CUSTOMER
  // vaults and make the caller name a vaultId. These three target the
  // operator's OWN vault, resolved server-side, and are what the MCP tab uses.

  /** Metadata of the own vault's tokens + the state of the legacy env token. */
  listOwnMcpTokens: (): Promise<OwnMcpTokenList> =>
    fetch(`${BASE}/admin/mcp-tokens`, { credentials: "include" }).then(
      json<OwnMcpTokenList>,
    ),

  /** Mint a token for the own vault. The plaintext comes back EXACTLY once. */
  createOwnMcpToken: (
    input: { label?: string; agentId?: string; role?: "read" | "write" } = {},
  ): Promise<OwnMcpTokenCreated> =>
    fetch(`${BASE}/admin/mcp-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    }).then(json<OwnMcpTokenCreated>),

  /** Revoke one of the own vault's tokens. Effective on the next request. */
  revokeOwnMcpToken: (tokenId: string): Promise<{ ok: true }> =>
    fetch(`${BASE}/admin/mcp-tokens/${encodeURIComponent(tokenId)}`, {
      method: "DELETE",
      credentials: "include",
    }).then(json<{ ok: true }>),

  /** Revoke an MCP token — its next request 401s. */
  revokeTenantToken: (tokenId: string): Promise<{ ok: true }> =>
    fetch(`${BASE}/tenants/tokens/${encodeURIComponent(tokenId)}`, {
      method: "DELETE",
      credentials: "include",
    }).then(json<{ ok: true }>),

  /** Issue an additional MCP token for a vault (e.g. after revoking). Token shown once. */
  createTenantToken: (
    vaultId: string,
    input: { agentId?: string; role?: "read" | "write" } = {},
  ): Promise<{ vaultId: string; agentId: string; role: string; token: string; connector: string }> =>
    fetch(`${BASE}/tenants/${encodeURIComponent(vaultId)}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    }).then(
      json<{ vaultId: string; agentId: string; role: string; token: string; connector: string }>,
    ),

  /** Delete a customer/company vault entirely (Forgejo repo + working copy + rows). */
  deleteTenant: (vaultId: string): Promise<{ ok: true }> =>
    fetch(`${BASE}/tenants/${encodeURIComponent(vaultId)}`, {
      method: "DELETE",
      credentials: "include",
    }).then(json<{ ok: true }>),

  /** Current folder-scope (read/write globs) for a tenant vault's customer agent. */
  getTenantScope: (
    vaultId: string,
  ): Promise<{ agentId: string; readGlobs: string[]; writeGlobs: string[] }> =>
    fetch(`${BASE}/tenants/${encodeURIComponent(vaultId)}/scope`, {
      credentials: "include",
    }).then(json<{ agentId: string; readGlobs: string[]; writeGlobs: string[] }>),

  /** Rewrite a tenant vault's folder-scope (e.g. from tree-lock toggles). Live immediately. */
  putTenantScope: (
    vaultId: string,
    body: { readGlobs: string[]; writeGlobs: string[] },
  ): Promise<{ ok: true; agentId: string }> =>
    fetch(`${BASE}/tenants/${encodeURIComponent(vaultId)}/scope`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    }).then(json<{ ok: true; agentId: string }>),
};
