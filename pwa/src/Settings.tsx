import { useEffect, useState } from "react";
import { Check, X, Loader2, Copy, ExternalLink } from "lucide-react";
import { C, FONT } from "./theme.js";

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

export function Settings({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);

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

  async function load() {
    const [sRes, statusRes, mcpRes, skillRes] = await Promise.all([
      fetch("/api/admin/system-settings").then((r) => r.json()) as Promise<SystemSettings>,
      fetch("/api/admin/status").then((r) => r.json()) as Promise<StatusResult>,
      fetch("/api/admin/mcp-info").then((r) => r.json()) as Promise<McpInfo>,
      fetch("/api/admin/skills").then((r) => r.json()) as Promise<{ skills: SkillInfo[] }>,
    ]);
    setSettings(sRes);
    setStatus(statusRes);
    setMcp(mcpRes);
    setSkills(skillRes.skills);
    if (sRes.vault) {
      setNewRemote(sRes.vault.gitRemote);
      setNewBranch(sRes.vault.gitBranch);
    }
    // Pre-fill integrations with masked key / current folder.
    setSupadataInput(sRes.integrations.supadataApiKeyMasked ?? "");
    setSupadataTouched(false);
    setImportFolderInput(sRes.integrations.defaultImportFolder);
  }

  useEffect(() => {
    void load();
  }, []);

  async function changeVaultUrl() {
    if (!settings?.vault) return;
    setVaultSaveState("saving");
    setVaultSaveError(undefined);
    try {
      const res = await fetch("/api/admin/system-settings/vault-url", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vaultId: settings.vault.id,
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
        <Field label="Vault-Name" value={settings.vault?.name ?? "—"} readOnly />
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

      {/* ───── 3. MCP-Endpoint für Claude Desktop ───── */}
      <Section title="MCP-Anbindung — drei Wege">
        <p style={{ color: C.ok, fontSize: 13, margin: "0 0 8px 0" }}>
          MCP-Server läuft. Tools: <code style={{ color: C.gold }}>{(mcp.tools ?? []).join(", ")}</code>
        </p>

        {mcp.variants ? (
          <>
            {(["a_local_stdio", "b_npx", "c_remote_http"] as const).map((k) => {
              const v = mcp.variants![k];
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

      {/* ───── Runtime info (klein, unten) ───── */}
      <Section title="Runtime">
        <KV label="Vault-Dir (lokal)" value={settings.runtime.vaultDir} />
        <KV label="DATABASE_URL" value={settings.runtime.databaseUrl} />
        <KV label="OLLAMA_HOST" value={settings.runtime.ollamaHost} />
      </Section>
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
