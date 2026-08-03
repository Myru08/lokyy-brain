import { useEffect, useMemo, useState } from "react";
import {
  Check,
  X,
  Loader2,
  Copy,
  RefreshCw,
  AlertTriangle,
  PlayCircle,
  Brain,
  Network,
  Clock,
} from "lucide-react";
import { C, FONT } from "./theme.js";
import { AiProviderSettings } from "./AiProviderSettings.js";
import { TenantsTab } from "./Tenants.js";
import { AgentReviewPanel } from "./AgentReviewPanel.js";
import { McpTokenSection } from "./McpTokenSection.js";
import { SystemVersionInfo } from "./update/SystemVersionInfo.js";
import { api } from "./api.js";
import type {
  DiagnosticsResult,
  DiagnosticCheck,
  LogsResult,
  LogEntry,
  LogLevel,
  SleepRunItem,
  SleepStatus,
} from "./api.js";
import { useIsMobile, TOUCH_TARGET_MIN } from "./responsive.js";

/**
 * Settings Page (Story 1.12, refactored into tab-navigation).
 *
 * The legacy top-to-bottom monolith has been split into six tabs:
 *   1. System   — live status pings (Forgejo / Postgres / Ollama)
 *   2. Vault    — Vault-URL + Integrations (Supadata, default import folder)
 *   3. AI       — AiProviderSettings (profile, credentials, routing, migration)
 *   4. MCP      — Vault-ID card + three claude_desktop_config variants
 *   5. Skills   — recommended PAI skills with how-to / example prompt
 *   6. Wartung  — ULID-Backfill + Runtime KV
 *
 * Tab state is intentionally not persisted — refresh resets to "system".
 */

interface SystemSettings {
  vault: {
    id: string;
    name: string;
    gitRemote: string;
    gitBranch: string;
  } | null;
  runtime: {
    vaultDir: string;
    databaseUrl: string;
    ollamaHost: string;
  };
  integrations: {
    /** masked `***...{last4}` or null when not configured */
    supadataApiKeyMasked: string | null;
    supadataApiKeyConfigured: boolean;
    defaultImportFolder: string;
  };
}

interface StatusResult {
  forgejo: { service?: string; ok: boolean; error?: string };
  postgres: {
    service?: string;
    ok: boolean;
    error?: string;
    pgvector?: string | null;
  };
  ollama: {
    service?: string;
    ok: boolean;
    error?: string;
    hasNomicEmbed?: boolean;
  };
  /**
   * Derived from the Ollama probe by the backend: ok=false when Ollama is up
   * but `nomic-embed-text` is missing (or when Ollama itself is unreachable).
   * Optional so the page still renders against an older backend that doesn't
   * yet emit this entry — in that case we synthesize it from
   * `ollama.hasNomicEmbed`.
   */
  embeddings?: { service?: string; ok: boolean; error?: string };
}

/**
 * Per-service remediation hint shown when a System-tab check fails. `local`
 * is the command to run on the operator's own machine; `docker` is the
 * docker-compose equivalent for a server deployment. `note` adds a one-line
 * pointer (e.g. "check connection settings"). NOTHING here is ever executed —
 * the UI only renders the strings with copy-to-clipboard buttons.
 */
interface ServiceRemediation {
  local?: string;
  docker?: string;
  note?: string;
}

const SERVICE_REMEDIATION: Record<string, ServiceRemediation> = {
  forgejo: {
    docker: "docker compose up -d forgejo",
    note: "Vault-Remote und Forgejo-Verbindung im Vault-Tab prüfen.",
  },
  postgres: {
    docker: "docker compose up -d postgres",
    note: "Verbindungs-Einstellungen prüfen (DATABASE_URL).",
  },
  ollama: {
    local: "ollama serve",
    docker: "docker compose up -d ollama",
  },
  embeddings: {
    local: "ollama pull nomic-embed-text",
    note: "Embedding-Modell für die Tier-2 Semantik-Suche. Ollama muss laufen.",
  },
};

interface McpVariant {
  title: string;
  when: string;
  precondition?: string | string[];
  /**
   * Optional callout shown ABOVE the snippets (yellow Note). Used by
   * `c_native_http` to warn that the `claude mcp add` command needs to be
   * run BEFORE starting a Claude Code session — a live session does not
   * always reload the mcp-config cleanly.
   */
  instructions?: string;
  snippet?: Record<string, unknown>;
  /**
   * Ordered UI steps for connection methods that don't have a config-file
   * snippet (e.g. `e_claude_ai_oauth` which walks through the claude.ai UI).
   * When present, rendered as a numbered list under a "So geht's:" heading.
   */
  steps?: string[];
  /**
   * Optional additional sub-snippets (e.g. a `claude mcp add` CLI form
   * alongside the `claude_desktop_config.json` JSON). Each gets its own
   * Copy button in the UI. Used by `c_native_http`.
   */
  extraSnippets?: Array<{
    label: string;
    language: "bash" | "json";
    code: string;
  }>;
  endpointUrl?: string;
  healthUrl?: string;
  /**
   * Consent-page password value + its env source, surfaced by
   * `e_claude_ai_oauth` so the user can copy the exact string to enter on the
   * OAuth consent page. Consistent with `c_native_http` already showing the
   * LOKYY_MCP_TOKEN value inside its Bearer snippet on this admin page.
   */
  consentPassword?: string;
  consentPasswordSource?: string;
  authNote?: string;
}

interface McpInfo {
  /**
   * Hardcoded `true` on the backend — DO NOT use this to derive a live
   * health indicator. See `mcpHealthy` state below, which probes the
   * actual `/health` endpoint on a 10s interval.
   */
  available: boolean;
  tools: string[];
  variants?: {
    a_local_stdio: McpVariant;
    b_npx: McpVariant;
    /** Native HTTP transport — recommended for Claude Code / Claude Desktop. */
    c_native_http: McpVariant;
    /** OAuth 2.1 connector — for claude.ai web/desktop Custom Connector. */
    e_claude_ai_oauth: McpVariant;
    /** Legacy mcp-remote bridge — fallback for clients without native HTTP. */
    d_mcp_remote_legacy: McpVariant;
  };
  /**
   * Story 7.10: the literal marker the snippets carry when NO env token is
   * configured. The UI replaces it with the one-time plaintext of a freshly
   * generated token — the server cannot, since it only stores hashes.
   */
  tokenPlaceholder?: string;
  /** State of the legacy `LOKYY_MCP_TOKEN` (`shared` = the public default). */
  envToken?: { configured: boolean; shared: boolean };
  // legacy single-snippet support:
  claudeDesktopConfigSnippet?: Record<string, unknown>;
  binaryHint?: string;
  scopesFile?: string;
  scopesFileHint?: string;
}

interface SkillInfo {
  skill_name: string;
  title: string;
  description: string;
  allowed_tools: string[];
  // Vault-relative note id (no `.md`) — for the "im Editor öffnen" link.
  // null when the backend couldn't locate the note's path.
  path: string | null;
}

/**
 * Source-of-truth runtime view that the backend exposes at
 * `GET /api/settings/runtime`. Used to fix three display issues that the
 * legacy `/api/admin/system-settings` payload can't (or doesn't) cover:
 *
 *  - vault.gitRemote — DB column may be empty even after a successful
 *    `setupVaultFromForgejo` flow; the runtime endpoint reads it directly.
 *  - env.ollamaHost — actual `OLLAMA_HOST` value (e.g. `http://ollama-<UUID>:11434`)
 *    instead of the static `localhost:11434` placeholder.
 *  - env.mcpPublicUrl — built from `SERVICE_FQDN_LOKYY_MCP`, so the Remote-HTTP
 *    snippet points at the publicly reachable URL, not `localhost:8788/mcp`.
 *
 * Gracefully degrades to `null` when the endpoint is not yet deployed (404).
 */
interface RuntimeInfo {
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
    mcpPublicUrl: string;
    /**
     * Optional: present once the runtime endpoint exposes the self-hosted
     * Whisper base-URL. Used by the Voice tab to grey out the
     * "Whisper Self-Hosted" mode option until the operator deploys a
     * whisper-asr-webservice instance and wires `WHISPER_BASE_URL`.
     */
    whisperBaseUrl?: string;
  };
}

/**
 * Voice-capture defaults, served by the backend at
 * `GET /api/voice/settings`. Persists across recorder sessions so the
 * operator doesn't have to re-pick mode/language/folder every time.
 *
 * `mode`        — which transcription path is used when the recorder
 *                  starts. `live` = SpeechRecognition in the browser
 *                  (free, lower quality), `whisper-cloud` = OpenAI's
 *                  Whisper-1 ($0.006/min, best quality), and
 *                  `whisper-selfhosted` = a self-hosted
 *                  whisper-asr-webservice instance (free, private).
 * `folder`      — vault-relative folder where new voice-notes are written
 *                  (default `30_captures/voice`).
 * `titlePattern`— Mustache-light template; supported tokens:
 *                  `{YYYY} {MM} {DD} {HH} {mm}` (UTC),
 *                  `{slug}` (kebab-case of the first 5 words),
 *                  `{transcript-first-words}` (first 80 chars).
 * `language`    — ISO 639-1 hint passed to Whisper; `null` = auto-detect.
 */
type VoiceMode = "live" | "whisper-cloud" | "whisper-selfhosted";
interface VoiceSettings {
  mode: VoiceMode;
  folder: string;
  titlePattern: string;
  language: string | null;
  /**
   * Opt-in: generate the new voice note's title via the configured LLM
   * from the transcript when no manual title was typed. Default `false`.
   */
  aiTitle: boolean;
}

const VOICE_DEFAULTS: VoiceSettings = {
  mode: "live",
  folder: "30_captures/voice",
  titlePattern: "Voice-Notiz {YYYY-MM-DD HH:mm}",
  language: null,
  aiTitle: false,
};

const VOICE_LANGUAGES: { value: string | null; label: string }[] = [
  { value: null, label: "Auto (Whisper erkennt)" },
  { value: "de", label: "Deutsch (de)" },
  { value: "en", label: "English (en)" },
  { value: "fr", label: "Français (fr)" },
  { value: "es", label: "Español (es)" },
  { value: "it", label: "Italiano (it)" },
];

/**
 * Curated fallback list of common IANA timezones. Used when
 * `Intl.supportedValuesOf("timeZone")` is not available (Firefox < 110,
 * very old WebKit). Keep this list short and cover the most common
 * deployment regions — the UI surfaces a "Limited list — Firefox-Browser"
 * hint so the operator knows it's not the full ~600 zones.
 */
const TZ_FALLBACK_LIST: string[] = [
  "UTC",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Paris",
  "Europe/Madrid",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** Top-level tabs. Order matches the visible tab bar. */
type TabKey =
  | "system"
  | "vault"
  | "ai"
  | "mcp"
  | "mandanten"
  | "voice"
  | "skills"
  | "kurator"
  | "wartung"
  | "diagnose"
  | "logs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "system", label: "System" },
  { key: "vault", label: "Vault" },
  { key: "ai", label: "AI Provider" },
  { key: "mcp", label: "MCP" },
  { key: "mandanten", label: "Mandanten" },
  { key: "voice", label: "Voice" },
  { key: "skills", label: "Skills" },
  { key: "kurator", label: "Kurator" },
  { key: "wartung", label: "Wartung" },
  { key: "diagnose", label: "Diagnose" },
  { key: "logs", label: "Logs" },
];

/* ──────────────────────────────────────────────────────────────────────────
 * Diagnose-Tab — per-service grouping + severity → colour mapping.
 *
 * `DiagnosticCheck.severity` is optional; when absent we derive the colour
 * from `ok` (green) / not-ok (red). When present, `warn` paints amber even
 * if `ok:false`, so a degraded-but-not-broken service (e.g. pg_search
 * missing → BM25 LIKE-fallback) reads as a warning, not a hard failure.
 * ────────────────────────────────────────────────────────────────────── */

/** Stable display order + German labels for the known service groups. */
const DIAGNOSTIC_SERVICE_ORDER: { key: string; label: string }[] = [
  { key: "forgejo", label: "Forgejo" },
  { key: "postgres", label: "Postgres" },
  { key: "ollama", label: "Ollama" },
  { key: "embeddings", label: "Embeddings" },
  { key: "search", label: "Suche (Tier 1 / Tier 2 / Combined)" },
  { key: "sleep-agent", label: "Sleep-Agent" },
  { key: "mcp", label: "MCP" },
  { key: "git", label: "Git / Vault" },
];

type CheckStatus = "ok" | "warn" | "err";

/** Resolve a check to one of three visual states. */
function checkStatus(c: DiagnosticCheck): CheckStatus {
  if (c.ok) return "ok";
  if (c.severity === "warn") return "warn";
  return "err";
}

function statusColor(s: CheckStatus): string {
  if (s === "ok") return C.ok;
  if (s === "warn") return C.gold;
  return C.err;
}

