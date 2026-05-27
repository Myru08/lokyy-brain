import { useEffect, useMemo, useState } from "react";
import { Check, X, Loader2, Copy, RefreshCw } from "lucide-react";
import { C, FONT } from "./theme.js";
import { AiProviderSettings } from "./AiProviderSettings.js";
import { api } from "./api.js";

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
  forgejo: { ok: boolean; error?: string };
  postgres: { ok: boolean; error?: string; pgvector?: string | null };
  ollama: { ok: boolean; error?: string; hasNomicEmbed?: boolean };
}

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
  snippet: Record<string, unknown>;
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
    /** Native HTTP transport — recommended for modern clients. */
    c_native_http: McpVariant;
    /** Legacy mcp-remote bridge — fallback for clients without native HTTP. */
    d_mcp_remote_legacy: McpVariant;
  };
  // legacy single-snippet support:
  claudeDesktopConfigSnippet?: Record<string, unknown>;
  binaryHint?: string;
  scopesFile?: string;
  scopesFileHint?: string;
}

interface SkillInfo {
  name: string;
  description: string;
  installHint: string;
  howToUse?: string;
  examplePrompt?: string;
  worksWith?: string[];
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
  };
}

/** Six top-level tabs. Order matches the visible tab bar. */
type TabKey = "system" | "vault" | "ai" | "mcp" | "skills" | "wartung";

const TABS: { key: TabKey; label: string }[] = [
  { key: "system", label: "System" },
  { key: "vault", label: "Vault" },
  { key: "ai", label: "AI Provider" },
  { key: "mcp", label: "MCP" },
  { key: "skills", label: "Skills" },
  { key: "wartung", label: "Wartung" },
];

