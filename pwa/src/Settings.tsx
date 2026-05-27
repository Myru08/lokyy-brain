import { useEffect, useState } from "react";
import { Check, X, Loader2, Copy, ExternalLink } from "lucide-react";
import { C, FONT } from "./theme.js";
import { AiProviderSettings } from "./AiProviderSettings.js";
import { api } from "./api.js";

/**
 * Settings Page (Story 1.12). Four sections per user requirement:
 *   1. Vault URL change with connection test
 *   2. MCP endpoint discovery + Copy-to-Clipboard for Claude Desktop config
 *   3. Skills list with install hints
 *   4. Live status pings (Forgejo / Postgres+pgvector / Ollama)
 *
 * Mounted by App.tsx when the user clicks the Settings icon in the header.
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
  snippet: Record<string, unknown>;
  endpointUrl?: string;
  healthUrl?: string;
  authNote?: string;
}

interface McpInfo {
  available: boolean;
  tools: string[];
  variants?: {
    a_local_stdio: McpVariant;
    b_npx: McpVariant;
    c_remote_http: McpVariant;
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

export function Settings({ onClose }: { onClose: () => void }) {
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

  const [newRemote, setNewRemote] = useState("");
  const [newBranch, setNewBranch] = useState("main");
  const [vaultSaveState, setVaultSaveState] = useState<
    "idle" | "saving" | "ok" | "fail"
  >("idle");
  const [vaultSaveError, setVaultSaveError] = useState<string>();
  const [copied, setCopied] = useState<string | null>(null);

  // Integrations — Supadata key + default import folder
  const [supadataInput, setSupadataInput] = useState("");
  const [supadataTouched, setSupadataTouched] = useState(false);
  const [importFolderInput, setImportFolderInput] = useState("");
  const [integrationsSaveState, setIntegrationsSaveState] = useState<
    "idle" | "saving" | "ok" | "fail"
  >("idle");
  const [integrationsSaveError, setIntegrationsSaveError] = useState<string>();

  // Vault maintenance — ULID-backfill (Phase D Wave D1 / Story 1)
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
      const res = await fetch("/api/settings/runtime", { credentials: "include" });
      if (!res.ok) return null;
      return (await res.json()) as RuntimeInfo;
    } catch {
      return null;
    }
  }

  async function load() {
    const [sRes, statusRes, mcpRes, skillRes, runtimeRes] = await Promise.all([
      fetch("/api/admin/system-settings").then((r) => r.json()) as Promise<SystemSettings>,
      fetch("/api/admin/status").then((r) => r.json()) as Promise<StatusResult>,
      fetch("/api/admin/mcp-info").then((r) => r.json()) as Promise<McpInfo>,
      fetch("/api/admin/skills").then((r) => r.json()) as Promise<{ skills: SkillInfo[] }>,
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
  }, []);

  async function changeVaultUrl() {
    // Vault-ID can come from either payload — runtime is preferred but the
    // legacy field is a valid fallback when /api/settings/runtime isn't live.
    const vaultId = runtime?.vault?.id ?? settings?.vault?.id;
    if (!vaultId) return;
    setVaultSaveState("saving");
    setVaultSaveError(undefined);
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
        setVaultSaveError(data.message ?? data.error ?? "Fehler");
      } else {
        setVaultSaveState("ok");
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ fontFamily: FONT.serif, fontSize: 28, margin: 0, color: C.accent }}>
          Einstellungen
        </h1>
        <button onClick={onClose} style={btn}>← Zurück zum Vault</button>
      </div>

      {/* ───── 1. Live Status (oben, damit man's sofort sieht) ───── */}
      <Section title="System-Status">
        <StatusBar label="Forgejo" ok={status.forgejo.ok} detail={status.forgejo.error} />
        <StatusBar
          label="Postgres"
          ok={status.postgres.ok}
          detail={
            status.postgres.error ??
            (status.postgres.pgvector ? `pgvector v${status.postgres.pgvector}` : "pgvector fehlt")
          }
        />
        <StatusBar
          label="Ollama"
          ok={status.ollama.ok}
          detail={
            status.ollama.error ??
            (status.ollama.hasNomicEmbed ? "nomic-embed-text bereit" : "nomic-embed-text fehlt")
          }
        />
        <button onClick={() => void load()} style={{ ...btn, marginTop: 12 }}>
          Status neu laden
        </button>
      </Section>

      {/* ───── 2. Vault URL ändern ───── */}
      <Section title="Vault-URL (Forgejo Remote)">
        <Field
          label="Vault-Name"
          value={runtime?.vault?.name ?? settings.vault?.name ?? "—"}
          readOnly
        />
        <Field
          label="GIT_REMOTE"
          value={newRemote}
          onChange={setNewRemote}
        />
        <Field label="GIT_BRANCH" value={newBranch} onChange={setNewBranch} />
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button onClick={changeVaultUrl} disabled={vaultSaveState === "saving"} style={btn}>
            {vaultSaveState === "saving" && <Loader2 size={14} className="sw-spin" />}
            Vault-URL ändern (mit Test)
          </button>
          {vaultSaveState === "ok" && <span style={{ color: C.ok, fontSize: 13 }}><Check size={14} /> gespeichert</span>}
          {vaultSaveState === "fail" && <span style={{ color: C.err, fontSize: 13 }}><X size={14} /> {vaultSaveError}</span>}
        </div>
      </Section>

      {/* ───── 2b. Integrations (Supadata + Default Import Folder) ───── */}
      <Section title="Integrations">
        <label style={{ display: "block", marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4, fontFamily: FONT.mono }}>
            Supadata API Key
            {settings.integrations.supadataApiKeyConfigured ? (
              <span style={{ color: C.ok, marginLeft: 8 }}>● gespeichert</span>
            ) : (
              <span style={{ color: C.gold, marginLeft: 8 }}>● nicht konfiguriert</span>
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
          <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>
            Wird für URL- und YouTube-Import-Pipes verwendet. Wir senden den Key
            nie zurück zum Browser — nur die Maske <code>***...{"{last4}"}</code>.
          </div>
        </label>

        <Field
          label="Default Import Folder (vault-relativ)"
          value={importFolderInput}
          onChange={setImportFolderInput}
        />

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => void saveIntegrations()}
            disabled={integrationsSaveState === "saving"}
            style={btn}
          >
            {integrationsSaveState === "saving" && <Loader2 size={14} className="sw-spin" />}
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

      {/* ───── 2c. AI Provider (Wave C-Frontend) ───── */}
      <AiProviderSettings
        runtimeOllamaHost={runtime?.env.ollamaHost ?? settings.runtime.ollamaHost}
      />

      {/* ───── 3. MCP-Endpoint für Claude Desktop ───── */}
      <Section title="MCP-Anbindung — drei Wege">
        {/*
          Vault-ID card — pinned at the very top of the MCP section so the
          operator immediately sees the value they have to inject into
          Coolify / docker-compose as `LOKYY_VAULT_ID`. Without it the
          lokyy-mcp container crash-loops on startup. Status indicator is
          derived from the existing `mcp.available` health flag.
        */}
        <VaultIdCard
          vaultId={runtime?.vault?.id ?? settings.vault?.id ?? null}
          mcpAvailable={mcp.available}
          onCopy={() => {
            const id = runtime?.vault?.id ?? settings.vault?.id;
            if (id) copy("vault-id", id);
          }}
          copiedLabel={copied}
        />

        <p style={{ color: C.ok, fontSize: 13, margin: "0 0 8px 0" }}>
          MCP-Server läuft. Tools: <code style={{ color: C.gold }}>{(mcp.tools ?? []).join(", ")}</code>
        </p>

        {mcp.variants ? (
          <>
            {(["a_local_stdio", "b_npx", "c_remote_http"] as const).map((k) => {
              // Override the Remote-HTTP variant's URLs and snippet body when
              // the runtime endpoint exposes a public FQDN — the legacy
              // payload defaults to `localhost:8788`, which only works on
              // the host itself.
              const v = applyRuntimeOverrides(mcp.variants![k], k, runtime);
              return (
                <div key={k} style={{ marginBottom: 18, padding: 12, background: C.elevated, borderRadius: 6, border: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <strong style={{ color: C.accent, fontFamily: FONT.serif, fontSize: 14 }}>{v.title}</strong>
                    <span style={{ fontSize: 11, color: C.textFaint, fontFamily: FONT.mono }}>{k}</span>
                  </div>
                  <p style={{ color: C.textDim, fontSize: 12, margin: "4px 0 8px 0" }}>
                    <em>Wann:</em> {v.when}
                  </p>
                  {v.precondition && (
                    <Note color={C.gold}>
                      <strong>Voraussetzung:</strong>{" "}
                      {Array.isArray(v.precondition) ? (
                        <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                          {v.precondition.map((p, i) => (
                            <li key={i} style={{ fontSize: 12 }}>{p}</li>
                          ))}
                        </ul>
                      ) : (
                        v.precondition
                      )}
                    </Note>
                  )}
                  {v.endpointUrl && (
                    <div style={{ display: "flex", gap: 12, fontSize: 11, color: C.textDim, marginBottom: 6, fontFamily: FONT.mono }}>
                      <span>endpoint: <code style={{ color: C.gold }}>{v.endpointUrl}</code></span>
                      {v.healthUrl && <span>health: <code style={{ color: C.gold }}>{v.healthUrl}</code></span>}
                    </div>
                  )}
                  <CodeBlock
                    label={`${v.title} — claude_desktop_config.json`}
                    code={JSON.stringify(v.snippet, null, 2)}
                    onCopy={(l, c) => copy(l, c)}
                    copiedLabel={copied}
                  />
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
              code={JSON.stringify(mcp.claudeDesktopConfigSnippet, null, 2)}
              onCopy={(l, c) => copy(l, c)}
              copiedLabel={copied}
            />
          )
        )}

        {mcp.scopesFile && (
          <Note color={C.textDim}>
            <strong>Scopes-Datei:</strong> <code style={{ color: C.text }}>{mcp.scopesFile}</code>
            <br />
            {mcp.scopesFileHint}
          </Note>
        )}

        <Note color={C.textDim}>
          <strong>Claude-Desktop-Config-Pfad:</strong>
          <br />macOS: <code style={{ color: C.text }}>~/Library/Application Support/Claude/claude_desktop_config.json</code>
          <br />Linux: <code style={{ color: C.text }}>~/.config/Claude/claude_desktop_config.json</code>
          <br />Nach Speichern Claude Desktop neu starten.
        </Note>
      </Section>

      {/* ───── 4. Skills-Liste mit How-To ───── */}
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
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <strong style={{ color: C.accent, fontFamily: FONT.serif, fontSize: 16 }}>{s.name}</strong>
              {s.worksWith && (
                <span style={{ fontSize: 11, color: C.textFaint, fontFamily: FONT.mono }}>
                  nutzt: {s.worksWith.join(", ")}
                </span>
              )}
            </div>
            <p style={{ color: C.textDim, fontSize: 13, margin: "6px 0" }}>{s.description}</p>

            {s.howToUse && (
              <div style={{ margin: "8px 0", padding: 8, background: C.panel, borderRadius: 4, fontSize: 12, color: C.text }}>
                <strong style={{ color: C.gold, fontSize: 11, letterSpacing: 0.5 }}>SO BENUTZEN</strong>
                <p style={{ margin: "4px 0 0 0" }}>{s.howToUse}</p>
              </div>
            )}

            {s.examplePrompt && (
              <div style={{ marginTop: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                  <span style={{ fontSize: 11, color: C.textDim, fontFamily: FONT.mono }}>BEISPIEL-PROMPT</span>
                  <button onClick={() => copy(`example-${s.name}`, s.examplePrompt!)} style={{ ...btn, padding: "3px 7px", fontSize: 10 }}>
                    <Copy size={10} /> {copied === `example-${s.name}` ? "kopiert" : "kopieren"}
                  </button>
                </div>
                <code style={{ display: "block", padding: 8, background: C.panel, borderRadius: 4, fontFamily: FONT.mono, fontSize: 11, color: C.text }}>
                  {s.examplePrompt}
                </code>
              </div>
            )}

            <code style={{ display: "block", marginTop: 8, fontSize: 11, color: C.textFaint, fontFamily: FONT.mono }}>
              {s.installHint}
            </code>
          </div>
        ))}
      </Section>

      {/* ───── Vault-Wartung (Phase D Wave D1 / Story 1 — ULID-Backfill) ───── */}
      <Section title="Vault-Wartung">
        <p style={{ color: C.textDim, fontSize: 13, margin: "0 0 12px 0" }}>
          Bestehende Notes ohne <code style={{ color: C.gold }}>id:</code>-ULID
          können nicht via AI-Prompt referenziert werden und tauchen nicht im
          MCP-<code>resolve_by_id</code> auf. Der Backfill-Pass fügt fehlende
          IDs hinzu — Inhalt bleibt unverändert, nur Frontmatter wird ergänzt.
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
                <strong style={{ color: C.textDim }}>Notes gesamt:</strong>{" "}
                {backfillStatus.totalNotes}
              </span>
              <span>
                <strong style={{ color: C.textDim }}>Ohne ULID:</strong>{" "}
                <span
                  style={{
                    color: backfillStatus.withoutUlid > 0 ? C.gold : C.ok,
                  }}
                >
                  {backfillStatus.withoutUlid}
                  {backfillStatus.scanLimited && "+ (gescannt: ersten 500)"}
                </span>
              </span>
            </div>
          </div>
        ) : (
          <p style={{ color: C.textDim, fontSize: 12, margin: "0 0 12px 0" }}>
            Status laden …
          </p>
        )}

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => void runBackfill()}
            disabled={
              backfillState === "running" ||
              (backfillStatus !== null && backfillStatus.withoutUlid === 0)
            }
            style={btn}
          >
            {backfillState === "running" && <Loader2 size={14} className="sw-spin" />}
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

        <p style={{ color: C.textFaint, fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          Pro Run werden bis zu 50 Notes verarbeitet — bei größeren Vaults
          mehrmals klicken. Letzter Run: {backfillLastRun
            ? new Date(backfillLastRun).toLocaleString("de-DE")
            : "noch nie (manuell)"}.
        </p>
      </Section>

      {/* ───── Runtime info (klein, unten) ───── */}
      <Section title="Runtime">
        <KV label="Vault-Dir (lokal)" value={settings.runtime.vaultDir} />
        <KV
          label="DATABASE_URL"
          value={
            // Prefer the (already redacted) host from the runtime endpoint —
            // it reflects the env actually in use, not whatever the legacy
            // payload thinks.
            runtime?.env.databaseHost ?? settings.runtime.databaseUrl
          }
        />
        <KV
          label="OLLAMA_HOST"
          value={runtime?.env.ollamaHost ?? settings.runtime.ollamaHost}
        />
        {runtime?.env.mcpPublicUrl && (
          <KV label="MCP_PUBLIC_URL" value={runtime.env.mcpPublicUrl} />
        )}
      </Section>
    </div>
  );
}

/**
 * Returns the variant with Remote-HTTP URLs overridden by the runtime
 * payload when available. Other variants (a_local_stdio, b_npx) pass
 * through untouched. The snippet's third positional `args` slot is the
 * URL passed to `mcp-remote` — we rewrite it here in lock-step with the
 * `endpointUrl` so the copyable claude_desktop_config matches the
 * displayed endpoint.
 */
function applyRuntimeOverrides(
  variant: McpVariant,
  key: "a_local_stdio" | "b_npx" | "c_remote_http",
  runtime: RuntimeInfo | null,
): McpVariant {
  if (key !== "c_remote_http") return variant;
  const publicUrl = runtime?.env.mcpPublicUrl?.trim();
  if (!publicUrl) return variant;

  // mcp-remote convention: health endpoint = endpoint + "/health"
  const healthUrl = publicUrl.endsWith("/")
    ? `${publicUrl}health`
    : `${publicUrl}/health`;

  // Patch the snippet so the copyable JSON points at the public URL too.
  // Structure (from server admin route): { mcpServers: { "lokyy-brain": { args: [...] } } }
  const patchedSnippet = JSON.parse(JSON.stringify(variant.snippet)) as Record<
    string,
    unknown
  >;
  try {
    const servers = (patchedSnippet as { mcpServers?: Record<string, unknown> })
      .mcpServers;
    if (servers) {
      for (const name of Object.keys(servers)) {
        const entry = servers[name] as { args?: unknown[] } | undefined;
        if (entry && Array.isArray(entry.args)) {
          // args = ["-y", "mcp-remote", "<URL>", "--header", "Authorization:Bearer …"]
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

  return {
    ...variant,
    endpointUrl: publicUrl,
    healthUrl,
    snippet: patchedSnippet,
  };
}

/**
 * Prominent Vault-ID display for the MCP section. Coolify deployments
 * crash-loop the `lokyy-mcp` container until the operator copies this ID
 * into the env file and restarts the service, so we surface it loudly.
 */
function VaultIdCard({
  vaultId,
  mcpAvailable,
  onCopy,
  copiedLabel,
}: {
  vaultId: string | null;
  mcpAvailable: boolean;
  onCopy: () => void;
  copiedLabel: string | null;
}) {
  const hasId = Boolean(vaultId);
  return (
    <div
      style={{
        marginBottom: 18,
        padding: 14,
        background: C.elevated,
        border: `2px solid ${hasId ? C.accent : C.gold}`,
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
        <span aria-hidden style={{ fontSize: 18 }}>🆔</span>
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
        docker-compose) als <code style={{ color: C.text }}>LOKYY_VAULT_ID</code>{" "}
        ein und starte den <code style={{ color: C.text }}>lokyy-mcp</code>-Service
        neu.
      </p>

      <div style={{ fontSize: 12, fontFamily: FONT.mono }}>
        Status:{" "}
        {mcpAvailable ? (
          <span style={{ color: C.ok }}>
            <Check size={11} /> MCP läuft
          </span>
        ) : (
          <span style={{ color: C.err }}>
            <X size={11} /> MCP startet nicht — LOKYY_VAULT_ID fehlt oder
            falsch gesetzt
          </span>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
      <h2 style={{ fontFamily: FONT.serif, fontSize: 18, margin: "0 0 14px 0" }}>{title}</h2>
      {children}
    </section>
  );
}

function StatusBar({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
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
      <span style={{ color: ok ? C.ok : C.err, fontSize: 13 }}>{ok ? "OK" : "FAIL"}</span>
      {detail && <span style={{ color: C.textDim, fontSize: 12, marginLeft: "auto" }}>{detail}</span>}
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
      <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4, fontFamily: FONT.mono }}>{label}</div>
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: C.textDim, fontFamily: FONT.mono }}>{label}</span>
        <button onClick={() => onCopy(label, code)} style={{ ...btn, padding: "4px 8px", fontSize: 11 }}>
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

function Note({ color, children }: { color: string; children: React.ReactNode }) {
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
      <span style={{ width: 160, color: C.textDim, fontFamily: FONT.mono, fontSize: 11 }}>{label}</span>
      <code style={{ color: C.text, fontFamily: FONT.mono, fontSize: 12 }}>{value}</code>
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