const LOG_LEVELS: { value: "all" | LogLevel; label: string }[] = [
  { value: "all", label: "Alle" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

const DEFAULT_LOG_LIMIT = 150;

export function Settings({
  onClose,
  onOpenNote,
}: {
  onClose: () => void;
  // Opens a vault note by id (vault-relative path without `.md`) in the CM6
  // editor. Optional so Settings still renders if a caller omits it.
  onOpenNote?: (id: string) => void;
}) {
  const [tab, setTab] = useState<TabKey>("system");

  // Drives the responsive layout. Below 640px we stack rows, full-bleed the
  // content, enlarge tap targets, and let the tab bar scroll horizontally.
  // Desktop (≥640px) keeps the original layout untouched.
  const isMobile = useIsMobile();

  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  /**
   * `runtime` is the canonical source for vault.gitRemote, ollamaHost, and
   * mcpPublicUrl. Stays `null` if the backend endpoint isn't deployed yet —
   * in that case we fall through to whatever the legacy payload reports.
   */
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);

  /**
   * Live MCP health probe. The backend's `/api/admin/mcp-info` hardcodes
   * `available: true`, which lies when the lokyy-mcp container is crash-
   * looping. We poll `<runtime.env.mcpPublicUrl>/health` directly (the
   * same URL the operator would curl) every 10s. States:
   *   - null   → unknown (probe hasn't run yet, or no mcpPublicUrl)
   *   - true   → /health returned 2xx within the timeout
   *   - false  → /health 4xx/5xx/timeout/network-error
   */
  const [mcpHealthy, setMcpHealthy] = useState<boolean | null>(null);
  /**
   * Story 7.10: plaintext of a token generated in THIS session. Held only in
   * memory (never re-fetchable — the server stores a hash) so the config
   * snippets below can show a copy-paste-ready value instead of a placeholder.
   */
  const [freshMcpToken, setFreshMcpToken] = useState<string | null>(null);
  const [mcpHealthCheckedAt, setMcpHealthCheckedAt] = useState<string | null>(
    null,
  );

  const [newRemote, setNewRemote] = useState("");
  const [newBranch, setNewBranch] = useState("main");
  const [vaultSaveState, setVaultSaveState] = useState<
    "idle" | "saving" | "ok" | "fail"
  >("idle");
  const [vaultSaveError, setVaultSaveError] = useState<string>();
  // True when the last vault-URL test returned an auth-style failure
  // (HTTP 401 or message that smells like an expired token). When set,
  // the Vault tab surfaces the reconnect-affordance more prominently.
  const [vaultAuthFailed, setVaultAuthFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Forgejo OAuth connection state, used by the Vault tab's reconnect
  // affordance. `probeState` reflects the live `/api/forgejo/probe` call:
  //   - 'connected'    → token is valid, /api/v1/user returned 200
  //   - 'expired'      → token present but Forgejo returned 401/403
  //   - 'none'         → no stored token (operator never connected)
  //   - 'network'      → probe failed for non-auth reasons
  //   - 'loading'      → probe in flight
  type ForgejoProbeState =
    | "loading"
    | "connected"
    | "expired"
    | "none"
    | "network";
  const [forgejoProbe, setForgejoProbe] =
    useState<ForgejoProbeState>("loading");
  const [forgejoUser, setForgejoUser] = useState<string | null>(null);
  // Flash-message shown above the Vault tab after a successful reconnect.
  // Triggered by the `?forgejo=connected` query param the OAuth callback
  // lands us on.
  const [reconnectFlash, setReconnectFlash] = useState(false);

  // Integrations — Supadata key + default import folder
  const [supadataInput, setSupadataInput] = useState("");
  const [supadataTouched, setSupadataTouched] = useState(false);
  const [importFolderInput, setImportFolderInput] = useState("");
  const [integrationsSaveState, setIntegrationsSaveState] = useState<
    "idle" | "saving" | "ok" | "fail"
  >("idle");
  const [integrationsSaveError, setIntegrationsSaveError] = useState<string>();

  // Voice-capture defaults (tab: voice). Loaded from `/api/voice/settings`
  // on tab mount; PUTs back partial bodies on save.
  //   - `voice` is null while loading and falls back to VOICE_DEFAULTS for
  //     the form state so we never render uncontrolled inputs.
  //   - `voiceLoaded` is the last-known-server snapshot used to compute
  //     the "dirty" flag that drives the Save button's disabled state.
  //   - `voiceCustomLang` lets the operator type an ISO 639-1 code that
  //     isn't in the dropdown (e.g. `pt`, `ja`). When the dropdown is on
  //     "custom" we read from this field instead.
  const [voice, setVoice] = useState<VoiceSettings>(VOICE_DEFAULTS);
  const [voiceLoaded, setVoiceLoaded] = useState<VoiceSettings | null>(null);
  const [voiceCustomLang, setVoiceCustomLang] = useState("");
  const [voiceSaveState, setVoiceSaveState] = useState<
    "idle" | "saving" | "ok" | "fail"
  >("idle");
  const [voiceSaveError, setVoiceSaveError] = useState<string>();

  // Timezone (System tab). Global IANA TZ persisted via
  //   GET /api/system/timezone  →  { timezone: string }
  //   PUT /api/system/timezone  ←  { timezone: string }
  //
  //   - `tzSaved`     is the last server snapshot, used to detect "dirty" so
  //                   the Save button only enables on actual changes.
  //   - `tzDraft`     is the currently-edited value (dropdown / auto-detect).
  //   - `tzNow`       drives the live ticking clock; updated every 1s via
  //                   setInterval while the System tab is mounted.
  //   - `tzOptions`   is the full IANA list from Intl.supportedValuesOf, or
  //                   the curated fallback for Firefox < 110.
  //   - `tzFallback`  flag toggles the "Limited list — Firefox-Browser" hint.
  const [tzSaved, setTzSaved] = useState<string | null>(null);
  const [tzDraft, setTzDraft] = useState<string>("UTC");
  const [tzNow, setTzNow] = useState<Date>(new Date());
  const [tzSaveState, setTzSaveState] = useState<
    "idle" | "saving" | "ok" | "fail"
  >("idle");
  const [tzSaveError, setTzSaveError] = useState<string>();
  const [tzAutoDetected, setTzAutoDetected] = useState<string | null>(null);

  // Vault maintenance — ULID-Backfill (Phase D Wave D1 / Story 1)
  const [backfillStatus, setBackfillStatus] = useState<{
    totalNotes: number;
    scanned: number;
    withoutUlid: number;
    scanLimited: boolean;
  } | null>(null);
  const [backfillState, setBackfillState] = useState<
    "idle" | "running" | "ok" | "fail"
  >("idle");
  const [backfillError, setBackfillError] = useState<string>();
  const [backfillLastRun, setBackfillLastRun] = useState<string | null>(null);

  // Vault maintenance — BM25 search-index reindex (Story: search-reindex).
  // Populates `note_search` for every note so the Tier-1 fast path serves
  // pre-existing notes instead of hitting the slow in-memory fallback.
  const [reindexState, setReindexState] = useState<
    "idle" | "running" | "ok" | "fail"
  >("idle");
  const [reindexError, setReindexError] = useState<string>();
  const [reindexResult, setReindexResult] = useState<{
    indexed: number;
    ms: number;
  } | null>(null);

  // ── Diagnose-Tab — per-service self-test suite (Observability story) ──
  //   - `diagnostics` is the last successful `api.getDiagnostics()` payload.
  //   - `diagState` reflects the in-flight run; auto-runs once on first open.
  //   - `diagError` carries a top-level fetch failure (endpoint unreachable).
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResult | null>(
    null,
  );
  const [diagState, setDiagState] = useState<
    "idle" | "running" | "ok" | "fail"
  >("idle");
  const [diagError, setDiagError] = useState<string>();

  // ── Logs-Tab — filterable ring-buffer view ──
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [logsState, setLogsState] = useState<
    "idle" | "loading" | "ok" | "fail"
  >("idle");
  const [logsError, setLogsError] = useState<string>();
  const [logLevel, setLogLevel] = useState<"all" | LogLevel>("all");
  const [logService, setLogService] = useState<string>("all");

  // ── Kurator-Tab — sleep-agent runs, manual trigger, found connections ──
  const [kuratorRuns, setKuratorRuns] = useState<SleepRunItem[] | null>(null);
  const [kuratorState, setKuratorState] = useState<
    "idle" | "loading" | "ok" | "fail"
  >("idle");
  const [kuratorError, setKuratorError] = useState<string>();
  // `running` = a REM run is in flight; `notice` carries the inline 409 hint.
  const [kuratorTriggerState, setKuratorTriggerState] = useState<
    "idle" | "running" | "done" | "busy"
  >("idle");
  const [kuratorTriggerNotice, setKuratorTriggerNotice] = useState<string>();
  // Count of auto topic-notes (the "Bezüge") + open-state for the reused panel.
  const [kuratorBezuegeCount, setKuratorBezuegeCount] = useState<number | null>(
    null,
  );
  const [kuratorReviewOpen, setKuratorReviewOpen] = useState(false);

  /**
   * Fetch the canonical runtime view. The backend route is being built in
   * parallel; until it ships, a 404 / network error returns `null` and the
   * page falls back to the legacy payloads.
   */
  async function loadRuntime(): Promise<RuntimeInfo | null> {
    try {
      const res = await fetch("/api/settings/runtime", {
        credentials: "include",
      });
      if (!res.ok) {
        console.debug("[Settings] /api/settings/runtime →", res.status);
        return null;
      }
      const payload = (await res.json()) as RuntimeInfo;
      // Debug probe for bug-fix #1 — verify the payload actually carries
      // vault.gitRemote. Cheap, runs once per Settings open.
      console.debug("[Settings] runtime payload", {
        vaultGitRemote: payload.vault?.gitRemote,
        vaultGitBranch: payload.vault?.gitBranch,
        mcpPublicUrl: payload.env?.mcpPublicUrl,
      });
      return payload;
    } catch (err) {
      console.debug("[Settings] /api/settings/runtime failed", err);
      return null;
    }
  }

  async function load() {
    const [sRes, statusRes, mcpRes, skillRes, runtimeRes] = await Promise.all([
      fetch("/api/admin/system-settings").then(
        (r) => r.json(),
      ) as Promise<SystemSettings>,
      fetch("/api/admin/status").then(
        (r) => r.json(),
      ) as Promise<StatusResult>,
      fetch("/api/admin/mcp-info").then((r) => r.json()) as Promise<McpInfo>,
      fetch("/api/admin/skills").then(
        (r) => r.json(),
      ) as Promise<{ skills: SkillInfo[] }>,
      loadRuntime(),
    ]);
    setSettings(sRes);
    setStatus(statusRes);
    setMcp(mcpRes);
    setSkills(skillRes.skills);
    setRuntime(runtimeRes);
    // Pre-fill the editable Vault-URL inputs. Prefer the runtime payload
    // because the legacy `system-settings` row may be stale or empty even
    // after a successful `setupVaultFromForgejo` flow.
    const vaultRemote =
      runtimeRes?.vault?.gitRemote || sRes.vault?.gitRemote || "";
    const vaultBranch =
      runtimeRes?.vault?.gitBranch || sRes.vault?.gitBranch || "main";
    setNewRemote(vaultRemote);
    setNewBranch(vaultBranch);
    // Pre-fill integrations with masked key / current folder.
    setSupadataInput(sRes.integrations.supadataApiKeyMasked ?? "");
    setSupadataTouched(false);
    setImportFolderInput(sRes.integrations.defaultImportFolder);

    // Backfill status — fetched separately so a slow scan can't block the
    // rest of the Settings render. Errors here are non-fatal.
    void loadBackfillStatus();
  }

  /**
   * Probe the live Forgejo connection. `/api/forgejo/probe` calls
   * Forgejo's `/api/v1/user` with the stored token and tells us whether
   * it still authenticates. This is the only reliable way to know that
   * the OAuth JWT has not silently expired — the `connection` endpoint
   * just checks DB presence.
   */
  async function loadForgejoProbe() {
    setForgejoProbe("loading");
    try {
      const res = await fetch("/api/forgejo/probe", { credentials: "include" });
      if (!res.ok) {
        setForgejoProbe("network");
        setForgejoUser(null);
        return;
      }
      const data = (await res.json()) as
        | { ok: true; forgejoUserLogin: string }
        | { ok: false; reason: "expired" | "no-token" | "network" };
      if (data.ok) {
        setForgejoProbe("connected");
        setForgejoUser(data.forgejoUserLogin);
        return;
      }
      setForgejoUser(null);
      if (data.reason === "no-token") setForgejoProbe("none");
      else if (data.reason === "expired") setForgejoProbe("expired");
      else setForgejoProbe("network");
    } catch {
      setForgejoProbe("network");
      setForgejoUser(null);
    }
  }

  async function loadBackfillStatus() {
    try {
      const status = await api.getBackfillStatus();
      setBackfillStatus(status);
    } catch {
      setBackfillStatus(null);
    }
  }

  async function runBackfill() {
    setBackfillState("running");
    setBackfillError(undefined);
    try {
      const result = await api.runBackfill();
      if (!result.ok) {
        setBackfillState("fail");
        setBackfillError(result.error ?? "Backfill fehlgeschlagen");
        return;
      }
      setBackfillState("ok");
      setBackfillLastRun(new Date().toISOString());
      // Refresh the pending count after the run.
      await loadBackfillStatus();
    } catch (err) {
      setBackfillState("fail");
      setBackfillError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Load the recent sleep-agent runs for the Kurator status + history. */
  async function loadKuratorRuns() {
    setKuratorState("loading");
    setKuratorError(undefined);
    try {
      const { runs } = await api.getSleepRuns({ limit: 20 });
      setKuratorRuns(runs);
      setKuratorState("ok");
    } catch (err) {
      setKuratorState("fail");
      setKuratorError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Fetch the current connection ("Bezüge") count = auto topic-notes pending. */
  async function loadKuratorBezuege() {
    try {
      const queue = await api.getAgentReviewQueue(30);
      setKuratorBezuegeCount(queue.topicNotes.length);
    } catch {
      // Non-fatal — the count badge just stays unknown.
      setKuratorBezuegeCount(null);
    }
  }

  /**
   * Trigger the REM phase — the run that ACTUALLY produces connections
   * (topic-synthesis writes the auto topic-notes). NREM only does
   * maintenance passes, so we deliberately fire `rem` here. After the run we
   * refresh both the run history and the connection count. A 409 surfaces as
   * an inline notice rather than throwing.
   */
  async function runKuratorRem() {
    setKuratorTriggerState("running");
    setKuratorTriggerNotice(undefined);
    try {
      const result = await api.triggerSleepPhase("rem");
      if (!result.ok) {
        // 409 — another run already in flight.
        setKuratorTriggerState("busy");
        setKuratorTriggerNotice(
          "Es läuft bereits ein Lauf — bitte gleich nochmal versuchen.",
        );
        // Still refresh so the in-flight run shows up in the history.
        await loadKuratorRuns();
        return;
      }
      setKuratorTriggerState("done");
      await Promise.all([loadKuratorRuns(), loadKuratorBezuege()]);
    } catch (err) {
      setKuratorTriggerState("idle");
      setKuratorTriggerNotice(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function runReindex() {
    setReindexState("running");
    setReindexError(undefined);
    setReindexResult(null);
    try {
      const result = await api.reindexSearch();
      setReindexResult(result);
      setReindexState("ok");
    } catch (err) {
      setReindexState("fail");
      setReindexError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Run the per-service diagnostics suite. The server never 500s — a failed
   * service surfaces as a check with `ok:false` + `detail` — so the only
   * top-level failure mode here is the endpoint being unreachable.
   */
  async function runDiagnostics() {
    setDiagState("running");
    setDiagError(undefined);
    try {
      const result = await api.getDiagnostics();
      setDiagnostics(result);
      setDiagState("ok");
    } catch (err) {
      setDiagState("fail");
      setDiagError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Fetch the newest log entries from the server's in-process ring buffer.
   * The level filter is pushed to the server; the service filter is applied
   * client-side (the operator picks from the services actually present).
   */
  async function loadLogs() {
    setLogsState("loading");
    setLogsError(undefined);
    try {
      const result: LogsResult = await api.getLogs({
        limit: DEFAULT_LOG_LIMIT,
        ...(logLevel !== "all" ? { level: logLevel } : {}),
      });
      setLogs(result.logs);
      setLogsState("ok");
    } catch (err) {
      setLogsState("fail");
      setLogsError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Fetch the persisted voice defaults. 404 / network errors leave the
   * form on `VOICE_DEFAULTS` so the operator can still type and save.
   */
  async function loadVoiceSettings() {
    try {
      const res = await fetch("/api/voice/settings", {
        credentials: "include",
      });
      if (!res.ok) {
        console.debug("[Settings] /api/voice/settings →", res.status);
        return;
      }
      const data = (await res.json()) as Partial<VoiceSettings>;
      const merged: VoiceSettings = {
        mode: (data.mode as VoiceMode) ?? VOICE_DEFAULTS.mode,
        folder: data.folder ?? VOICE_DEFAULTS.folder,
        titlePattern: data.titlePattern ?? VOICE_DEFAULTS.titlePattern,
        language: data.language ?? null,
        aiTitle: data.aiTitle ?? VOICE_DEFAULTS.aiTitle,
      };
      setVoice(merged);
      setVoiceLoaded(merged);
      // If the persisted language isn't in the dropdown, surface it via
      // the custom-language input so the user sees it without losing it.
      if (
        merged.language &&
        !VOICE_LANGUAGES.some((l) => l.value === merged.language)
      ) {
        setVoiceCustomLang(merged.language);
      } else {
        setVoiceCustomLang("");
      }
    } catch (err) {
      console.debug("[Settings] /api/voice/settings failed", err);
    }
  }

  async function saveVoiceSettings() {
    setVoiceSaveState("saving");
    setVoiceSaveError(undefined);
    try {
      const res = await fetch("/api/voice/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(voice),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setVoiceSaveState("fail");
        setVoiceSaveError(
          (data as { message?: string; error?: string }).message ??
            (data as { error?: string }).error ??
            "Fehler",
        );
        return;
      }
      setVoiceSaveState("ok");
      setVoiceLoaded(voice);
      // Auto-clear the success flash after a few seconds.
      setTimeout(() => setVoiceSaveState("idle"), 2500);
    } catch (err) {
      setVoiceSaveState("fail");
      setVoiceSaveError(err instanceof Error ? err.message : "Fehler");
    }
  }

  /**
   * Fetch the persisted global timezone. 404 / network errors leave the
   * form on the browser-local TZ so the operator can still save.
   */
  async function loadTimezone() {
    try {
      const res = await fetch("/api/system/timezone", {
        credentials: "include",
      });
      if (!res.ok) {
        console.debug("[Settings] /api/system/timezone →", res.status);
        // Pre-fill with browser-local so the dropdown isn't empty.
        const browserTz =
          Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        setTzDraft(browserTz);
        return;
      }
      const data = (await res.json()) as { timezone?: string };
      const tz =
        data.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
      setTzSaved(tz);
      setTzDraft(tz);
    } catch (err) {
      console.debug("[Settings] /api/system/timezone failed", err);
      const browserTz =
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      setTzDraft(browserTz);
    }
  }

  async function saveTimezone() {
    setTzSaveState("saving");
    setTzSaveError(undefined);
    try {
      const res = await fetch("/api/system/timezone", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ timezone: tzDraft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTzSaveState("fail");
        setTzSaveError(
          (data as { message?: string; error?: string }).message ??
            (data as { error?: string }).error ??
            "Ungültige IANA-Zeitzone",
        );
        return;
      }
      const updated =
        (data as { timezone?: string }).timezone ?? tzDraft;
      setTzSaved(updated);
      setTzDraft(updated);
      setTzSaveState("ok");
      setTimeout(() => setTzSaveState("idle"), 2500);
    } catch (err) {
      setTzSaveState("fail");
      setTzSaveError(err instanceof Error ? err.message : "Fehler");
    }
  }

  useEffect(() => {
    void load();
    void loadForgejoProbe();
    void loadTimezone();
    // OAuth-callback flash: if we just landed back from
    // `/api/auth/forgejo/callback` (which 302'd us to
    // `/settings?forgejo=connected`), show a brief confirmation and
    // scrub the query param so a refresh doesn't re-trigger it.
    if (
      typeof window !== "undefined" &&
      window.location.search.includes("forgejo=connected")
    ) {
      setReconnectFlash(true);
      // Auto-jump to the Vault tab — that's where the affordance lives.
      setTab("vault");
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("forgejo");
        const search = url.searchParams.toString();
        window.history.replaceState(
          {},
          "",
          url.pathname + (search ? `?${search}` : "") + url.hash,
        );
      } catch {
        // Older browsers — ignore, the user can refresh manually.
      }
      // Re-probe after the OAuth round-trip so the indicator goes green.
      void loadForgejoProbe();
      // Auto-hide the flash after a few seconds.
      const t = setTimeout(() => setReconnectFlash(false), 4000);
      return () => clearTimeout(t);
    }
  }, []);

  /** Navigate to the OAuth start endpoint with a same-origin `next`. */
  function reconnectForgejo() {
    const next = "/settings?forgejo=connected";
    window.location.href = `/api/auth/forgejo/start?next=${encodeURIComponent(
      next,
    )}`;
  }

  /**
   * Live MCP health probe (Bug-fix #2). The backend advertises
   * `available: true` unconditionally, so we curl the actual `/health`
   * URL that the operator would test by hand. AbortController gives us a
   * tight 4s timeout — a 30s container start-up window is not "healthy".
   *
   * Runs once on mount + every 10s + on demand via "Status erneut prüfen".
   * No-op when there's no public URL yet (pre-deploy, no runtime payload).
   */
  async function probeMcpHealth() {
    const publicUrl = runtime?.env?.mcpPublicUrl?.trim();
    if (!publicUrl) {
      setMcpHealthy(null);
      setMcpHealthCheckedAt(null);
      return;
    }
    const healthUrl = publicUrl.endsWith("/")
      ? `${publicUrl}health`
      : `${publicUrl}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
        // Public URL is cross-origin — don't send cookies, don't fail on CORS
        // for opaque responses. We only need to know "did the TCP+TLS round
        // trip succeed with a non-error status".
        mode: "cors",
        credentials: "omit",
      });
      setMcpHealthy(res.ok);
    } catch {
      // AbortError (timeout) or network failure → unhealthy
      setMcpHealthy(false);
    } finally {
      clearTimeout(timer);
      setMcpHealthCheckedAt(new Date().toISOString());
    }
  }

  // Probe MCP health on mount and whenever the runtime URL changes; then
  // refresh every 10s. Cleanup cancels the interval on unmount.
  useEffect(() => {
    void probeMcpHealth();
    const id = setInterval(() => void probeMcpHealth(), 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime?.env?.mcpPublicUrl]);

  // Lazy-load voice defaults: first time the operator switches to the
  // Voice tab we GET /api/voice/settings. Re-fetching on every tab swap
  // would clobber unsaved edits, so we gate on `voiceLoaded === null`.
  useEffect(() => {
    if (tab === "voice" && voiceLoaded === null) {
      void loadVoiceSettings();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Auto-run diagnostics the first time the Diagnose tab is opened. The
  // operator can re-run via the "Tests ausführen" button. We gate on
  // `diagnostics === null` so re-visiting the tab doesn't clobber the last
  // result with a fresh spinner.
  useEffect(() => {
    if (tab === "diagnose" && diagnostics === null && diagState !== "running") {
      void runDiagnostics();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Auto-load logs the first time the Logs tab is opened. Refresh + the
  // level filter re-fetch from the server; the service filter is local.
  useEffect(() => {
    if (tab === "logs" && logs === null && logsState !== "loading") {
      void loadLogs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Auto-load the sleep-agent run history + connection count the first time
  // the Kurator tab is opened. Gated on `kuratorRuns === null` so re-visiting
  // doesn't clobber a freshly-triggered run with a stale spinner.
  useEffect(() => {
    if (tab === "kurator" && kuratorRuns === null && kuratorState !== "loading") {
      void loadKuratorRuns();
      void loadKuratorBezuege();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Live clock ticker for the Timezone panel. Only ticks while the
  // System tab is visible — cleanup cancels the interval on tab switch
  // or unmount so we don't burn cycles on hidden panels.
  useEffect(() => {
    if (tab !== "system") return;
    setTzNow(new Date());
    const id = setInterval(() => setTzNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [tab]);

  async function changeVaultUrl() {
    // Vault-ID can come from either payload — runtime is preferred but the
    // legacy field is a valid fallback when /api/settings/runtime isn't live.
    const vaultId = runtime?.vault?.id ?? settings?.vault?.id;
    if (!vaultId) return;
    setVaultSaveState("saving");
    setVaultSaveError(undefined);
    setVaultAuthFailed(false);
    try {
      const res = await fetch("/api/admin/system-settings/vault-url", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaultId,
          gitRemote: newRemote,
          gitBranch: newBranch,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVaultSaveState("fail");
        const message = data.message ?? data.error ?? "Fehler";
        setVaultSaveError(message);
        // Heuristic for "token vermutlich abgelaufen": the admin route
        // returns 400 with `error: 'remote-unreachable'` for almost any
        // failure including auth. Treat a literal 401, or a 400 whose
        // message mentions 401/auth/Unauthorized/permission, as an
        // auth-failure and prompt for reconnect.
        const looksLikeAuth =
          res.status === 401 ||
          (res.status === 400 &&
            /\b(401|unauthorized|authentication|permission denied|access denied|invalid (?:token|credentials))\b/i.test(
              String(message),
            ));
        setVaultAuthFailed(looksLikeAuth);
        // Refresh the probe — Forgejo may have rejected the token
        // server-side already.
        if (looksLikeAuth) void loadForgejoProbe();
      } else {
        setVaultSaveState("ok");
        setVaultAuthFailed(false);
        await load();
      }
    } catch (err) {
      setVaultSaveState("fail");
      setVaultSaveError(err instanceof Error ? err.message : "Fehler");
    }
  }

  async function saveIntegrations(opts?: { clearKey?: boolean }) {
    setIntegrationsSaveState("saving");
    setIntegrationsSaveError(undefined);
    try {
      const body: {
        supadataApiKey?: string | null;
        defaultImportFolder?: string | null;
      } = {};
      if (opts?.clearKey) {
        body.supadataApiKey = "";
      } else if (supadataTouched) {
        // Only send the key if the user actually typed something new.
        body.supadataApiKey = supadataInput;
      }
      body.defaultImportFolder = importFolderInput;
      const res = await fetch("/api/admin/system-settings/integrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setIntegrationsSaveState("fail");
        setIntegrationsSaveError(data.message ?? data.error ?? "Fehler");
      } else {
        setIntegrationsSaveState("ok");
        await load();
      }
    } catch (err) {
      setIntegrationsSaveState("fail");
      setIntegrationsSaveError(err instanceof Error ? err.message : "Fehler");
    }
  }

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  /**
   * Story 7.10 AC#5 — splice a freshly generated token into the config
   * snippets. Without a fresh token the snippet keeps the marker, which reads
   * as "put your token here" rather than the old
   * `<set-LOKYY_MCP_TOKEN-env-and-restart>` instruction to edit a file and
   * restart. When an env token is configured the backend already inlined it,
   * so there is no marker to replace and this is a no-op.
   */
  function withToken(text: string): string {
    const marker = mcp?.tokenPlaceholder;
    if (!marker || !freshMcpToken) return text;
    return text.split(marker).join(freshMcpToken);
  }

  /**
   * Vault identifiers used in multiple tabs (MCP tab + Vault tab). Computed
   * once, falls through legacy → runtime cleanly.
   */
  const vaultId = runtime?.vault?.id ?? settings?.vault?.id ?? null;
  const vaultName = runtime?.vault?.name ?? settings?.vault?.name ?? "—";

  // ── MCP variants — pre-patched with the live runtime URL so the Remote
  //    snippet's "args" array points at SERVICE_FQDN_LOKYY_MCP, not the
  //    backend's localhost:8788 default. Memoized so the JSON.stringify in
  //    `applyRuntimeOverrides` doesn't re-run on every render.
  const patchedVariants = useMemo(() => {
    if (!mcp?.variants) return null;
    return {
      a_local_stdio: applyRuntimeOverrides(
        mcp.variants.a_local_stdio,
        "a_local_stdio",
        runtime,
      ),
      b_npx: applyRuntimeOverrides(mcp.variants.b_npx, "b_npx", runtime),
      c_native_http: applyRuntimeOverrides(
        mcp.variants.c_native_http,
        "c_native_http",
        runtime,
      ),
      d_mcp_remote_legacy: applyRuntimeOverrides(
        mcp.variants.d_mcp_remote_legacy,
        "d_mcp_remote_legacy",
        runtime,
      ),
      e_claude_ai_oauth: applyRuntimeOverrides(
        mcp.variants.e_claude_ai_oauth,
        "e_claude_ai_oauth",
        runtime,
      ),
    };
  }, [mcp, runtime]);

  // ── Timezone options. `Intl.supportedValuesOf("timeZone")` is the
  //    canonical source (~600 zones). Firefox added it in 110 — older
  //    builds throw, so we fall back to a curated common-zones list and
  //    raise the `tzFallback` flag for the UI hint.
  const tzCatalog = useMemo<{ list: string[]; fallback: boolean }>(() => {
    try {
      const fn = (
        Intl as unknown as {
          supportedValuesOf?: (k: string) => string[];
        }
      ).supportedValuesOf;
      if (typeof fn === "function") {
        const list = fn("timeZone");
        if (Array.isArray(list) && list.length > 0) {
          return { list: [...list].sort(), fallback: false };
        }
      }
    } catch {
      // fall through to fallback
    }
    return { list: [...TZ_FALLBACK_LIST].sort(), fallback: true };
  }, []);

  // Ensure the currently-saved TZ is selectable even if it's not in the
  // catalog (custom IANA name, region the browser doesn't recognise).
  const tzOptions = useMemo<string[]>(() => {
    const base = tzCatalog.list;
    if (tzDraft && !base.includes(tzDraft)) {
      return [tzDraft, ...base];
    }
    return base;
  }, [tzCatalog, tzDraft]);

  if (!settings || !status || !mcp) {
    return (
      <div
        style={{
          padding: 32,
          color: C.textDim,
          fontFamily: FONT.mono,
          fontSize: 13,
        }}
      >
        Settings laden …
      </div>
    );
  }

  return (
    <div
      style={{
        // Tighter padding on mobile so content gets full width; desktop
        // keeps the original 32px breathing room.
        padding: isMobile ? 16 : 32,
        background: C.bg,
        color: C.text,
        fontFamily: FONT.ui,
        height: "100%",
        overflowY: "auto",
        // Guard against any descendant accidentally forcing the page wider
        // than the viewport on a phone (the source of horizontal scroll).
        overflowX: "hidden",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 18,
          flexWrap: "wrap",
        }}
      >
        <h1
          style={{
            fontFamily: FONT.serif,
            fontSize: isMobile ? 22 : 28,
            margin: 0,
            color: C.accent,
          }}
        >
          Einstellungen
        </h1>
        <button onClick={onClose} style={mobileBtn(btn, isMobile)}>
          ← Zurück zum Vault
        </button>
      </div>

      {/* ───── Tab bar ─────
          Desktop: pill row that wraps. Mobile: a single horizontally
          scrolling pill strip so no tab clips off-screen. The flex children
          get `flex: 0 0 auto` on mobile so they keep their intrinsic width
          and the strip scrolls instead of squashing. */}
      <div
        role="tablist"
        aria-label="Settings sections"
        style={{
          display: "flex",
          gap: 6,
          marginBottom: 22,
          padding: 4,
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: isMobile ? 14 : 999,
          width: isMobile ? "100%" : "fit-content",
          flexWrap: isMobile ? "nowrap" : "wrap",
          overflowX: isMobile ? "auto" : "visible",
          WebkitOverflowScrolling: "touch",
          boxSizing: "border-box",
        }}
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              style={{
                padding: isMobile ? "9px 16px" : "6px 16px",
                minHeight: isMobile ? TOUCH_TARGET_MIN : undefined,
                background: active ? C.accent : "transparent",
                color: active ? "#0B0E12" : C.textDim,
                border: "none",
                borderRadius: 999,
                fontFamily: FONT.ui,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                whiteSpace: "nowrap",
                flex: isMobile ? "0 0 auto" : undefined,
                transition: "background 120ms, color 120ms",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ───── Tab: System ───── */}
      {tab === "mandanten" && <TenantsTab />}

      {tab === "system" && (
        <>
          {/* Story 7.12 — Version + Update-Status als ruhiger Ort, wenn das
              Banner in der App-Shell geschlossen wurde. */}
          <Section title="Version">
            <SystemVersionInfo />
          </Section>
          <Section title="System-Status">
            <ServiceStatusRow
              service="forgejo"
              label="Forgejo"
              ok={status.forgejo.ok}
              detail={status.forgejo.error}
              onCopy={copy}
              copiedLabel={copied}
              isMobile={isMobile}
            />
            <ServiceStatusRow
              service="postgres"
              label="Postgres"
              ok={status.postgres.ok}
              detail={
                status.postgres.error ??
                (status.postgres.pgvector
                  ? `pgvector v${status.postgres.pgvector}`
                  : "pgvector fehlt")
              }
              onCopy={copy}
              copiedLabel={copied}
              isMobile={isMobile}
            />
            <ServiceStatusRow
              service="ollama"
              label="Ollama"
              ok={status.ollama.ok}
              detail={
                status.ollama.error ??
                (status.ollama.hasNomicEmbed
                  ? "nomic-embed-text bereit"
                  : "nomic-embed-text fehlt")
              }
              onCopy={copy}
              copiedLabel={copied}
              isMobile={isMobile}
            />
            {(() => {
              // Prefer the backend-derived `embeddings` entry; fall back to
              // synthesizing it from the Ollama probe for older backends that
              // don't emit it yet. Embeddings only make sense once Ollama is
              // reachable — when it isn't, the row reflects that dependency.
              const emb =
                status.embeddings ??
                (status.ollama.ok
                  ? {
                      ok: !!status.ollama.hasNomicEmbed,
                      error: status.ollama.hasNomicEmbed
                        ? undefined
                        : "Modell nomic-embed-text nicht installiert",
                    }
                  : {
                      ok: false,
                      error:
                        "Ollama nicht erreichbar — Embeddings-Modell nicht prüfbar",
                    });
              return (
                <ServiceStatusRow
                  service="embeddings"
                  label="Embeddings"
                  ok={emb.ok}
                  detail={
                    emb.error ?? "nomic-embed-text bereit"
                  }
                  onCopy={copy}
                  copiedLabel={copied}
                  isMobile={isMobile}
                />
              );
            })()}
            <button
              onClick={() => void load()}
              style={{ ...btn, marginTop: 12 }}
            >
              Status neu laden
            </button>
          </Section>

          <TimezonePanel
            tzDraft={tzDraft}
            setTzDraft={setTzDraft}
            tzSaved={tzSaved}
            tzNow={tzNow}
            tzOptions={tzOptions}
            tzFallback={tzCatalog.fallback}
            tzAutoDetected={tzAutoDetected}
            onAutoDetect={() => {
              const browserTz =
                Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
              setTzDraft(browserTz);
              setTzAutoDetected(browserTz);
            }}
            saveState={tzSaveState}
            saveError={tzSaveError}
            onSave={() => void saveTimezone()}
          />

          <VaultScaffoldPanel isMobile={isMobile} />
        </>
      )}

      {/* ───── Tab: Vault ───── */}
      {tab === "vault" && (
        <>
          {reconnectFlash && (
            <div
              style={{
                marginBottom: 14,
                padding: "10px 14px",
                background: C.elevated,
                border: `1px solid ${C.ok}`,
                borderRadius: 6,
                color: C.ok,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Check size={14} /> Forgejo-Verbindung erneuert
            </div>
          )}
          <Section title="Vault-URL (Forgejo Remote)">
            {/* Connection-status line: probe live `/api/forgejo/probe`
                so the operator can see at a glance whether the OAuth JWT
                is still valid (Forgejo expires them after ~1h). */}
            <ForgejoConnectionStatus
              state={forgejoProbe}
              forgejoUser={forgejoUser}
              onReconnect={reconnectForgejo}
              onRecheck={() => void loadForgejoProbe()}
            />
            <Field label="Vault-Name" value={vaultName} readOnly />
            <Field
              label="GIT_REMOTE"
              value={newRemote}
              onChange={setNewRemote}
            />
            <Field
              label="GIT_BRANCH"
              value={newBranch}
              onChange={setNewBranch}
            />
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button
                onClick={changeVaultUrl}
                disabled={vaultSaveState === "saving"}
                style={btn}
              >
                {vaultSaveState === "saving" && (
                  <Loader2 size={14} className="sw-spin" />
                )}
                Vault-URL ändern (mit Test)
              </button>
              {vaultSaveState === "ok" && (
                <span style={{ color: C.ok, fontSize: 13 }}>
                  <Check size={14} /> gespeichert
                </span>
              )}
              {vaultSaveState === "fail" && (
                <span style={{ color: C.err, fontSize: 13 }}>
                  <X size={14} /> {vaultSaveError}
                </span>
              )}
            </div>
            {/* Auth-failure escalation: when the test smelled like an
                expired token, surface the reconnect-button inline
                directly under the error so the operator isn't left to
                guess at the root cause. */}
            {vaultSaveState === "fail" && vaultAuthFailed && (
              <div
                style={{
                  marginTop: 10,
                  padding: 10,
                  background: C.elevated,
                  border: `1px solid ${C.gold}`,
                  borderRadius: 6,
                  fontSize: 13,
                  color: C.text,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ color: C.gold }}>
                  Token vermutlich abgelaufen.
                </span>
                <button
                  onClick={reconnectForgejo}
                  style={{
                    ...btn,
                    borderColor: C.gold,
                    color: C.gold,
                  }}
                >
                  <RefreshCw size={13} /> Forgejo neu verbinden
                </button>
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <button
                onClick={reconnectForgejo}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  color: C.textDim,
                  fontFamily: FONT.ui,
                  fontSize: 12,
                  cursor: "pointer",
                  textDecoration: "underline",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
                title="Öffnet den Forgejo-OAuth-Flow und kehrt danach in die Settings zurück."
              >
                <RefreshCw size={11} /> Forgejo-Verbindung erneuern
              </button>
            </div>
          </Section>

          <Section title="Integrations">
            <label style={{ display: "block", marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 11,
                  color: C.textDim,
                  marginBottom: 4,
                  fontFamily: FONT.mono,
                }}
              >
                Supadata API Key
                {settings.integrations.supadataApiKeyConfigured ? (
                  <span style={{ color: C.ok, marginLeft: 8 }}>
                    ● gespeichert
                  </span>
                ) : (
                  <span style={{ color: C.gold, marginLeft: 8 }}>
                    ● nicht konfiguriert
                  </span>
                )}
              </div>
              <input
                type="password"
                value={supadataInput}
                placeholder={
                  settings.integrations.supadataApiKeyConfigured
                    ? "Tippen zum Überschreiben"
                    : "z.B. sk-supadata-…"
                }
                onChange={(e) => {
                  setSupadataInput(e.target.value);
                  setSupadataTouched(true);
                }}
                onFocus={() => {
                  // First focus on a masked field → clear it so the user can type fresh.
                  if (
                    !supadataTouched &&
                    settings.integrations.supadataApiKeyConfigured &&
                    supadataInput.startsWith("***")
                  ) {
                    setSupadataInput("");
                    setSupadataTouched(true);
                  }
                }}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  background: C.elevated,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  color: C.text,
                  fontFamily: FONT.mono,
                  fontSize: 13,
                  outline: "none",
                }}
              />
              <div
                style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}
              >
                Wird für URL- und YouTube-Import-Pipes verwendet. Wir senden
                den Key nie zurück zum Browser — nur die Maske{" "}
                <code>***...{"{last4}"}</code>.
              </div>
            </label>

            <Field
              label="Default Import Folder (vault-relativ)"
              value={importFolderInput}
              onChange={setImportFolderInput}
            />

            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={() => void saveIntegrations()}
                disabled={integrationsSaveState === "saving"}
                style={btn}
              >
                {integrationsSaveState === "saving" && (
                  <Loader2 size={14} className="sw-spin" />
                )}
                Integrations speichern
              </button>
              {settings.integrations.supadataApiKeyConfigured && (
                <button
                  onClick={() => void saveIntegrations({ clearKey: true })}
                  disabled={integrationsSaveState === "saving"}
                  style={{ ...btn, color: C.err }}
                >
                  Key löschen
                </button>
              )}
              {integrationsSaveState === "ok" && (
                <span style={{ color: C.ok, fontSize: 13 }}>
                  <Check size={14} /> gespeichert
                </span>
              )}
              {integrationsSaveState === "fail" && (
                <span style={{ color: C.err, fontSize: 13 }}>
                  <X size={14} /> {integrationsSaveError}
                </span>
              )}
            </div>
          </Section>
        </>
      )}

      {/* ───── Tab: AI Provider ───── */}
      {tab === "ai" && (
        <AiProviderSettings
          runtimeOllamaHost={
            runtime?.env.ollamaHost ?? settings.runtime.ollamaHost
          }
        />
      )}

      {/* ───── Tab: MCP ───── */}
      {tab === "mcp" && (
        <Section title="MCP-Anbindung — so verbindest du Claude">
          <VaultIdCard
            vaultId={vaultId}
            mcpHealthy={mcpHealthy}
            mcpHealthCheckedAt={mcpHealthCheckedAt}
            mcpPublicUrl={runtime?.env.mcpPublicUrl}
            onCopy={() => {
              if (vaultId) copy("vault-id", vaultId);
            }}
            onRecheck={() => void probeMcpHealth()}
            copiedLabel={copied}
          />

          {/*
            Story 7.10 — Token-Verwaltung. Bewusst AUSSERHALB des
            `mcpHealthy === true`-Gates: wer noch keinen Token hat, muss
            trotzdem einen erzeugen können, und genau dann ist der Dienst oft
            noch nicht erreichbar.
          */}
          <McpTokenSection
            endpoint={
              patchedVariants?.c_native_http.endpointUrl ??
              runtime?.env.mcpPublicUrl
            }
            onFreshToken={setFreshMcpToken}
          />

          {/*
            Bug-fix #3: only show the three claude_desktop_config snippets
            when the MCP service is reachable. While unhealthy, render a
            single guidance block so nobody copies a half-broken config.
            `mcpHealthy === true` keeps null (= "still probing") on the
            guidance side, which is the safe default.
          */}
          {mcpHealthy === true ? (
            <>
              <p
                style={{ color: C.ok, fontSize: 13, margin: "0 0 8px 0" }}
              >
                MCP-Server läuft. Tools:{" "}
                <code style={{ color: C.gold }}>
                  {(mcp.tools ?? []).join(", ")}
                </code>
              </p>

              {patchedVariants ? (
                <>
                  {(
                    [
                      "a_local_stdio",
                      "b_npx",
                      "c_native_http",
                      "e_claude_ai_oauth",
                      "d_mcp_remote_legacy",
                    ] as const
                  ).map((k) => {
                    const v = patchedVariants[k];
                    const isLegacy = k === "d_mcp_remote_legacy";
                    return (
                      <div
                        key={k}
                        style={{
                          marginBottom: 18,
                          padding: 12,
                          background: C.elevated,
                          borderRadius: 6,
                          border: `1px solid ${isLegacy ? C.border : C.border}`,
                          opacity: isLegacy ? 0.85 : 1,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "baseline",
                            gap: 8,
                          }}
                        >
                          <strong
                            style={{
                              color: C.accent,
                              fontFamily: FONT.serif,
                              fontSize: 14,
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            {v.title}
                            {isLegacy && (
                              <span
                                style={{
                                  fontSize: 10,
                                  color: C.textFaint,
                                  fontFamily: FONT.mono,
                                  letterSpacing: 0.5,
                                  padding: "2px 6px",
                                  border: `1px solid ${C.border}`,
                                  borderRadius: 4,
                                  textTransform: "uppercase",
                                }}
                              >
                                Legacy
                              </span>
                            )}
                          </strong>
                          <span
                            style={{
                              fontSize: 11,
                              color: C.textFaint,
                              fontFamily: FONT.mono,
                            }}
                          >
                            {k}
                          </span>
                        </div>
                        <p
                          style={{
                            color: C.textDim,
                            fontSize: 12,
                            margin: "4px 0 8px 0",
                          }}
                        >
                          <em>Wann:</em> {v.when}
                        </p>
                        {v.precondition && (
                          <Note color={C.gold}>
                            <strong>Voraussetzung:</strong>{" "}
                            {Array.isArray(v.precondition) ? (
                              <ul
                                style={{
                                  margin: "4px 0 0 16px",
                                  padding: 0,
                                }}
                              >
                                {v.precondition.map((p, i) => (
                                  <li key={i} style={{ fontSize: 12 }}>
                                    {p}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              v.precondition
                            )}
                          </Note>
                        )}
                        {v.endpointUrl && (
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 12,
                              fontSize: 11,
                              color: C.textDim,
                              marginBottom: 6,
                              fontFamily: FONT.mono,
                              overflowWrap: "anywhere",
                              wordBreak: "break-all",
                            }}
                          >
                            <span style={{ minWidth: 0 }}>
                              endpoint:{" "}
                              <code style={{ color: C.gold }}>
                                {v.endpointUrl}
                              </code>
                            </span>
                            {v.healthUrl && (
                              <span style={{ minWidth: 0 }}>
                                health:{" "}
                                <code style={{ color: C.gold }}>
                                  {v.healthUrl}
                                </code>
                              </span>
                            )}
                          </div>
                        )}
                        {v.instructions && (
                          <Note color={C.gold}>{v.instructions}</Note>
                        )}
                        {v.steps && v.steps.length > 0 && (
                          <div style={{ marginBottom: 8 }}>
                            <p
                              style={{
                                color: C.textDim,
                                fontSize: 12,
                                margin: "0 0 4px 0",
                                fontWeight: 600,
                              }}
                            >
                              So geht's:
                            </p>
                            <ol
                              style={{
                                margin: "0 0 0 16px",
                                padding: 0,
                                color: C.textDim,
                                fontSize: 13,
                              }}
                            >
                              {v.steps.map((step, i) => (
                                <li key={i} style={{ marginBottom: 4 }}>
                                  {step}
                                </li>
                              ))}
                            </ol>
                          </div>
                        )}
                        {v.consentPassword && (
                          <CodeBlock
                            label={`Login-Passwort (aus ${v.consentPasswordSource ?? "env"})`}
                            code={v.consentPassword}
                            onCopy={(l, c) => copy(l, c)}
                            copiedLabel={copied}
                          />
                        )}
                        {v.snippet && (
                          <CodeBlock
                            label={`${v.title} — claude_desktop_config.json`}
                            code={withToken(JSON.stringify(v.snippet, null, 2))}
                            onCopy={(l, c) => copy(l, c)}
                            copiedLabel={copied}
                          />
                        )}
                        {v.extraSnippets?.map((sub, i) => (
                          <CodeBlock
                            key={`${k}-extra-${i}`}
                            label={`${v.title} — ${sub.label}`}
                            code={withToken(sub.code)}
                            onCopy={(l, c) => copy(l, c)}
                            copiedLabel={copied}
                          />
                        ))}
                        {v.authNote && (
                          <Note color={C.textDim}>{v.authNote}</Note>
                        )}
                      </div>
                    );
                  })}
                </>
              ) : (
                // Legacy single-snippet fallback (old api shape)
                mcp.claudeDesktopConfigSnippet && (
                  <CodeBlock
                    label="claude_desktop_config.json"
                    code={JSON.stringify(
                      mcp.claudeDesktopConfigSnippet,
                      null,
                      2,
                    )}
                    onCopy={(l, c) => copy(l, c)}
                    copiedLabel={copied}
                  />
                )
              )}

              {mcp.scopesFile && (
                <Note color={C.textDim}>
                  <strong>Scopes-Datei:</strong>{" "}
                  <code style={{ color: C.text }}>{mcp.scopesFile}</code>
                  <br />
                  {mcp.scopesFileHint}
                </Note>
              )}

              <Note color={C.textDim}>
                <strong>Claude-Desktop-Config-Pfad:</strong>
                <br />
                macOS:{" "}
                <code style={{ color: C.text }}>
                  ~/Library/Application Support/Claude/claude_desktop_config.json
                </code>
                <br />
                Linux:{" "}
                <code style={{ color: C.text }}>
                  ~/.config/Claude/claude_desktop_config.json
                </code>
                <br />
                Nach Speichern Claude Desktop neu starten.
              </Note>
            </>
          ) : (
            <McpNotReadyBlock
              healthy={mcpHealthy}
              onRecheck={() => void probeMcpHealth()}
            />
          )}
        </Section>
      )}

      {/* ───── Tab: Voice ───── */}
      {tab === "voice" && (
        <VoiceTab
          voice={voice}
          setVoice={setVoice}
          voiceLoaded={voiceLoaded}
          customLang={voiceCustomLang}
          setCustomLang={setVoiceCustomLang}
          selfHostedConfigured={Boolean(
            runtime?.env?.whisperBaseUrl?.trim(),
          )}
          saveState={voiceSaveState}
          saveError={voiceSaveError}
          onSave={() => void saveVoiceSettings()}
        />
      )}

      {/* ───── Tab: Skills ───── */}
      {tab === "skills" && (
        <Section title="Skills in deinem Vault">
          {skills.length === 0 && (
            <p style={{ color: C.textDim, fontSize: 13, margin: 0 }}>
              Keine <code style={{ color: C.gold }}>type: skill</code>-Notes im
              Vault gefunden. Lege Skills unter{" "}
              <code style={{ color: C.gold }}>70_pai/skills/</code> an — dieser
              Tab spiegelt sie dann automatisch.
            </p>
          )}
          {skills.map((s) => {
            const invocation = `Sag zu Claude: run_skill ${s.skill_name}`;
            return (
              <div
                key={s.skill_name}
                style={{
                  padding: 14,
                  marginBottom: 12,
                  background: C.elevated,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "baseline", gap: 10 }}
                >
                  <strong
                    style={{
                      color: C.accent,
                      fontFamily: FONT.serif,
                      fontSize: 16,
                    }}
                  >
                    {s.title}
                  </strong>
                  <span
                    style={{
                      fontSize: 11,
                      color: C.textFaint,
                      fontFamily: FONT.mono,
                    }}
                  >
                    {s.skill_name}
                  </span>
                </div>
                <p
                  style={{
                    color: C.textDim,
                    fontSize: 13,
                    margin: "6px 0",
                  }}
                >
                  {s.description}
                </p>

                {s.allowed_tools.length > 0 && (
                  <code
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: C.textFaint,
                      fontFamily: FONT.mono,
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                    }}
                  >
                    tools: {s.allowed_tools.join(", ")}
                  </code>
                )}

                {/* "wie aufrufen" — adaptiert vom bisherigen Beispiel-Prompt-
                    Block (Copy-Button-UX bewahrt, AC#8). */}
                <div style={{ marginTop: 8 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 2,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        color: C.textDim,
                        fontFamily: FONT.mono,
                      }}
                    >
                      WIE AUFRUFEN
                    </span>
                    <button
                      onClick={() =>
                        copy(`invoke-${s.skill_name}`, invocation)
                      }
                      style={{
                        ...btn,
                        padding: "3px 7px",
                        fontSize: 10,
                      }}
                    >
                      <Copy size={10} />{" "}
                      {copied === `invoke-${s.skill_name}`
                        ? "kopiert"
                        : "kopieren"}
                    </button>
                  </div>
                  <code
                    style={{
                      display: "block",
                      padding: 8,
                      background: C.panel,
                      borderRadius: 4,
                      fontFamily: FONT.mono,
                      fontSize: 11,
                      color: C.text,
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                    }}
                  >
                    {invocation}
                  </code>
                </div>

                {s.path && (
                  <button
                    onClick={() => {
                      onClose();
                      onOpenNote?.(s.path!);
                    }}
                    disabled={!onOpenNote}
                    style={{
                      ...btn,
                      marginTop: 10,
                      padding: "5px 10px",
                      fontSize: 12,
                      cursor: onOpenNote ? "pointer" : "default",
                      opacity: onOpenNote ? 1 : 0.5,
                    }}
                  >
                    im Editor öffnen
                  </button>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {/* ───── Tab: Kurator ───── */}
      {tab === "kurator" && (
        <KuratorTab
          runs={kuratorRuns}
          state={kuratorState}
          error={kuratorError}
          triggerState={kuratorTriggerState}
          triggerNotice={kuratorTriggerNotice}
          bezuegeCount={kuratorBezuegeCount}
          isMobile={isMobile}
          onTrigger={() => void runKuratorRem()}
          onRefresh={() => {
            void loadKuratorRuns();
            void loadKuratorBezuege();
          }}
          onOpenBezuege={() => setKuratorReviewOpen(true)}
        />
      )}

      {/* Reused agent-review slide-over for the "Bezüge ansehen" action.
          We render our own instance (App.tsx owns a separate one we must not
          touch) and refresh the connection count whenever it reports back. */}
      <AgentReviewPanel
        open={kuratorReviewOpen}
        onClose={() => setKuratorReviewOpen(false)}
        onOpenNote={(id) => {
          setKuratorReviewOpen(false);
          onOpenNote?.(id);
        }}
        onCountChange={() => void loadKuratorBezuege()}
      />

      {/* ───── Tab: Wartung ───── */}
      {tab === "wartung" && (
        <>
          <Section title="Vault-Wartung">
            <p
              style={{
                color: C.textDim,
                fontSize: 13,
                margin: "0 0 12px 0",
              }}
            >
              Bestehende Notes ohne{" "}
              <code style={{ color: C.gold }}>id:</code>-ULID können nicht via
              AI-Prompt referenziert werden und tauchen nicht im MCP-
              <code>resolve_by_id</code> auf. Der Backfill-Pass fügt fehlende
              IDs hinzu — Inhalt bleibt unverändert, nur Frontmatter wird
              ergänzt.
            </p>

            {backfillStatus ? (
              <div
                style={{
                  padding: 10,
                  background: C.elevated,
                  borderRadius: 6,
                  marginBottom: 12,
                  fontSize: 13,
                  color: C.text,
                }}
              >
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <span>
                    <strong style={{ color: C.textDim }}>
                      Notes gesamt:
                    </strong>{" "}
                    {backfillStatus.totalNotes}
                  </span>
                  <span>
                    <strong style={{ color: C.textDim }}>Ohne ULID:</strong>{" "}
                    <span
                      style={{
                        color:
                          backfillStatus.withoutUlid > 0 ? C.gold : C.ok,
                      }}
                    >
                      {backfillStatus.withoutUlid}
                      {backfillStatus.scanLimited &&
                        "+ (gescannt: ersten 500)"}
                    </span>
                  </span>
                </div>
              </div>
            ) : (
              <p
                style={{
                  color: C.textDim,
                  fontSize: 12,
                  margin: "0 0 12px 0",
                }}
              >
                Status laden …
              </p>
            )}

            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={() => void runBackfill()}
                disabled={
                  backfillState === "running" ||
                  (backfillStatus !== null &&
                    backfillStatus.withoutUlid === 0)
                }
                style={btn}
              >
                {backfillState === "running" && (
                  <Loader2 size={14} className="sw-spin" />
                )}
                ULID-Backfill jetzt starten
                {backfillStatus && backfillStatus.withoutUlid > 0 && (
                  <span style={{ color: C.gold, marginLeft: 4 }}>
                    ({backfillStatus.withoutUlid} betroffen)
                  </span>
                )}
              </button>
              <button onClick={() => void loadBackfillStatus()} style={btn}>
                Status neu laden
              </button>
              {backfillState === "ok" && (
                <span style={{ color: C.ok, fontSize: 13 }}>
                  <Check size={14} /> Backfill abgeschlossen
                </span>
              )}
              {backfillState === "fail" && (
                <span style={{ color: C.err, fontSize: 13 }}>
                  <X size={14} /> {backfillError}
                </span>
              )}
            </div>

            <p
              style={{
                color: C.textFaint,
                fontSize: 12,
                marginTop: 8,
                marginBottom: 0,
              }}
            >
              Pro Run werden bis zu 50 Notes verarbeitet — bei größeren
              Vaults mehrmals klicken. Letzter Run:{" "}
              {backfillLastRun
                ? new Date(backfillLastRun).toLocaleString("de-DE")
                : "noch nie (manuell)"}
              .
            </p>
          </Section>

          <Section title="Suchindex (BM25)">
            <p
              style={{
                color: C.textDim,
                fontSize: 13,
                margin: "0 0 12px 0",
              }}
            >
              Der schnelle Tier-1-Suchindex (<code style={{ color: C.gold }}>
                note_search
              </code>
              ) wird nur beim Speichern/Anlegen/Verschieben einer Note
              befüllt. Notizen, die es vor dieser Funktion schon gab, sind
              daher nicht im Index — ihre Suche fällt auf den langsamen
              Fallback zurück. Der Reindex baut den Index einmalig aus allen
              Notes neu auf. Inhalt bleibt unverändert.
            </p>

            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={() => void runReindex()}
                disabled={reindexState === "running"}
                style={mobileBtn(btn, isMobile)}
              >
                {reindexState === "running" && (
                  <Loader2 size={14} className="sw-spin" />
                )}
                Suchindex neu aufbauen
              </button>
              {reindexState === "ok" && reindexResult && (
                <span style={{ color: C.ok, fontSize: 13 }}>
                  <Check size={14} /> {reindexResult.indexed} Notizen indexiert
                  {" "}({reindexResult.ms} ms)
                </span>
              )}
              {reindexState === "fail" && (
                <span style={{ color: C.err, fontSize: 13 }}>
                  <X size={14} /> {reindexError}
                </span>
              )}
            </div>

            <p
              style={{
                color: C.textFaint,
                fontSize: 12,
                marginTop: 8,
                marginBottom: 0,
              }}
            >
              Danach liefert die Suche auch für ältere Notes sofort
              Ergebnisse. Den Füllstand zeigt der Diagnose-Tab unter{" "}
              <em>„note_search befüllt"</em>.
            </p>
          </Section>

          <Section title="Runtime">
            <KV
              label="Vault-Dir (lokal)"
              value={settings.runtime.vaultDir}
              isMobile={isMobile}
            />
            <KV
              label="DATABASE_URL"
              value={
                runtime?.env.databaseHost ?? settings.runtime.databaseUrl
              }
              isMobile={isMobile}
            />
            <KV
              label="OLLAMA_HOST"
              value={
                runtime?.env.ollamaHost ?? settings.runtime.ollamaHost
              }
              isMobile={isMobile}
            />
            {runtime?.env.mcpPublicUrl && (
              <KV
                label="MCP_PUBLIC_URL"
                value={runtime.env.mcpPublicUrl}
                isMobile={isMobile}
              />
            )}
          </Section>
        </>
      )}

      {/* ───── Tab: Diagnose ───── */}
      {tab === "diagnose" && (
        <DiagnoseTab
          diagnostics={diagnostics}
          state={diagState}
          error={diagError}
          isMobile={isMobile}
          onRun={() => void runDiagnostics()}
        />
      )}

      {/* ───── Tab: Logs ───── */}
      {tab === "logs" && (
        <LogsTab
          logs={logs}
          state={logsState}
          error={logsError}
          level={logLevel}
          service={logService}
          isMobile={isMobile}
          onLevelChange={(lvl) => {
            setLogLevel(lvl);
            // Level filter is server-side → re-fetch on change.
            void (async () => {
              setLogsState("loading");
              setLogsError(undefined);
              try {
                const result = await api.getLogs({
                  limit: DEFAULT_LOG_LIMIT,
                  ...(lvl !== "all" ? { level: lvl } : {}),
                });
                setLogs(result.logs);
                setLogsState("ok");
              } catch (err) {
                setLogsState("fail");
                setLogsError(
                  err instanceof Error ? err.message : String(err),
                );
              }
            })();
          }}
          onServiceChange={setLogService}
          onRefresh={() => void loadLogs()}
        />
      )}
    </div>
  );
}

/**
 * Returns the variant with Remote-HTTP URLs overridden by the runtime
 * payload when available. Local variants (a_local_stdio, b_npx) pass
 * through untouched.
 *
 * Two HTTP shapes are supported:
 *   - native HTTP (`c_native_http`): snippet.mcpServers[name].url = "<URL>"
 *   - mcp-remote bridge (`d_mcp_remote_legacy`):
 *     snippet.mcpServers[name].args = ["-y","mcp-remote","<URL>", …]
 *
 * extraSnippets (e.g. the `claude mcp add` CLI form) also get their URLs
 * rewritten via a regex pass so the copyable command matches the displayed
 * endpoint.
 */
function applyRuntimeOverrides(
  variant: McpVariant,
  key:
    | "a_local_stdio"
    | "b_npx"
    | "c_native_http"
    | "d_mcp_remote_legacy"
    | "e_claude_ai_oauth",
  runtime: RuntimeInfo | null,
): McpVariant {
  // e_claude_ai_oauth has no snippet to patch — just pass through with updated URLs.
  if (key === "e_claude_ai_oauth") {
    const publicUrl = runtime?.env.mcpPublicUrl?.trim();
    if (!publicUrl) return variant;
    const healthUrl = publicUrl.endsWith("/")
      ? `${publicUrl}health`
      : `${publicUrl}/health`;
    return { ...variant, endpointUrl: publicUrl, healthUrl };
  }
  if (key !== "c_native_http" && key !== "d_mcp_remote_legacy") return variant;
  const publicUrl = runtime?.env.mcpPublicUrl?.trim();
  if (!publicUrl) return variant;

  // mcp-remote convention: health endpoint = endpoint + "/health"
  const healthUrl = publicUrl.endsWith("/")
    ? `${publicUrl}health`
    : `${publicUrl}/health`;

  // Patch the snippet so the copyable JSON points at the public URL too.
  // snippet is required for c_native_http / d_mcp_remote_legacy — guard for type safety.
  if (!variant.snippet) return { ...variant, endpointUrl: publicUrl, healthUrl };
  const patchedSnippet = JSON.parse(JSON.stringify(variant.snippet)) as Record<
    string,
    unknown
  >;
  try {
    const servers = (patchedSnippet as { mcpServers?: Record<string, unknown> })
      .mcpServers;
    if (servers) {
      for (const name of Object.keys(servers)) {
        const entry = servers[name] as
          | { args?: unknown[]; url?: unknown }
          | undefined;
        if (!entry) continue;

        // Native HTTP shape: { type: "http", url: "<URL>", headers: {...} }
        if (typeof entry.url === "string" && /^https?:\/\//.test(entry.url)) {
          entry.url = publicUrl;
        }

        // mcp-remote shape: args = ["-y","mcp-remote","<URL>","--header", …]
        if (Array.isArray(entry.args)) {
          for (let i = 0; i < entry.args.length; i++) {
            const a = entry.args[i];
            if (typeof a === "string" && /^https?:\/\//.test(a)) {
              entry.args[i] = publicUrl;
              break;
            }
          }
        }
      }
    }
  } catch {
    // If the snippet shape ever drifts, leave it untouched rather than crash.
  }

  // Rewrite any URL occurrences in extraSnippets (e.g. the CLI command).
  const patchedExtras = variant.extraSnippets?.map((sub) => ({
    ...sub,
    code: sub.code.replace(/https?:\/\/[^\s"']+/g, publicUrl),
  }));

  return {
    ...variant,
    endpointUrl: publicUrl,
    healthUrl,
    snippet: patchedSnippet,
    ...(patchedExtras ? { extraSnippets: patchedExtras } : {}),
  };
}

/**
 * Prominent Vault-ID display for the MCP section. Coolify deployments
 * crash-loop the `lokyy-mcp` container until the operator copies this ID
 * into the env file and restarts the service, so we surface it loudly.
 *
 * Status indicator (Bug-fix #2): no longer reads `mcp.available` — that
 * flag is hardcoded `true` on the backend. Instead consumes the live
 * `mcpHealthy` probe state from the parent.
 */
function VaultIdCard({
  vaultId,
  mcpHealthy,
  mcpHealthCheckedAt,
  mcpPublicUrl,
  onCopy,
  onRecheck,
  copiedLabel,
}: {
  vaultId: string | null;
  mcpHealthy: boolean | null;
  mcpHealthCheckedAt: string | null;
  mcpPublicUrl: string | undefined;
  onCopy: () => void;
  onRecheck: () => void;
  copiedLabel: string | null;
}) {
  const hasId = Boolean(vaultId);
  // Border colour follows MCP health, falling back to the vault-id-present
  // signal so a brand-new install (no probe yet) doesn't look broken.
  const borderColor =
    mcpHealthy === false ? C.err : hasId ? C.accent : C.gold;
  return (
    <div
      style={{
        marginBottom: 18,
        padding: 14,
        background: C.elevated,
        border: `2px solid ${borderColor}`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
          fontFamily: FONT.serif,
          fontSize: 15,
          color: C.text,
        }}
      >
        <span aria-hidden style={{ fontSize: 18 }}>
          🆔
        </span>
        <strong>Vault-ID für MCP-Konfiguration</strong>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <code
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            padding: "8px 12px",
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            fontFamily: FONT.mono,
            fontSize: 14,
            color: hasId ? C.gold : C.textFaint,
            letterSpacing: 0.5,
            wordBreak: "break-all",
          }}
        >
          {vaultId ?? "— noch keine Vault konfiguriert —"}
        </code>
        <button
          onClick={onCopy}
          disabled={!hasId}
          style={{
            ...btn,
            opacity: hasId ? 1 : 0.5,
            cursor: hasId ? "pointer" : "not-allowed",
          }}
        >
          <Copy size={12} />
          {copiedLabel === "vault-id" ? "kopiert" : "Copy"}
        </button>
      </div>

      <p style={{ color: C.textDim, fontSize: 12, margin: "0 0 8px 0" }}>
        Trage diese ID in deinem Container-Orchestrator (Coolify /
        docker-compose) als{" "}
        <code style={{ color: C.text }}>LOKYY_VAULT_ID</code> ein und starte
        den <code style={{ color: C.text }}>lokyy-mcp</code>-Service neu.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 12,
          fontFamily: FONT.mono,
          flexWrap: "wrap",
        }}
      >
        <span>Status:</span>
        {mcpHealthy === true && (
          <span style={{ color: C.ok }}>
            <Check size={11} /> MCP läuft (/health 2xx)
          </span>
        )}
        {mcpHealthy === false && (
          <span style={{ color: C.err }}>
            <X size={11} /> MCP nicht erreichbar — Container down,
            LOKYY_VAULT_ID prüfen
          </span>
        )}
        {mcpHealthy === null && (
          <span style={{ color: C.textDim }}>
            <Loader2 size={11} /> Status wird geprüft …
          </span>
        )}
        {mcpPublicUrl && (
          <span style={{ color: C.textFaint }}>
            via{" "}
            <code style={{ color: C.textFaint }}>
              {mcpPublicUrl}
              {mcpPublicUrl.endsWith("/") ? "" : "/"}health
            </code>
          </span>
        )}
        {mcpHealthCheckedAt && (
          <span style={{ color: C.textFaint }}>
            zuletzt {new Date(mcpHealthCheckedAt).toLocaleTimeString("de-DE")}
          </span>
        )}
        <button
          onClick={onRecheck}
          style={{
            ...btn,
            padding: "3px 8px",
            fontSize: 11,
          }}
        >
          <RefreshCw size={11} /> erneut prüfen
        </button>
      </div>
    </div>
  );
}

/**
 * Bug-fix #3 guidance block. Renders inside the MCP tab when the live
 * health probe says the service is down OR still unknown. Suppresses the
 * copyable claude_desktop_config snippets entirely so an operator can't
 * accidentally distribute a half-broken config that points at a service
 * which won't accept connections.
 */
function McpNotReadyBlock({
  healthy,
  onRecheck,
}: {
  healthy: boolean | null;
  onRecheck: () => void;
}) {
  return (
    <div
      style={{
        padding: 16,
        background: C.elevated,
        border: `1px dashed ${healthy === false ? C.err : C.gold}`,
        borderRadius: 8,
        marginBottom: 18,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
          fontFamily: FONT.serif,
          fontSize: 15,
          color: C.text,
        }}
      >
        <span aria-hidden style={{ fontSize: 18 }}>
          ⏳
        </span>
        <strong>MCP-Service noch nicht aktiv</strong>
      </div>
      <p
        style={{
          color: C.textDim,
          fontSize: 13,
          margin: "0 0 10px 0",
          lineHeight: 1.5,
        }}
      >
        Trage die <strong>Vault-ID</strong> oben in deinem
        Container-Orchestrator als{" "}
        <code style={{ color: C.text }}>LOKYY_VAULT_ID</code> ein und starte{" "}
        <code style={{ color: C.text }}>lokyy-mcp</code> neu. Ein
        Backend-Refactor ist parallel im Gange, der diesen Schritt überflüssig
        macht — sobald der live ist, wird die Vault-ID beim Service-Start
        automatisch aus der DB geladen.
      </p>
      <p
        style={{
          color: C.textFaint,
          fontSize: 12,
          margin: "0 0 12px 0",
        }}
      >
        Die Konfigurations-Snippets für Claude Desktop (stdio / npx /
        Remote HTTP) erscheinen automatisch, sobald das{" "}
        <code>/health</code>-Endpoint 200 zurückgibt.
      </p>
      <button onClick={onRecheck} style={btn}>
        <RefreshCw size={13} /> Status erneut prüfen
      </button>
    </div>
  );
}

/**
 * One-line connection-status indicator for the Vault tab.
 *
 *   ✓ OAuth-Verbindung aktiv (Login: <user>)   – green   (probe ok)
 *   ⚠ Token abgelaufen — Forgejo neu verbinden – yellow  (probe 401)
 *   — nicht verbunden                          – gray    (no token)
 *   ⚠ Verbindung ungeprüft (Netzwerkfehler)    – gray    (network/timeout)
 *
 * The Reconnect button is rendered inline when the state is "expired"
 * or "none" so the operator doesn't have to scroll.
 */
function ForgejoConnectionStatus({
  state,
  forgejoUser,
  onReconnect,
  onRecheck,
}: {
  state: "loading" | "connected" | "expired" | "none" | "network";
  forgejoUser: string | null;
  onReconnect: () => void;
  onRecheck: () => void;
}) {
  let icon: React.ReactNode;
  let label: string;
  let color: string;
  let showReconnect = false;
  switch (state) {
    case "connected":
      icon = <Check size={12} />;
      label = forgejoUser
        ? `OAuth-Verbindung aktiv (Login: ${forgejoUser})`
        : "OAuth-Verbindung aktiv";
      color = C.ok;
      break;
    case "expired":
      icon = <X size={12} />;
      label = "Token abgelaufen";
      color = C.gold;
      showReconnect = true;
      break;
    case "none":
      icon = <span aria-hidden>—</span>;
      label = "nicht verbunden";
      color = C.textDim;
      showReconnect = true;
      break;
    case "network":
      icon = <X size={12} />;
      label = "Verbindung ungeprüft (Netzwerkfehler)";
      color = C.textDim;
      break;
    case "loading":
    default:
      icon = <Loader2 size={12} className="sw-spin" />;
      label = "Verbindung wird geprüft …";
      color = C.textDim;
      break;
  }
  return (
    <div
      style={{
        marginBottom: 14,
        padding: "8px 12px",
        background: C.elevated,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 13,
        flexWrap: "wrap",
      }}
    >
      <span style={{ color, display: "inline-flex", alignItems: "center", gap: 6 }}>
        {icon}
        {label}
      </span>
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
        {showReconnect && (
          <button
            onClick={onReconnect}
            style={{
              ...btn,
              padding: "4px 10px",
              fontSize: 12,
              borderColor: C.gold,
              color: C.gold,
            }}
          >
            <RefreshCw size={11} /> Forgejo neu verbinden
          </button>
        )}
        <button
          onClick={onRecheck}
          style={{ ...btn, padding: "4px 10px", fontSize: 12 }}
          title="Probe-Endpoint /api/forgejo/probe erneut aufrufen."
        >
          <RefreshCw size={11} /> Status erneut prüfen
        </button>
      </span>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Kurator-Tab — sleep-agent status, run history, manual trigger, connections.
 *
 * The "Kurator" is the background consolidation agent (sleep-agent). This tab
 * surfaces:
 *   1. a plain-language status header (scheduler armed/idle + last run),
 *   2. the recent run history (newest-first, with phase/status/duration),
 *   3. a "Vollständiger Lauf (inkl. Bezüge)" button that triggers the REM
 *      phase — the only phase whose topic-synthesis pass produces connections,
 *   4. the count of found connections ("Bezüge") + a button that opens the
 *      reused AgentReviewPanel.
 * ────────────────────────────────────────────────────────────────────── */

const KURATOR_STATUS_META: Record<
  SleepStatus,
  { label: string; color: string }
> = {
  pending: { label: "wartend", color: C.textDim },
  running: { label: "läuft", color: C.gold },
  completed: { label: "fertig", color: C.ok },
  failed: { label: "fehlgeschlagen", color: C.err },
  cancelled: { label: "abgebrochen", color: C.textFaint },
};

/** Human label for a sleep phase. */
function kuratorPhaseLabel(phase: string): string {
  switch (phase) {
    case "rem":
      return "REM (Bezüge)";
    case "nrem":
      return "NREM (Wartung)";
    case "lint":
      return "Lint";
    case "dream":
      return "Dream";
    default:
      return phase;
  }
}

/** Format a run's wall-clock duration, or "—" while still running. */
function kuratorDuration(run: SleepRunItem): string {
  if (!run.finishedAt) return "läuft …";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

function StatusBadge({ status }: { status: SleepStatus }) {
  const meta = KURATOR_STATUS_META[status];
  return (
    <span
      style={{
        fontSize: 10.5,
        fontFamily: FONT.mono,
        color: meta.color,
        border: `1px solid ${meta.color}`,
        borderRadius: 4,
        padding: "1px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

function KuratorTab({
  runs,
  state,
  error,
  triggerState,
  triggerNotice,
  bezuegeCount,
  isMobile,
  onTrigger,
  onRefresh,
  onOpenBezuege,
}: {
  runs: SleepRunItem[] | null;
  state: "idle" | "loading" | "ok" | "fail";
  error?: string;
  triggerState: "idle" | "running" | "done" | "busy";
  triggerNotice?: string;
  bezuegeCount: number | null;
  isMobile: boolean;
  onTrigger: () => void;
  onRefresh: () => void;
  onOpenBezuege: () => void;
}) {
  const lastRun = runs && runs.length > 0 ? runs[0] : null;
  const isRunning =
    triggerState === "running" ||
    (lastRun?.status === "running");

  // Plain-language status line, e.g.
  // "Läuft scharf · zuletzt 29.05. 14:41 · 91 Notizen verarbeitet".
  const statusLine = (() => {
    if (!lastRun) return "Noch kein Lauf aufgezeichnet.";
    const when = new Date(lastRun.startedAt).toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const statusWord = KURATOR_STATUS_META[lastRun.status].label;
    return `Zuletzt ${when} · ${kuratorPhaseLabel(lastRun.phase)} · ${statusWord} · ${lastRun.notesProcessed} Notizen verarbeitet`;
  })();

  return (
    <>
      <Section title="Kurator-Status">
        <p
          style={{
            color: C.textDim,
            fontSize: 13,
            margin: "0 0 12px 0",
          }}
        >
          Der Kurator ist der Hintergrund-Agent, der deine Notizen im Schlaf
          aufräumt und Querverbindungen („Bezüge") zwischen ihnen findet. Er
          läuft automatisch (Leerlauf + nachts) — hier siehst du den Status und
          kannst ihn manuell anstoßen.
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 12,
            background: C.elevated,
            borderRadius: 6,
            fontSize: 13,
            color: C.text,
            flexWrap: "wrap",
          }}
        >
          <Clock
            size={16}
            style={{ color: isRunning ? C.gold : C.ok, flexShrink: 0 }}
          />
          <span style={{ fontWeight: 600 }}>
            {isRunning ? "Läuft gerade" : "Läuft scharf (Scheduler aktiv)"}
          </span>
          <span style={{ color: C.textDim }}>·</span>
          <span style={{ color: C.textDim }}>{statusLine}</span>
        </div>

        {error && (
          <p style={{ color: C.err, fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            <X size={13} /> {error}
          </p>
        )}
      </Section>

      <Section title="Bezüge (gefundene Querverbindungen)">
        <p
          style={{
            color: C.textDim,
            fontSize: 13,
            margin: "0 0 12px 0",
          }}
        >
          Im REM-Lauf erzeugt der Kurator automatische Themen-Notizen, die
          mehrere bestehende Notizen verknüpfen. Diese liegen als Vorschlag im
          Review-Bereich und warten auf deine Freigabe.
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 14px",
              background: C.elevated,
              borderRadius: 6,
            }}
          >
            <Network size={16} style={{ color: "#A855F7" }} />
            <span style={{ fontSize: 22, fontWeight: 700, color: C.text }}>
              {bezuegeCount === null ? "—" : bezuegeCount}
            </span>
            <span style={{ fontSize: 13, color: C.textDim }}>
              offene Bezüge
            </span>
          </div>
          <button
            onClick={onOpenBezuege}
            style={mobileBtn(btn, isMobile)}
          >
            <Network size={14} /> Bezüge ansehen
          </button>
        </div>
      </Section>

      <Section title="Manueller Lauf">
        <p
          style={{
            color: C.textDim,
            fontSize: 13,
            margin: "0 0 12px 0",
          }}
        >
          Stößt den REM-Lauf an — die Phase, in der die Themen-Synthese läuft
          und neue Bezüge entstehen. Danach werden die Lauf-Historie und der
          Bezüge-Zähler aktualisiert.
        </p>

        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button
            onClick={onTrigger}
            disabled={triggerState === "running"}
            style={mobileBtn(btn, isMobile)}
          >
            {triggerState === "running" ? (
              <Loader2 size={14} className="sw-spin" />
            ) : (
              <Brain size={14} />
            )}
            Vollständiger Lauf (inkl. Bezüge)
          </button>
          <button onClick={onRefresh} style={mobileBtn(btn, isMobile)}>
            <RefreshCw size={14} /> Aktualisieren
          </button>
          {triggerState === "done" && (
            <span style={{ color: C.ok, fontSize: 13 }}>
              <Check size={14} /> Lauf abgeschlossen
            </span>
          )}
          {triggerState === "busy" && (
            <span style={{ color: C.gold, fontSize: 13 }}>
              <AlertTriangle size={14} /> {triggerNotice}
            </span>
          )}
          {triggerState === "idle" && triggerNotice && (
            <span style={{ color: C.err, fontSize: 13 }}>
              <X size={14} /> {triggerNotice}
            </span>
          )}
        </div>
      </Section>

      <Section title="Lauf-Historie">
        {state === "loading" && runs === null ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: C.textDim,
              fontSize: 13,
            }}
          >
            <Loader2 size={14} className="sw-spin" /> lädt …
          </div>
        ) : state === "fail" ? (
          <p style={{ color: C.err, fontSize: 13, margin: 0 }}>
            <X size={14} /> {error ?? "Laden fehlgeschlagen"}
          </p>
        ) : runs && runs.length === 0 ? (
          <p style={{ color: C.textFaint, fontSize: 13, margin: 0 }}>
            Noch keine Läufe aufgezeichnet.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(runs ?? []).map((run) => (
              <div
                key={run.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: isMobile ? 8 : 14,
                  padding: "10px 12px",
                  background: C.elevated,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontFamily: FONT.mono,
                    fontSize: 11.5,
                    color: C.textDim,
                    whiteSpace: "nowrap",
                  }}
                >
                  {new Date(run.startedAt).toLocaleString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: C.text,
                    minWidth: 96,
                  }}
                >
                  {kuratorPhaseLabel(run.phase)}
                </span>
                <StatusBadge status={run.status} />
                <span
                  style={{
                    fontFamily: FONT.mono,
                    fontSize: 11.5,
                    color: C.textFaint,
                    whiteSpace: "nowrap",
                  }}
                >
                  {kuratorDuration(run)}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: C.textDim,
                    marginLeft: "auto",
                    whiteSpace: "nowrap",
                  }}
                >
                  {run.notesProcessed} Notizen
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  // Self-reads the breakpoint so every caller gets tighter mobile padding
  // for free without threading a prop through ~9 tabs. Desktop unchanged.
  const isMobile = useIsMobile();
  return (
    <section
      style={{
        marginBottom: isMobile ? 20 : 32,
        padding: isMobile ? 14 : 20,
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        // Keep section content from forcing horizontal page scroll.
        boxSizing: "border-box",
        maxWidth: "100%",
        overflowWrap: "anywhere",
      }}
    >
      <h2
        style={{ fontFamily: FONT.serif, fontSize: 18, margin: "0 0 14px 0" }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Single command line + copy button. Renders inside a service's remediation
 * block. `kind` labels whether this is the local or docker-compose variant.
 * The command is NEVER executed — copy-to-clipboard only.
 */
function CommandLine({
  copyKey,
  kind,
  command,
  onCopy,
  copiedLabel,
}: {
  copyKey: string;
  kind: "local" | "docker";
  command: string;
  onCopy: (label: string, text: string) => void;
  copiedLabel: string | null;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 6,
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: C.textFaint,
          fontFamily: FONT.mono,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          minWidth: 48,
        }}
      >
        {kind === "local" ? "lokal" : "server"}
      </span>
      <code
        style={{
          flex: "1 1 200px",
          minWidth: 0,
          padding: "5px 9px",
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 4,
          fontFamily: FONT.mono,
          fontSize: 12,
          color: C.gold,
          wordBreak: "break-all",
        }}
      >
        {command}
      </code>
      <button
        onClick={() => onCopy(copyKey, command)}
        style={{ ...btn, padding: "4px 8px", fontSize: 11 }}
      >
        <Copy size={11} /> {copiedLabel === copyKey ? "kopiert" : "Copy"}
      </button>
    </div>
  );
}

/**
 * System-tab status row: a colored dot + label + OK/FAIL + optional detail,
 * followed (only when `!ok`) by an actionable remediation block — the local
 * command, the docker-compose hint, and a one-line note — each with its own
 * copy button. Detection + guidance only; the app executes nothing.
 */
function ServiceStatusRow({
  service,
  label,
  ok,
  detail,
  onCopy,
  copiedLabel,
  isMobile,
}: {
  service: string;
  label: string;
  ok: boolean;
  detail?: string;
  onCopy: (label: string, text: string) => void;
  copiedLabel: string | null;
  isMobile?: boolean;
}) {
  const remediation = SERVICE_REMEDIATION[service];
  return (
    <div
      style={{
        padding: "8px 12px",
        background: C.elevated,
        borderRadius: 6,
        marginBottom: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: isMobile ? "flex-start" : "center",
          gap: isMobile ? 8 : 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            marginTop: isMobile ? 5 : 0,
            borderRadius: 999,
            background: ok ? C.ok : C.err,
            flex: "0 0 auto",
          }}
        />
        {/* Fixed label width on desktop for column alignment; on mobile drop
            the fixed width so the label + status share one line and the
            detail can wrap onto the next without clipping. */}
        <strong style={{ width: isMobile ? "auto" : 90 }}>{label}</strong>
        <span style={{ color: ok ? C.ok : C.err, fontSize: 13 }}>
          {ok ? "OK" : "FAIL"}
        </span>
        {detail && (
          <span
            style={{
              color: C.textDim,
              fontSize: 12,
              // Desktop pushes detail to the right; mobile lets it flow to a
              // full-width new line so long values wrap instead of overflow.
              marginLeft: isMobile ? 0 : "auto",
              flexBasis: isMobile ? "100%" : "auto",
              overflowWrap: "anywhere",
              wordBreak: "break-word",
              maxWidth: "100%",
            }}
          >
            {detail}
          </span>
        )}
      </div>

      {!ok && remediation && (
        <div
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: `1px solid ${C.border}`,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: C.textDim,
              fontFamily: FONT.mono,
            }}
          >
            Nächster Schritt:
          </div>
          {remediation.local && (
            <CommandLine
              copyKey={`fix-${service}-local`}
              kind="local"
              command={remediation.local}
              onCopy={onCopy}
              copiedLabel={copiedLabel}
            />
          )}
          {remediation.docker && (
            <CommandLine
              copyKey={`fix-${service}-docker`}
              kind="docker"
              command={remediation.docker}
              onCopy={onCopy}
              copiedLabel={copiedLabel}
            />
          )}
          {remediation.note && (
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                color: C.textFaint,
              }}
            >
              {remediation.note}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  readOnly,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <div
        style={{
          fontSize: 11,
          color: C.textDim,
          marginBottom: 4,
          fontFamily: FONT.mono,
        }}
      >
        {label}
      </div>
      <input
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        readOnly={readOnly}
        style={{
          width: "100%",
          padding: "8px 10px",
          background: C.elevated,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          color: C.text,
          fontFamily: FONT.mono,
          fontSize: 13,
          outline: "none",
        }}
      />
    </label>
  );
}

function CodeBlock({
  label,
  code,
  onCopy,
  copiedLabel,
}: {
  label: string;
  code: string;
  onCopy: (l: string, c: string) => void;
  copiedLabel: string | null;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <span
          style={{ fontSize: 11, color: C.textDim, fontFamily: FONT.mono }}
        >
          {label}
        </span>
        <button
          onClick={() => onCopy(label, code)}
          style={{ ...btn, padding: "4px 8px", fontSize: 11 }}
        >
          <Copy size={12} /> {copiedLabel === label ? "kopiert" : "kopieren"}
        </button>
      </div>
      <pre
        style={{
          padding: 12,
          background: C.elevated,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          fontFamily: FONT.mono,
          fontSize: 12,
          color: C.text,
          margin: 0,
          overflow: "auto",
          maxHeight: 220,
        }}
      >
        {code}
      </pre>
    </div>
  );
}

function Note({
  color,
  children,
}: {
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: 10,
        background: C.elevated,
        borderRadius: 6,
        color,
        fontSize: 13,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function KV({
  label,
  value,
  isMobile,
}: {
  label: string;
  value: string;
  isMobile?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        // Stack label over value on mobile so long DATABASE_URL / MCP URLs
        // get the full row width and wrap instead of pushing the page wide.
        flexDirection: isMobile ? "column" : "row",
        gap: isMobile ? 2 : 12,
        fontSize: 13,
        marginBottom: isMobile ? 10 : 4,
      }}
    >
      <span
        style={{
          width: isMobile ? "auto" : 160,
          flex: isMobile ? "0 0 auto" : undefined,
          color: C.textDim,
          fontFamily: FONT.mono,
          fontSize: 11,
        }}
      >
        {label}
      </span>
      <code
        style={{
          color: C.text,
          fontFamily: FONT.mono,
          fontSize: 12,
          minWidth: 0,
          overflowWrap: "anywhere",
          wordBreak: "break-all",
        }}
      >
        {value}
      </code>
    </div>
  );
}

/**
 * Pure renderer for voice-note title patterns. Supports two token
 * conventions side-by-side:
 *
 *   - Composite literal: `{YYYY-MM-DD HH:mm}` → "2026-05-27 14:32"
 *   - Atomic tokens:     `{YYYY} {MM} {DD} {HH} {mm}`
 *   - Slug:              `{slug}` → kebab-case of first 5 words of transcript
 *   - First-words:       `{transcript-first-words}` → first 80 chars
 *
 * All time tokens use UTC so a vault synced across timezones doesn't
 * produce duplicate filenames. The `now` arg is injectable so the preview
 * stays stable during a single render pass.
 */
function renderTitlePattern(
  pattern: string,
  transcript: string,
  now: Date,
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const Y = String(now.getUTCFullYear());
  const M = pad(now.getUTCMonth() + 1);
  const D = pad(now.getUTCDate());
  const HH = pad(now.getUTCHours());
  const mm = pad(now.getUTCMinutes());
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const slug =
    words
      .slice(0, 5)
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "voice-note";
  const firstWords = transcript.trim().slice(0, 80);
  return pattern
    .replace(/\{YYYY-MM-DD HH:mm\}/g, `${Y}-${M}-${D} ${HH}:${mm}`)
    .replace(/\{YYYY-MM-DD\}/g, `${Y}-${M}-${D}`)
    .replace(/\{HH:mm\}/g, `${HH}:${mm}`)
    .replace(/\{YYYY\}/g, Y)
    .replace(/\{MM\}/g, M)
    .replace(/\{DD\}/g, D)
    .replace(/\{HH\}/g, HH)
    .replace(/\{mm\}/g, mm)
    .replace(/\{slug\}/g, slug)
    .replace(/\{transcript-first-words\}/g, firstWords);
}

/**
 * Compares two VoiceSettings shapes by value. Used to drive the Save
 * button's `disabled` state — we only PUT when something actually
 * changed. Cheaper than JSON.stringify and avoids key-order pitfalls.
 */
function voiceEq(a: VoiceSettings, b: VoiceSettings): boolean {
  return (
    a.mode === b.mode &&
    a.folder === b.folder &&
    a.titlePattern === b.titlePattern &&
    (a.language ?? null) === (b.language ?? null) &&
    a.aiTitle === b.aiTitle
  );
}

/**
 * Voice tab content. Pure presentation — the parent owns all state and
 * passes mutation callbacks down. `selfHostedConfigured = false` greys
 * out the "Whisper Self-Hosted" radio with a hint pointing at the
 * deploy doc.
 */
function VoiceTab({
  voice,
  setVoice,
  voiceLoaded,
  customLang,
  setCustomLang,
  selfHostedConfigured,
  saveState,
  saveError,
  onSave,
}: {
  voice: VoiceSettings;
  setVoice: (v: VoiceSettings) => void;
  voiceLoaded: VoiceSettings | null;
  customLang: string;
  setCustomLang: (s: string) => void;
  selfHostedConfigured: boolean;
  saveState: "idle" | "saving" | "ok" | "fail";
  saveError: string | undefined;
  onSave: () => void;
}) {
  // Stable "now" for the title-preview so it doesn't flicker on every
  // keystroke. Recomputed on each render — which is fine; the user only
  // perceives the seconds-resolution Mustache tokens (HH:mm) anyway.
  const now = new Date();
  const previewTranscript =
    "Beispieltranskript für die Vorschau dieser Notiz";
  const renderedTitle = renderTitlePattern(
    voice.titlePattern || "",
    previewTranscript,
    now,
  );

  const dirty = voiceLoaded === null ? false : !voiceEq(voice, voiceLoaded);

  // Dropdown options + a synthetic "custom" entry. We map `null`
  // (auto-detect) to the sentinel string "__auto__" because <select>
  // values must be strings; same trick for the custom-ISO branch.
  const selectedLangKey =
    voice.language === null
      ? "__auto__"
      : VOICE_LANGUAGES.some((l) => l.value === voice.language)
        ? voice.language
        : "__custom__";

  function handleLanguageChange(key: string) {
    if (key === "__auto__") {
      setVoice({ ...voice, language: null });
      return;
    }
    if (key === "__custom__") {
      setVoice({ ...voice, language: customLang.trim() || null });
      return;
    }
    setVoice({ ...voice, language: key });
  }

  const modes: {
    value: VoiceMode;
    icon: string;
    label: string;
    sub: string;
    disabled?: boolean;
    disabledHint?: string;
  }[] = [
    {
      value: "live",
      icon: "🎙",
      label: "Live (Browser, kostenlos)",
      sub: "Web-SpeechRecognition. Audio bleibt im Browser, kein API-Call. Qualität schwankt nach Browser/Sprache, am besten in Chrome auf Englisch oder Deutsch.",
    },
    {
      value: "whisper-cloud",
      icon: "☁️",
      label: "Whisper Cloud (OpenAI)",
      sub: "Beste Qualität & Mehrsprachigkeit. $0.006/min. Audio wird zu OpenAI gesendet — nicht für vertrauliche Inhalte.",
    },
    {
      value: "whisper-selfhosted",
      icon: "🧠",
      label: "Whisper Self-Hosted",
      sub: "Eigener whisper-asr-webservice-Container. Kostenlos, privat, lokale Latenz. Erfordert WHISPER_BASE_URL.",
      disabled: !selfHostedConfigured,
      disabledHint:
        "WHISPER_BASE_URL nicht gesetzt — folge DEPLOY-LEAN.md Phase 1.3 für Setup.",
    },
  ];

  return (
    <>
      <Section title="Voice-Capture — Standardwerte">
        <p
          style={{
            color: C.textDim,
            fontSize: 13,
            margin: "0 0 16px 0",
            lineHeight: 1.5,
          }}
        >
          Diese Defaults werden bei jedem neuen Voice-Recorder-Start
          übernommen. Pro Aufnahme kannst du sie weiterhin im Recorder
          überschreiben.
        </p>

        {/* ── Modus ───────────────────────────────────────────── */}
        <div style={{ marginBottom: 22 }}>
          <div
            style={{
              fontSize: 11,
              color: C.textDim,
              marginBottom: 8,
              fontFamily: FONT.mono,
              letterSpacing: 0.5,
            }}
          >
            DEFAULT-MODUS
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {modes.map((m) => {
              const checked = voice.mode === m.value;
              const isDisabled = Boolean(m.disabled);
              return (
                <label
                  key={m.value}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    padding: 12,
                    background: C.elevated,
                    border: `1px solid ${checked ? C.accent : C.border}`,
                    borderRadius: 6,
                    cursor: isDisabled ? "not-allowed" : "pointer",
                    opacity: isDisabled ? 0.5 : 1,
                  }}
                >
                  <input
                    type="radio"
                    name="voice-mode"
                    value={m.value}
                    checked={checked}
                    disabled={isDisabled}
                    onChange={() =>
                      !isDisabled && setVoice({ ...voice, mode: m.value })
                    }
                    style={{ marginTop: 3 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        color: C.text,
                        marginBottom: 2,
                      }}
                    >
                      <span aria-hidden style={{ marginRight: 6 }}>
                        {m.icon}
                      </span>
                      {m.label}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: C.textFaint,
                        lineHeight: 1.4,
                      }}
                    >
                      {m.sub}
                    </div>
                    {isDisabled && m.disabledHint && (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 11,
                          color: C.gold,
                          fontFamily: FONT.mono,
                        }}
                      >
                        ⚠ {m.disabledHint}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* ── Folder ──────────────────────────────────────────── */}
        <div style={{ marginBottom: 18 }}>
          <Field
            label="Standard-Ordner"
            value={voice.folder}
            onChange={(v) => setVoice({ ...voice, folder: v })}
          />
          <div
            style={{
              fontSize: 11,
              color: C.textFaint,
              marginTop: -6,
              marginBottom: 8,
            }}
          >
            Muss mit einem Vault-Root beginnen (z.B.{" "}
            <code style={{ color: C.textDim }}>30_captures</code>,{" "}
            <code style={{ color: C.textDim }}>20_notes</code>,{" "}
            <code style={{ color: C.textDim }}>70_pai/captures</code>, …).
          </div>
        </div>

        {/* ── Title pattern ───────────────────────────────────── */}
        <div style={{ marginBottom: 18 }}>
          <Field
            label="Titel-Pattern"
            value={voice.titlePattern}
            onChange={(v) => setVoice({ ...voice, titlePattern: v })}
          />
          <div
            style={{
              padding: "8px 10px",
              background: C.elevated,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              marginBottom: 8,
              fontSize: 12,
            }}
          >
            <span style={{ color: C.textDim, marginRight: 6 }}>
              Vorschau:
            </span>
            <code
              style={{
                color: C.gold,
                fontFamily: FONT.mono,
                fontSize: 12,
              }}
            >
              {renderedTitle || "(leer)"}
            </code>
          </div>
          <pre
            style={{
              padding: 8,
              background: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              fontFamily: FONT.mono,
              fontSize: 11,
              color: C.textDim,
              margin: 0,
              whiteSpace: "pre-wrap",
            }}
          >
{`{YYYY} {MM} {DD} {HH} {mm}  → Datum/Zeit (UTC)
{slug}                       → kebab-case der ersten 5 Wörter
{transcript-first-words}     → erste 80 Zeichen`}
          </pre>
        </div>

        {/* ── Language ────────────────────────────────────────── */}
        <div style={{ marginBottom: 18 }}>
          <div
            style={{
              fontSize: 11,
              color: C.textDim,
              marginBottom: 4,
              fontFamily: FONT.mono,
            }}
          >
            STANDARD-SPRACHE
          </div>
          <select
            value={selectedLangKey}
            onChange={(e) => handleLanguageChange(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 10px",
              background: C.elevated,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              color: C.text,
              fontFamily: FONT.mono,
              fontSize: 13,
              outline: "none",
            }}
          >
            {VOICE_LANGUAGES.map((l) => (
              <option
                key={l.value ?? "__auto__"}
                value={l.value ?? "__auto__"}
              >
                {l.label}
              </option>
            ))}
            <option value="__custom__">Andere (ISO 639-1)</option>
          </select>
          {selectedLangKey === "__custom__" && (
            <input
              type="text"
              value={customLang}
              placeholder="z.B. pt, ja, nl"
              onChange={(e) => {
                const v = e.target.value;
                setCustomLang(v);
                setVoice({ ...voice, language: v.trim() || null });
              }}
              style={{
                width: "100%",
                marginTop: 8,
                padding: "8px 10px",
                background: C.elevated,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                color: C.text,
                fontFamily: FONT.mono,
                fontSize: 13,
                outline: "none",
              }}
            />
          )}
        </div>

        {/* ── AI title (opt-in) ───────────────────────────────── */}
        <div style={{ marginBottom: 18 }}>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={voice.aiTitle}
              onChange={(e) =>
                setVoice({ ...voice, aiTitle: e.target.checked })
              }
              style={{ marginTop: 2, cursor: "pointer" }}
            />
            <span>
              <span style={{ fontSize: 13, color: C.text }}>
                Notiz-Titel per KI aus dem Transkript generieren
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: 11,
                  color: C.textFaint,
                  marginTop: 2,
                }}
              >
                Wenn aktiv und kein eigener Titel eingegeben wurde, schlägt
                das konfigurierte KI-Modell beim Anlegen einer Sprachnotiz
                einen kurzen Titel aus dem Transkript vor. Bei Fehlern fällt
                der Titel auf das Zeitstempel-Muster zurück. Standardmäßig
                aus.
              </span>
            </span>
          </label>
        </div>

        {/* ── Save ────────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <button
            onClick={onSave}
            disabled={!dirty || saveState === "saving"}
            style={{
              ...btn,
              opacity: !dirty || saveState === "saving" ? 0.5 : 1,
              cursor:
                !dirty || saveState === "saving" ? "not-allowed" : "pointer",
            }}
          >
            {saveState === "saving" && (
              <Loader2 size={14} className="sw-spin" />
            )}
            Speichern
          </button>
          {saveState === "ok" && (
            <span style={{ color: C.ok, fontSize: 13 }}>
              <Check size={14} /> gespeichert
            </span>
          )}
          {saveState === "fail" && (
            <span style={{ color: C.err, fontSize: 13 }}>
              <X size={14} /> {saveError}
            </span>
          )}
        </div>
      </Section>
    </>
  );
}

/**
 * Compute the current UTC offset for an IANA zone via
 * `Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "longOffset" })`.
 * Returns the raw offset token (e.g. "GMT+01:00") or empty string when the
 * browser can't honour the request (invalid zone name).
 */
function tzOffsetString(timeZone: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const tn = parts.find((p) => p.type === "timeZoneName");
    if (!tn) return "";
    // Browsers emit "GMT+01:00" — normalise the prefix to "UTC" so the
    // display reads "Europe/Berlin (UTC+01:00)" as spec'd.
    return tn.value.replace(/^GMT/, "UTC");
  } catch {
    return "";
  }
}

/**
 * DST-aware long zone name, e.g. "Mitteleuropäische Sommerzeit". Falls
 * back to empty string when the browser can't produce it. Uses the user's
 * default locale via `undefined` so the label respects browser language.
 */
function tzLongName(timeZone: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone,
      timeZoneName: "long",
    }).formatToParts(at);
    const tn = parts.find((p) => p.type === "timeZoneName");
    return tn?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * "2026-05-27 09:12:34" in the supplied zone. Uses `en-CA` locale to
 * coerce the date portion into ISO-like YYYY-MM-DD ordering regardless of
 * the operator's browser locale; the time portion is forced 24h.
 */
function tzFormattedTime(timeZone: string, at: Date): string {
  try {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(at);
    return `${date} ${time}`;
  } catch {
    return "—";
  }
}

/**
 * Timezone configuration panel for the System tab. Pure presentation —
 * the parent owns all state (draft, saved snapshot, ticking clock,
 * options) and provides callbacks for auto-detect and save. The Save
 * button mirrors the Voice-tab UX: disabled while clean or saving,
 * success flashes for ~2.5s.
 */
function TimezonePanel({
  tzDraft,
  setTzDraft,
  tzSaved,
  tzNow,
  tzOptions,
  tzFallback,
  tzAutoDetected,
  onAutoDetect,
  saveState,
  saveError,
  onSave,
}: {
  tzDraft: string;
  setTzDraft: (v: string) => void;
  tzSaved: string | null;
  tzNow: Date;
  tzOptions: string[];
  tzFallback: boolean;
  tzAutoDetected: string | null;
  onAutoDetect: () => void;
  saveState: "idle" | "saving" | "ok" | "fail";
  saveError: string | undefined;
  onSave: () => void;
}) {
  const offset = tzOffsetString(tzDraft, tzNow);
  const longName = tzLongName(tzDraft, tzNow);
  const formattedTime = tzFormattedTime(tzDraft, tzNow);
  const dirty = tzSaved !== null && tzDraft !== tzSaved;
  const canSave = dirty && saveState !== "saving" && tzDraft.length > 0;

  return (
    <Section title="Zeitzone">
      {/* Aktuelle Zeitzone — prominent display */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 11,
            color: C.textDim,
            marginBottom: 4,
            fontFamily: FONT.mono,
            letterSpacing: 0.5,
          }}
        >
          AKTUELLE ZEITZONE
        </div>
        <code
          style={{
            display: "block",
            padding: "10px 12px",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            fontFamily: FONT.mono,
            fontSize: 15,
            color: C.gold,
            letterSpacing: 0.3,
            wordBreak: "break-all",
          }}
        >
          {tzDraft}
          {offset ? ` (${offset})` : ""}
        </code>
      </div>

      {/* Aktuelle Zeit in dieser Zone — live ticker */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 11,
            color: C.textDim,
            marginBottom: 4,
            fontFamily: FONT.mono,
            letterSpacing: 0.5,
          }}
        >
          AKTUELLE ZEIT IN DIESER ZONE
        </div>
        <code
          style={{
            display: "block",
            padding: "10px 12px",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            fontFamily: FONT.mono,
            fontSize: 14,
            color: C.text,
          }}
        >
          {formattedTime}
          {longName ? ` (${longName})` : ""}
        </code>
      </div>

      {/* Auto-erkennen */}
      <div style={{ marginBottom: 18 }}>
        <button onClick={onAutoDetect} style={btn}>
          <RefreshCw size={13} /> Auto-erkennen (Browser)
        </button>
        {tzAutoDetected && (
          <div
            style={{
              fontSize: 11,
              color: C.textFaint,
              marginTop: 6,
              fontFamily: FONT.mono,
            }}
          >
            Aus Browser übernommen: <code>{tzAutoDetected}</code>
          </div>
        )}
      </div>

      {/* Dropdown */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 11,
            color: C.textDim,
            marginBottom: 4,
            fontFamily: FONT.mono,
          }}
        >
          IANA-ZEITZONE
        </div>
        <select
          value={tzDraft}
          onChange={(e) => setTzDraft(e.target.value)}
          style={{
            width: "100%",
            padding: "8px 10px",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            color: C.text,
            fontFamily: FONT.mono,
            fontSize: 13,
            outline: "none",
          }}
        >
          {tzOptions.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        <div
          style={{
            fontSize: 11,
            color: C.textFaint,
            marginTop: 4,
          }}
        >
          {tzFallback
            ? "Limited list — Firefox-Browser (Browser unterstützt Intl.supportedValuesOf nicht; nutze einen aktuellen Chromium/WebKit für die volle Auswahl)."
            : "~600 Zonen (vollständige IANA-Liste aus dem Browser-Intl-API)."}
        </div>
      </div>

      {/* Save */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={onSave}
          disabled={!canSave}
          style={{
            ...btn,
            opacity: canSave ? 1 : 0.5,
            cursor: canSave ? "pointer" : "not-allowed",
          }}
        >
          {saveState === "saving" && (
            <Loader2 size={14} className="sw-spin" />
          )}
          Speichern
        </button>
        {saveState === "ok" && (
          <span style={{ color: C.ok, fontSize: 13 }}>
            <Check size={14} /> gespeichert
          </span>
        )}
        {saveState === "fail" && (
          <span style={{ color: C.err, fontSize: 13 }}>
            <X size={14} /> {saveError}
          </span>
        )}
      </div>

      {/* Below-panel note */}
      <div
        style={{
          marginTop: 14,
          padding: "10px 12px",
          background: C.elevated,
          border: `1px dashed ${C.border}`,
          borderRadius: 6,
          fontSize: 12,
          color: C.textDim,
          lineHeight: 1.5,
        }}
      >
        Backend speichert Zeitstempel immer in UTC. Diese Einstellung
        beeinflusst nur, wie Daten dir angezeigt werden — z.B.
        Voice-Notiz-Titel, Daily-Note-Pfade, Logs.
      </div>
    </Section>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Diagnose-Tab — per-service self-test suite.
 *
 * Renders `api.getDiagnostics()` checks grouped by `service` in a stable
 * order. Each group header shows an aggregate ("N/M ok"); each row carries
 * the check name, a status glyph (✓ / ✗ / ⚠), the detail text, and latency
 * when present. The `search` group is rendered first-class because its
 * Tier1 / Tier2 / Combined probes are how the operator diagnoses the live
 * empty-search bug — its detail strings carry the hit counts + degraded flag.
 * ────────────────────────────────────────────────────────────────────── */
function DiagnoseTab({
  diagnostics,
  state,
  error,
  isMobile,
  onRun,
}: {
  diagnostics: DiagnosticsResult | null;
  state: "idle" | "running" | "ok" | "fail";
  error: string | undefined;
  isMobile: boolean;
  onRun: () => void;
}) {
  // Group checks by service, then order the groups by the canonical list
  // (known services first, any unexpected service appended alphabetically).
  const grouped = useMemo(() => {
    const map = new Map<string, DiagnosticCheck[]>();
    for (const c of diagnostics?.checks ?? []) {
      const arr = map.get(c.service) ?? [];
      arr.push(c);
      map.set(c.service, arr);
    }
    const known = DIAGNOSTIC_SERVICE_ORDER.filter((s) => map.has(s.key));
    const extra = [...map.keys()]
      .filter((k) => !DIAGNOSTIC_SERVICE_ORDER.some((s) => s.key === k))
      .sort()
      .map((k) => ({ key: k, label: k }));
    return [...known, ...extra].map((g) => ({
      ...g,
      checks: map.get(g.key) ?? [],
    }));
  }, [diagnostics]);

  return (
    <Section title="Diagnose — Per-Service-Selbsttest">
      <p
        style={{
          color: C.textDim,
          fontSize: 13,
          margin: "0 0 14px 0",
          lineHeight: 1.5,
        }}
      >
        Führt einen Satz Health-Checks pro Dienst aus (Forgejo, Postgres,
        Ollama, Embeddings, Suche, Sleep-Agent, MCP, Git). Kein Coolify/SSH
        nötig. Die <strong>Suche</strong>-Gruppe zeigt die Tier-1/Tier-2/
        Combined-Treffer — so lässt sich eine leere Suche direkt eingrenzen.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <button
          onClick={onRun}
          disabled={state === "running"}
          style={{
            ...mobileBtn(btn, isMobile),
            background: C.accent,
            color: "#0B0E12",
            border: "none",
            opacity: state === "running" ? 0.6 : 1,
            cursor: state === "running" ? "not-allowed" : "pointer",
          }}
        >
          {state === "running" ? (
            <Loader2 size={14} className="sw-spin" />
          ) : (
            <PlayCircle size={14} />
          )}
          Tests ausführen
        </button>
        {diagnostics?.ranAt && (
          <span
            style={{ fontSize: 12, color: C.textFaint, fontFamily: FONT.mono }}
          >
            zuletzt {new Date(diagnostics.ranAt).toLocaleString("de-DE")}
          </span>
        )}
        {state === "fail" && (
          <span style={{ color: C.err, fontSize: 13 }}>
            <X size={14} /> {error ?? "Diagnostics-Endpoint nicht erreichbar"}
          </span>
        )}
      </div>

      {state === "running" && diagnostics === null && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: C.textDim,
            fontSize: 13,
          }}
        >
          <Loader2 size={14} className="sw-spin" /> Tests laufen …
        </div>
      )}

      {grouped.map((g) => {
        const total = g.checks.length;
        const okCount = g.checks.filter((c) => c.ok).length;
        const groupStatus: CheckStatus = g.checks.some(
          (c) => checkStatus(c) === "err",
        )
          ? "err"
          : g.checks.some((c) => checkStatus(c) === "warn")
            ? "warn"
            : "ok";
        return (
          <div
            key={g.key}
            style={{
              marginBottom: 14,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              overflow: "hidden",
              maxWidth: "100%",
            }}
          >
            {/* Group header with aggregate */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                background: C.elevated,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 999,
                  background: statusColor(groupStatus),
                  flex: "0 0 auto",
                }}
              />
              <strong
                style={{
                  fontFamily: FONT.serif,
                  fontSize: 14,
                  color: C.text,
                  minWidth: 0,
                  overflowWrap: "anywhere",
                }}
              >
                {g.label}
              </strong>
              <span
                style={{
                  marginLeft: isMobile ? 0 : "auto",
                  fontSize: 12,
                  fontFamily: FONT.mono,
                  color: statusColor(groupStatus),
                }}
              >
                {okCount}/{total} ok
              </span>
            </div>

            {/* Check rows */}
            <div style={{ padding: "4px 0" }}>
              {g.checks.map((c, i) => (
                <DiagnosticRow key={`${g.key}-${i}`} check={c} isMobile={isMobile} />
              ))}
            </div>
          </div>
        );
      })}

      {state !== "running" && diagnostics !== null && grouped.length === 0 && (
        <p style={{ color: C.textDim, fontSize: 13, margin: 0 }}>
          Keine Checks zurückgegeben.
        </p>
      )}
    </Section>
  );
}

/** Single diagnostic check row: glyph + name + detail + latency. */
function DiagnosticRow({
  check,
  isMobile,
}: {
  check: DiagnosticCheck;
  isMobile: boolean;
}) {
  const s = checkStatus(check);
  const color = statusColor(s);
  const glyph =
    s === "ok" ? (
      <Check size={14} />
    ) : s === "warn" ? (
      <AlertTriangle size={14} />
    ) : (
      <X size={14} />
    );
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "8px 12px",
        flexWrap: "wrap",
      }}
    >
      <span style={{ color, flex: "0 0 auto", marginTop: 1 }}>{glyph}</span>
      <span
        style={{
          fontSize: 13,
          color: C.text,
          minWidth: 0,
          // On desktop keep the name in its own column; on mobile allow the
          // detail to wrap to a full-width new line.
          flex: isMobile ? "1 1 100%" : "0 0 auto",
          overflowWrap: "anywhere",
        }}
      >
        {check.name}
      </span>
      {check.detail && (
        <span
          style={{
            fontSize: 12,
            color: C.textDim,
            minWidth: 0,
            flex: isMobile ? "1 1 100%" : "1 1 auto",
            overflowWrap: "anywhere",
            wordBreak: "break-word",
          }}
        >
          {check.detail}
        </span>
      )}
      {typeof check.latencyMs === "number" && (
        <span
          style={{
            fontSize: 11,
            color: C.textFaint,
            fontFamily: FONT.mono,
            marginLeft: isMobile ? 0 : "auto",
            flex: "0 0 auto",
          }}
        >
          {check.latencyMs} ms
        </span>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Logs-Tab — filterable view of the server's in-process ring buffer.
 *
 * Newest-first rows: timestamp, level badge, optional service tag, and a
 * monospace wrapping message. Level filter re-fetches server-side; the
 * service filter is applied client-side from the services actually present.
 * ────────────────────────────────────────────────────────────────────── */
function LogsTab({
  logs,
  state,
  error,
  level,
  service,
  isMobile,
  onLevelChange,
  onServiceChange,
  onRefresh,
}: {
  logs: LogEntry[] | null;
  state: "idle" | "loading" | "ok" | "fail";
  error: string | undefined;
  level: "all" | LogLevel;
  service: string;
  isMobile: boolean;
  onLevelChange: (lvl: "all" | LogLevel) => void;
  onServiceChange: (svc: string) => void;
  onRefresh: () => void;
}) {
  // Distinct services present in the current buffer — drives the service
  // dropdown. Recomputed whenever the logs change.
  const services = useMemo(() => {
    const set = new Set<string>();
    for (const l of logs ?? []) if (l.service) set.add(l.service);
    return [...set].sort();
  }, [logs]);

  // Service filter is client-side; level was already applied server-side.
  const visible = useMemo(() => {
    if (!logs) return [];
    return service === "all"
      ? logs
      : logs.filter((l) => l.service === service);
  }, [logs, service]);

  const selectStyle: React.CSSProperties = {
    padding: "8px 10px",
    minHeight: isMobile ? TOUCH_TARGET_MIN : undefined,
    background: C.elevated,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    color: C.text,
    fontFamily: FONT.mono,
    fontSize: 13,
    outline: "none",
    flex: isMobile ? "1 1 100%" : "0 0 auto",
  };

  return (
    <Section title="Logs — Ring-Buffer (neueste zuerst)">
      <p
        style={{
          color: C.textDim,
          fontSize: 13,
          margin: "0 0 14px 0",
          lineHeight: 1.5,
        }}
      >
        Die letzten ~{DEFAULT_LOG_LIMIT} wichtigen Server-Ereignisse — direkt
        aus dem In-Process-Ring-Buffer, kein Coolify/SSH nötig.
      </p>

      {/* Filter bar */}
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 3,
            flex: isMobile ? "1 1 100%" : "0 0 auto",
          }}
        >
          <span
            style={{ fontSize: 11, color: C.textDim, fontFamily: FONT.mono }}
          >
            LEVEL
          </span>
          <select
            value={level}
            onChange={(e) => onLevelChange(e.target.value as "all" | LogLevel)}
            style={selectStyle}
          >
            {LOG_LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 3,
            flex: isMobile ? "1 1 100%" : "0 0 auto",
          }}
        >
          <span
            style={{ fontSize: 11, color: C.textDim, fontFamily: FONT.mono }}
          >
            SERVICE
          </span>
          <select
            value={service}
            onChange={(e) => onServiceChange(e.target.value)}
            style={selectStyle}
          >
            <option value="all">Alle</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={onRefresh}
          disabled={state === "loading"}
          style={{
            ...mobileBtn(btn, isMobile),
            alignSelf: isMobile ? "stretch" : "flex-end",
            flex: isMobile ? "1 1 100%" : "0 0 auto",
            justifyContent: "center",
            opacity: state === "loading" ? 0.6 : 1,
            cursor: state === "loading" ? "not-allowed" : "pointer",
          }}
        >
          {state === "loading" ? (
            <Loader2 size={14} className="sw-spin" />
          ) : (
            <RefreshCw size={13} />
          )}
          Aktualisieren
        </button>
      </div>

      {state === "fail" && (
        <p style={{ color: C.err, fontSize: 13, margin: "0 0 12px 0" }}>
          <X size={14} /> {error ?? "Logs-Endpoint nicht erreichbar"}
        </p>
      )}

      {state === "loading" && logs === null && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: C.textDim,
            fontSize: 13,
          }}
        >
          <Loader2 size={14} className="sw-spin" /> Logs laden …
        </div>
      )}

      {logs !== null && visible.length === 0 && state !== "loading" && (
        <p style={{ color: C.textDim, fontSize: 13, margin: 0 }}>
          Keine Log-Einträge für diesen Filter.
        </p>
      )}

      {visible.length > 0 && (
        <div
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            overflow: "hidden",
            maxWidth: "100%",
          }}
        >
          {visible.map((entry, i) => (
            <LogRow
              key={`${entry.ts}-${i}`}
              entry={entry}
              isMobile={isMobile}
              striped={i % 2 === 1}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

/** Colour for a log-level badge. */
function logLevelColor(level: LogLevel): string {
  if (level === "error") return C.err;
  if (level === "warn") return C.gold;
  return C.textDim;
}

/** Single log row: timestamp + level badge + service tag + message. */
function LogRow({
  entry,
  isMobile,
  striped,
}: {
  entry: LogEntry;
  isMobile: boolean;
  striped: boolean;
}) {
  const color = logLevelColor(entry.level);
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        flexWrap: "wrap",
        padding: "8px 12px",
        background: striped ? C.elevated : C.panel,
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: C.textFaint,
          fontFamily: FONT.mono,
          flex: "0 0 auto",
          whiteSpace: "nowrap",
        }}
      >
        {new Date(entry.ts).toLocaleString("de-DE")}
      </span>
      <span
        style={{
          fontSize: 10,
          fontFamily: FONT.mono,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color,
          border: `1px solid ${color}`,
          borderRadius: 4,
          padding: "1px 6px",
          flex: "0 0 auto",
        }}
      >
        {entry.level}
      </span>
      {entry.service && (
        <span
          style={{
            fontSize: 10,
            fontFamily: FONT.mono,
            color: C.textDim,
            background: C.hover,
            borderRadius: 4,
            padding: "1px 6px",
            flex: "0 0 auto",
          }}
        >
          {entry.service}
        </span>
      )}
      <span
        style={{
          fontSize: 12,
          fontFamily: FONT.mono,
          color: C.text,
          minWidth: 0,
          // Message takes the full next line on mobile and wraps; on desktop
          // it fills the remaining row width.
          flex: isMobile ? "1 1 100%" : "1 1 auto",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        }}
      >
        {entry.message}
      </span>
    </div>
  );
}

/**
 * Story 1.20 — Basis-Vault-Struktur auf einem BESTEHENDEN Vault nachziehen.
 *
 * Wer vor v1.9 installiert hat, bekam nie das Grundgerüst (Ordner, Schemas,
 * SPEC, Templates) und nie den Pre-Commit-Hook. Dieses Panel legt genau den
 * Scaffold frei, den der Setup-Wizard fährt.
 *
 * Bewusst dreistufig, damit nichts unangekündigt passiert:
 *   1. Prüfen   — Dry-Run, schreibt garantiert nichts
 *   2. Nachziehen — legt NUR fehlende Dateien an, fasst eigene Edits nie an
 *   3. Hook aktivieren — eigener, separat bestätigter Schritt
 *
 * Der Hook wird getrennt behandelt, weil er Commits ablehnt, die Notizen ohne
 * SPEC-Frontmatter anfassen. Das Panel nennt die Zahl VOR der Bestätigung —
 * und ordnet sie ein, statt sie zu dramatisieren: der Hook prüft nur gestagte
 * Dateien und schreibt nie etwas um, sperrt also niemanden aus.
 */
function VaultScaffoldPanel({ isMobile }: { isMobile: boolean }) {
  type Sample = { path: string; reasons: string[]; blocksCommit: boolean };
  type Plan = {
    vaultDir: string;
    plan: { created: string[]; skipped: string[] };
    hook: {
      activated: boolean;
      hooksPath: string | null;
      scanned: number;
      invalid: number;
      blocking: number;
      samples: Sample[];
      truncated: boolean;
    };
  };

  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<null | "plan" | "apply" | "hook">(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [hookConfirmed, setHookConfirmed] = useState(false);
  const [showSamples, setShowSamples] = useState(false);

  async function loadPlan(): Promise<void> {
    setBusy("plan");
    setError(null);
    setFlash(null);
    try {
      const res = await fetch("/api/admin/vault-scaffold");
      const data = (await res.json()) as Plan & { message?: string };
      if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
      setPlan(data);
      setHookConfirmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function apply(activateHook: boolean): Promise<void> {
    setBusy(activateHook ? "hook" : "apply");
    setError(null);
    setFlash(null);
    try {
      const res = await fetch("/api/admin/vault-scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activateHook }),
      });
      const data = (await res.json()) as {
        created?: string[];
        committed?: boolean;
        pushed?: boolean;
        pushError?: string | null;
        hookActivated?: boolean;
        message?: string;
      };
      if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`);
      const parts: string[] = [];
      parts.push(`${data.created?.length ?? 0} Datei(en) angelegt`);
      if (data.committed) parts.push(data.pushed ? "committet + gepusht" : "lokal committet");
      if (data.pushError) parts.push("Push fehlgeschlagen — ein späterer Sync holt ihn nach");
      if (data.hookActivated) parts.push("Pre-Commit-Hook aktiviert");
      setFlash(parts.join(" · "));
      await loadPlan();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const missing = plan?.plan.created.length ?? 0;
  const blocking = plan?.hook.blocking ?? 0;

  return (
    <Section title="Vault-Grundgerüst nachziehen">
      <p style={{ fontSize: 13, color: C.textDim, margin: "0 0 14px 0", lineHeight: 1.6 }}>
        Installationen von vor v1.9 haben die Standard-Struktur nie bekommen —
        Ordner, JSON-Schemas, SPEC.md, Note-Templates und den SPEC-Pre-Commit-Hook.
        Das Nachziehen legt <strong>ausschließlich fehlende</strong> Dateien an;
        alles, was schon da ist, bleibt unangetastet.
      </p>

      <button
        onClick={() => void loadPlan()}
        disabled={busy !== null}
        style={mobileBtn({ ...btn, opacity: busy ? 0.6 : 1 }, isMobile)}
      >
        {busy === "plan" ? "Prüfe…" : "Struktur prüfen"}
      </button>

      {error && <Note color={C.err}>{error}</Note>}
      {flash && <Note color={C.ok}>{flash}</Note>}

      {plan && (
        <div style={{ marginTop: 16 }}>
          <KV label="Vault" value={plan.vaultDir} isMobile={isMobile} />
          <KV
            label="Fehlt"
            value={missing === 0 ? "nichts — Struktur ist vollständig" : `${missing} Datei(en)`}
            isMobile={isMobile}
          />
          <KV
            label="Vorhanden"
            value={`${plan.plan.skipped.length} Datei(en) bleiben unangetastet`}
            isMobile={isMobile}
          />

          {missing > 0 && (
            <button
              onClick={() => void apply(false)}
              disabled={busy !== null}
              style={mobileBtn(
                { ...btn, marginTop: 12, borderColor: C.accent, color: C.accentHi },
                isMobile,
              )}
            >
              {busy === "apply" ? "Lege an…" : `${missing} fehlende Datei(en) anlegen`}
            </button>
          )}

          {/* ── Schritt 3: Hook, bewusst getrennt ── */}
          <div
            style={{
              marginTop: 20,
              paddingTop: 16,
              borderTop: `1px solid ${C.border}`,
            }}
          >
            <h3 style={{ fontFamily: FONT.serif, fontSize: 15, margin: "0 0 10px 0" }}>
              SPEC-Pre-Commit-Hook
            </h3>

            {plan.hook.activated ? (
              <Note color={C.ok}>
                Aktiv (<code>core.hooksPath = {plan.hook.hooksPath}</code>). Neue
                Notizen werden gegen die SPEC geprüft, bevor sie committet werden.
              </Note>
            ) : (
              <>
                <p style={{ fontSize: 13, color: C.textDim, margin: "0 0 10px 0", lineHeight: 1.6 }}>
                  Noch nicht aktiv. Der Hook prüft <strong>nur gestagte Dateien</strong> und
                  schreibt nie etwas um — er kann dich also nicht aus deinem Vault
                  aussperren. Was er tut: einen Commit ablehnen, der eine Notiz ohne
                  gültiges Frontmatter anfasst.
                </p>

                <div
                  style={{
                    padding: 12,
                    background: C.elevated,
                    borderRadius: 6,
                    marginBottom: 12,
                    fontSize: 13,
                    lineHeight: 1.7,
                  }}
                >
                  <div>
                    Geprüft: <strong>{plan.hook.scanned}</strong> Notiz(en) im Vault.
                  </div>
                  <div style={{ color: blocking > 0 ? C.gold : C.ok }}>
                    Davon würden <strong>{blocking}</strong> vom Hook abgelehnt —
                    {blocking === 0
                      ? " nichts blockiert."
                      : " betroffen ist jeweils erst der nächste Commit, der die Datei anfasst."}
                  </div>
                  {plan.hook.invalid > blocking && (
                    <div style={{ color: C.textDim, marginTop: 4 }}>
                      Zusätzlich verletzen {plan.hook.invalid - blocking} weitere Notiz(en)
                      die SPEC strenger, als der Hook prüft (z. B. Datum ohne Uhrzeit).
                      Die blockieren nichts.
                    </div>
                  )}
                  {plan.hook.samples.length > 0 && (
                    <button
                      onClick={() => setShowSamples((v) => !v)}
                      style={{
                        ...btn,
                        marginTop: 8,
                        padding: "4px 10px",
                        fontSize: 12,
                      }}
                    >
                      {showSamples ? "Beispiele ausblenden" : "Beispiele zeigen"}
                    </button>
                  )}
                  {showSamples && (
                    <ul
                      style={{
                        margin: "10px 0 0 0",
                        paddingLeft: 18,
                        fontSize: 12,
                        color: C.textDim,
                        fontFamily: FONT.mono,
                      }}
                    >
                      {plan.hook.samples.map((s) => (
                        <li key={s.path} style={{ marginBottom: 6 }}>
                          <span style={{ color: s.blocksCommit ? C.gold : C.textFaint }}>
                            {s.path}
                          </span>
                          <br />
                          {s.reasons.join("; ")}
                        </li>
                      ))}
                      {plan.hook.truncated && <li>… und weitere</li>}
                    </ul>
                  )}
                </div>

                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    fontSize: 13,
                    marginBottom: 12,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={hookConfirmed}
                    onChange={(e) => setHookConfirmed(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    Ich habe die {blocking} betroffene(n) Notiz(en) zur Kenntnis genommen
                    und will den Hook aktivieren.
                  </span>
                </label>

                <button
                  onClick={() => void apply(true)}
                  disabled={busy !== null || !hookConfirmed}
                  style={mobileBtn(
                    {
                      ...btn,
                      borderColor: hookConfirmed ? C.accent : C.border,
                      color: hookConfirmed ? C.accentHi : C.textFaint,
                      cursor: hookConfirmed ? "pointer" : "not-allowed",
                      opacity: busy ? 0.6 : 1,
                    },
                    isMobile,
                  )}
                >
                  {busy === "hook" ? "Aktiviere…" : "Hook aktivieren"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

const btn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  background: C.elevated,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  color: C.text,
  fontFamily: FONT.ui,
  fontSize: 13,
  cursor: "pointer",
};

/**
 * Enlarge a button to a ≥40px tap target on mobile. Pure styling helper —
 * spreads the base button style and bumps `minHeight` + vertical padding
 * when `isMobile`. Desktop returns the style untouched.
 */
function mobileBtn(
  base: React.CSSProperties,
  isMobile: boolean,
): React.CSSProperties {
  if (!isMobile) return base;
  return {
    ...base,
    minHeight: TOUCH_TARGET_MIN,
    padding: "10px 14px",
  };
}