export function Settings({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>("system");

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

  useEffect(() => {
    void load();
    void loadForgejoProbe();
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
    };
  }, [mcp, runtime]);

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
        padding: 32,
        background: C.bg,
        color: C.text,
        fontFamily: FONT.ui,
        height: "100%",
        overflow: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 18,
        }}
      >
        <h1
          style={{
            fontFamily: FONT.serif,
            fontSize: 28,
            margin: 0,
            color: C.accent,
          }}
        >
          Einstellungen
        </h1>
        <button onClick={onClose} style={btn}>
          ← Zurück zum Vault
        </button>
      </div>

      {/* ───── Tab bar ───── */}
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
          borderRadius: 999,
          width: "fit-content",
          flexWrap: "wrap",
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
                padding: "6px 16px",
                background: active ? C.accent : "transparent",
                color: active ? "#0B0E12" : C.textDim,
                border: "none",
                borderRadius: 999,
                fontFamily: FONT.ui,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                transition: "background 120ms, color 120ms",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ───── Tab: System ───── */}
      {tab === "system" && (
        <Section title="System-Status">
          <StatusBar
            label="Forgejo"
            ok={status.forgejo.ok}
            detail={status.forgejo.error}
          />
          <StatusBar
            label="Postgres"
            ok={status.postgres.ok}
            detail={
              status.postgres.error ??
              (status.postgres.pgvector
                ? `pgvector v${status.postgres.pgvector}`
                : "pgvector fehlt")
            }
          />
          <StatusBar
            label="Ollama"
            ok={status.ollama.ok}
            detail={
              status.ollama.error ??
              (status.ollama.hasNomicEmbed
                ? "nomic-embed-text bereit"
                : "nomic-embed-text fehlt")
            }
          />
          <button onClick={() => void load()} style={{ ...btn, marginTop: 12 }}>
            Status neu laden
          </button>
        </Section>
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
        <Section title="MCP-Anbindung — drei Wege">
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
                              gap: 12,
                              fontSize: 11,
                              color: C.textDim,
                              marginBottom: 6,
                              fontFamily: FONT.mono,
                            }}
                          >
                            <span>
                              endpoint:{" "}
                              <code style={{ color: C.gold }}>
                                {v.endpointUrl}
                              </code>
                            </span>
                            {v.healthUrl && (
                              <span>
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
                        <CodeBlock
                          label={`${v.title} — claude_desktop_config.json`}
                          code={JSON.stringify(v.snippet, null, 2)}
                          onCopy={(l, c) => copy(l, c)}
                          copiedLabel={copied}
                        />
                        {v.extraSnippets?.map((sub, i) => (
                          <CodeBlock
                            key={`${k}-extra-${i}`}
                            label={`${v.title} — ${sub.label}`}
                            code={sub.code}
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

      {/* ───── Tab: Skills ───── */}
      {tab === "skills" && (
        <Section title="Empfohlene PAI Skills">
          {skills.map((s) => (
            <div
              key={s.name}
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
                  {s.name}
                </strong>
                {s.worksWith && (
                  <span
                    style={{
                      fontSize: 11,
                      color: C.textFaint,
                      fontFamily: FONT.mono,
                    }}
                  >
                    nutzt: {s.worksWith.join(", ")}
                  </span>
                )}
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

              {s.howToUse && (
                <div
                  style={{
                    margin: "8px 0",
                    padding: 8,
                    background: C.panel,
                    borderRadius: 4,
                    fontSize: 12,
                    color: C.text,
                  }}
                >
                  <strong
                    style={{
                      color: C.gold,
                      fontSize: 11,
                      letterSpacing: 0.5,
                    }}
                  >
                    SO BENUTZEN
                  </strong>
                  <p style={{ margin: "4px 0 0 0" }}>{s.howToUse}</p>
                </div>
              )}

              {s.examplePrompt && (
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
                      BEISPIEL-PROMPT
                    </span>
                    <button
                      onClick={() =>
                        copy(`example-${s.name}`, s.examplePrompt!)
                      }
                      style={{
                        ...btn,
                        padding: "3px 7px",
                        fontSize: 10,
                      }}
                    >
                      <Copy size={10} />{" "}
                      {copied === `example-${s.name}`
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
                    }}
                  >
                    {s.examplePrompt}
                  </code>
                </div>
              )}

              <code
                style={{
                  display: "block",
                  marginTop: 8,
                  fontSize: 11,
                  color: C.textFaint,
                  fontFamily: FONT.mono,
                }}
              >
                {s.installHint}
              </code>
            </div>
          ))}
        </Section>
      )}

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

          <Section title="Runtime">
            <KV
              label="Vault-Dir (lokal)"
              value={settings.runtime.vaultDir}
            />
            <KV
              label="DATABASE_URL"
              value={
                runtime?.env.databaseHost ?? settings.runtime.databaseUrl
              }
            />
            <KV
              label="OLLAMA_HOST"
              value={
                runtime?.env.ollamaHost ?? settings.runtime.ollamaHost
              }
            />
            {runtime?.env.mcpPublicUrl && (
              <KV label="MCP_PUBLIC_URL" value={runtime.env.mcpPublicUrl} />
            )}
          </Section>
        </>
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
    | "d_mcp_remote_legacy",
  runtime: RuntimeInfo | null,
): McpVariant {
  if (key !== "c_native_http" && key !== "d_mcp_remote_legacy") return variant;
  const publicUrl = runtime?.env.mcpPublicUrl?.trim();
  if (!publicUrl) return variant;

  // mcp-remote convention: health endpoint = endpoint + "/health"
  const healthUrl = publicUrl.endsWith("/")
    ? `${publicUrl}health`
    : `${publicUrl}/health`;

  // Patch the snippet so the copyable JSON points at the public URL too.
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

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        marginBottom: 32,
        padding: 20,
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
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

function StatusBar({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 12px",
        background: C.elevated,
        borderRadius: 6,
        marginBottom: 6,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          background: ok ? C.ok : C.err,
        }}
      />
      <strong style={{ width: 90 }}>{label}</strong>
      <span style={{ color: ok ? C.ok : C.err, fontSize: 13 }}>
        {ok ? "OK" : "FAIL"}
      </span>
      {detail && (
        <span
          style={{ color: C.textDim, fontSize: 12, marginLeft: "auto" }}
        >
          {detail}
        </span>
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

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 12, fontSize: 13, marginBottom: 4 }}>
      <span
        style={{
          width: 160,
          color: C.textDim,
          fontFamily: FONT.mono,
          fontSize: 11,
        }}
      >
        {label}
      </span>
      <code
        style={{ color: C.text, fontFamily: FONT.mono, fontSize: 12 }}
      >
        {value}
      </code>
    </div>
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
