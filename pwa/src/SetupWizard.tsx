import { useEffect, useState } from "react";
import { Check, X, Loader2, ArrowRight, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { C, FONT } from "./theme.js";

/**
 * Setup Wizard (Story 1.11). Five guided steps for first-time install:
 * Forgejo → Postgres → Ollama → Admin User → Vault. Each connectivity
 * step has a "Test Connection" gate before the user can advance.
 *
 * Mounted by the App shell when /api/setup/status returns
 * `{setupComplete: false}`. On completion, calls /api/setup/complete and
 * reloads the page so the gated routes become available.
 */

type StepKey = "forgejo" | "postgres" | "ollama" | "admin" | "vault" | "done";
const STEP_ORDER: StepKey[] = [
  "forgejo",
  "postgres",
  "ollama",
  "admin",
  "vault",
  "done",
];
const STEP_LABEL: Record<StepKey, string> = {
  forgejo: "Forgejo",
  postgres: "Postgres",
  ollama: "Ollama",
  admin: "Admin",
  vault: "Vault",
  done: "Fertig",
};

interface FieldState {
  value: string;
  testStatus: "idle" | "testing" | "ok" | "fail";
  testMessage?: string;
}

type WizardState = {
  step: StepKey;
  forgejo: {
    gitRemote: FieldState;
    gitBranch: string;
  };
  postgres: {
    databaseUrl: FieldState;
  };
  ollama: {
    ollamaUrl: FieldState;
    hasNomic?: boolean;
  };
  admin: {
    email: string;
    password: string;
    name: string;
    userId?: string;
    submitState: "idle" | "submitting" | "ok" | "fail";
    error?: string;
  };
  vault: {
    name: string;
    slug: string;
    submitState: "idle" | "submitting" | "ok" | "fail";
    vaultId?: string;
    error?: string;
  };
};

const initialState: WizardState = {
  step: "forgejo",
  forgejo: {
    gitRemote: { value: "", testStatus: "idle" },
    gitBranch: "main",
  },
  postgres: {
    databaseUrl: { value: "postgres://postgres:lokyy@localhost:5432/lokyy_brain", testStatus: "idle" },
  },
  ollama: {
    ollamaUrl: { value: "http://localhost:11434", testStatus: "idle" },
  },
  admin: { email: "", password: "", name: "", submitState: "idle" },
  vault: { name: "Mein Vault", slug: "mein-vault", submitState: "idle" },
};

const SETUP_BASE = "/api/setup";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SETUP_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 400) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

interface ForgejoInfo {
  configured: boolean;
  baseUrl: string;
  redirectUri: string;
  clientIdPreview: string;
}

interface ForgejoConnection {
  connected: boolean;
  forgejoUserLogin?: string;
  baseUrl?: string;
}

interface ForgejoRepo {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  html_url: string;
}

type ForgejoPhase = "loading" | "not-configured" | "not-connected" | "connected" | "error";
type ForgejoMode = "existing" | "new";

export function SetupWizard({ onDone }: { onDone: () => void }) {
  const [s, setS] = useState<WizardState>(initialState);

  const [forgejoPhase, setForgejoPhase] = useState<ForgejoPhase>("loading");
  const [forgejoInfo, setForgejoInfo] = useState<ForgejoInfo | null>(null);
  const [forgejoConn, setForgejoConn] = useState<ForgejoConnection | null>(null);
  const [forgejoErr, setForgejoErr] = useState<string | undefined>(undefined);
  const [forgejoRepos, setForgejoRepos] = useState<ForgejoRepo[] | null>(null);
  const [forgejoReposBusy, setForgejoReposBusy] = useState(false);
  const [forgejoReposErr, setForgejoReposErr] = useState<string | undefined>(undefined);
  const [forgejoMode, setForgejoMode] = useState<ForgejoMode>("existing");
  const [forgejoSelected, setForgejoSelected] = useState<ForgejoRepo | null>(null);
  const [newRepoName, setNewRepoName] = useState("lokyy-vault");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [newRepoBusy, setNewRepoBusy] = useState(false);
  const [newRepoErr, setNewRepoErr] = useState<string | undefined>(undefined);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const stepIdx = STEP_ORDER.indexOf(s.step);

  function setStep(step: StepKey) {
    setS((p) => ({ ...p, step }));
  }

  async function loadForgejoStatus(opts?: { silent?: boolean }) {
    if (!opts?.silent) setForgejoPhase("loading");
    setForgejoErr(undefined);
    try {
      const [infoRes, connRes] = await Promise.all([
        fetch("/api/auth/forgejo/info"),
        fetch("/api/forgejo/connection"),
      ]);
      if (!infoRes.ok) throw new Error(`info HTTP ${infoRes.status}`);
      const info = (await infoRes.json()) as ForgejoInfo;
      setForgejoInfo(info);

      if (!info.configured) {
        setForgejoConn(null);
        setForgejoPhase("not-configured");
        return;
      }

      // info.configured === true: connection endpoint should be live
      if (!connRes.ok) throw new Error(`connection HTTP ${connRes.status}`);
      const conn = (await connRes.json()) as ForgejoConnection;
      setForgejoConn(conn);

      if (!conn.connected) {
        setForgejoPhase("not-connected");
        return;
      }

      setForgejoPhase("connected");
      // fire-and-forget: load repos
      void loadForgejoRepos();
    } catch (err) {
      setForgejoErr(err instanceof Error ? err.message : String(err));
      setForgejoPhase("error");
    }
  }

  async function loadForgejoRepos() {
    setForgejoReposBusy(true);
    setForgejoReposErr(undefined);
    try {
      const res = await fetch("/api/forgejo/repos");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const repos = (await res.json()) as ForgejoRepo[];
      setForgejoRepos(repos);
    } catch (err) {
      setForgejoReposErr(err instanceof Error ? err.message : String(err));
      setForgejoRepos([]);
    } finally {
      setForgejoReposBusy(false);
    }
  }

  async function createForgejoRepo() {
    if (!newRepoName.trim()) return;
    setNewRepoBusy(true);
    setNewRepoErr(undefined);
    try {
      const res = await fetch("/api/forgejo/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newRepoName.trim(), private: newRepoPrivate }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      const repo = (await res.json()) as ForgejoRepo;
      setForgejoRepos((prev) => (prev ? [repo, ...prev] : [repo]));
      pickForgejoRepo(repo);
      setForgejoMode("existing");
    } catch (err) {
      setNewRepoErr(err instanceof Error ? err.message : String(err));
    } finally {
      setNewRepoBusy(false);
    }
  }

  function pickForgejoRepo(repo: ForgejoRepo) {
    setForgejoSelected(repo);
    setS((p) => ({
      ...p,
      forgejo: {
        ...p.forgejo,
        gitRemote: { value: repo.clone_url, testStatus: "ok", testMessage: repo.full_name },
        gitBranch: repo.default_branch || "main",
      },
    }));
  }

  async function copyToClipboard(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((cur) => (cur === key ? null : cur));
      }, 1500);
    } catch {
      // ignore — older browsers
    }
  }

  useEffect(() => {
    // Strip the OAuth callback marker from the URL on first mount so refreshes
    // don't re-trigger the flow. The presence of the param means we just came
    // back from Forgejo — kick a refetch either way.
    if (typeof window !== "undefined" && window.location.search.includes("forgejo=connected")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("forgejo");
      window.history.replaceState({}, "", url.pathname + (url.search ? `?${url.searchParams}` : "") + url.hash);
    }
    void loadForgejoStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function testPostgres() {
    setS((p) => ({
      ...p,
      postgres: { databaseUrl: { ...p.postgres.databaseUrl, testStatus: "testing" } },
    }));
    const res = await postJson<{ ok: boolean; error?: string; pgvectorAvailable?: boolean }>("/test-postgres", {
      databaseUrl: s.postgres.databaseUrl.value,
    });
    setS((p) => ({
      ...p,
      postgres: {
        databaseUrl: {
          ...p.postgres.databaseUrl,
          testStatus: res.ok ? "ok" : "fail",
          testMessage: res.error ?? (res.pgvectorAvailable ? "pgvector verfügbar" : "pgvector fehlt"),
        },
      },
    }));
  }

  async function testOllama() {
    setS((p) => ({
      ...p,
      ollama: { ...p.ollama, ollamaUrl: { ...p.ollama.ollamaUrl, testStatus: "testing" } },
    }));
    const res = await postJson<{ ok: boolean; error?: string; hasNomicEmbed?: boolean }>("/test-ollama", {
      ollamaUrl: s.ollama.ollamaUrl.value,
    });
    setS((p) => ({
      ...p,
      ollama: {
        ollamaUrl: {
          ...p.ollama.ollamaUrl,
          testStatus: res.ok ? "ok" : "fail",
          testMessage: res.error,
        },
        hasNomic: res.hasNomicEmbed,
      },
    }));
  }

  async function submitAdmin() {
    setS((p) => ({ ...p, admin: { ...p.admin, submitState: "submitting" } }));
    try {
      const res = await postJson<{ userId?: string; error?: string }>("/admin", {
        email: s.admin.email,
        password: s.admin.password,
        name: s.admin.name,
      });
      if (!res.userId) {
        setS((p) => ({ ...p, admin: { ...p.admin, submitState: "fail", error: res.error ?? "fehler" } }));
      } else {
        setS((p) => ({ ...p, admin: { ...p.admin, submitState: "ok", userId: res.userId } }));
      }
    } catch (err) {
      setS((p) => ({
        ...p,
        admin: { ...p.admin, submitState: "fail", error: err instanceof Error ? err.message : "fehler" },
      }));
    }
  }

  async function submitVault() {
    if (!s.admin.userId) return;
    setS((p) => ({ ...p, vault: { ...p.vault, submitState: "submitting" } }));
    try {
      const res = await postJson<{ vaultId?: string; error?: string }>("/vault", {
        name: s.vault.name,
        slug: s.vault.slug,
        gitRemote: s.forgejo.gitRemote.value,
        gitBranch: s.forgejo.gitBranch,
        ownerUserId: s.admin.userId,
      });
      if (!res.vaultId) {
        setS((p) => ({ ...p, vault: { ...p.vault, submitState: "fail", error: res.error ?? "fehler" } }));
      } else {
        setS((p) => ({ ...p, vault: { ...p.vault, submitState: "ok", vaultId: res.vaultId } }));
      }
    } catch (err) {
      setS((p) => ({
        ...p,
        vault: { ...p.vault, submitState: "fail", error: err instanceof Error ? err.message : "fehler" },
      }));
    }
  }

  async function completeSetup() {
    await postJson<{ setupComplete: boolean }>("/complete", {});
    onDone();
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: C.bg,
        color: C.text,
        fontFamily: FONT.ui,
        padding: 32,
      }}
    >
      <header style={{ marginBottom: 32, textAlign: "center" }}>
        <img
          src="/logo-header.png"
          alt="lokyy-brain Setup"
          style={{ display: "block", margin: "0 auto 8px", maxWidth: 180, width: "100%", height: "auto" }}
        />
        <p style={{ color: C.textDim, marginTop: 8, margin: 0 }}>
          Erstinstallation in fünf Schritten.
        </p>
      </header>

      <Stepper step={s.step} />

      <main
        style={{
          flex: 1,
          maxWidth: 640,
          width: "100%",
          marginTop: 32,
          padding: 24,
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
        }}
      >
        {s.step === "forgejo" && (
          <StepShell
            title="Forgejo (Vault Remote)"
            description="Die Vault-Wahrheit liegt in einem Forgejo-Repo. Verbinde dich per OAuth statt einen Token zu pasten."
          >
            {forgejoPhase === "loading" && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, color: C.textDim, fontSize: 13, padding: "16px 0" }}>
                <Loader2 size={14} className="sw-spin" />
                Status wird geprüft …
              </div>
            )}

            {forgejoPhase === "error" && (
              <div style={{ color: C.err, fontSize: 13, marginTop: 8 }}>
                <X size={14} /> Status konnte nicht geladen werden: {forgejoErr ?? "unbekannter Fehler"}
                <div style={{ marginTop: 12 }}>
                  <button onClick={() => loadForgejoStatus()} style={btnStyle}>
                    <RefreshCw size={14} /> Erneut versuchen
                  </button>
                </div>
              </div>
            )}

            {forgejoPhase === "not-configured" && forgejoInfo && (
              <SetupHelpPanel
                info={forgejoInfo}
                onRecheck={() => loadForgejoStatus()}
                onCopy={copyToClipboard}
                copiedKey={copiedKey}
              />
            )}

            {forgejoPhase === "not-connected" && forgejoInfo && (
              <ConnectCta info={forgejoInfo} />
            )}

            {forgejoPhase === "connected" && forgejoConn && (
              <RepoPicker
                conn={forgejoConn}
                repos={forgejoRepos}
                reposBusy={forgejoReposBusy}
                reposErr={forgejoReposErr}
                onReloadRepos={loadForgejoRepos}
                mode={forgejoMode}
                onModeChange={setForgejoMode}
                selected={forgejoSelected}
                onPick={pickForgejoRepo}
                newRepoName={newRepoName}
                setNewRepoName={setNewRepoName}
                newRepoPrivate={newRepoPrivate}
                setNewRepoPrivate={setNewRepoPrivate}
                newRepoBusy={newRepoBusy}
                newRepoErr={newRepoErr}
                onCreate={createForgejoRepo}
              />
            )}

            <NextRow
              enabled={forgejoPhase === "connected" && s.forgejo.gitRemote.testStatus === "ok"}
              onNext={() => setStep("postgres")}
            />
          </StepShell>
        )}

        {s.step === "postgres" && (
          <StepShell title="Postgres (Sessions, Vault-Metadaten, Embeddings)" description="pgvector-fähiges Postgres. Docker-Compose-Setup liefert das automatisch.">
            <Field
              label="DATABASE_URL"
              value={s.postgres.databaseUrl.value}
              onChange={(v) =>
                setS((p) => ({
                  ...p,
                  postgres: { databaseUrl: { value: v, testStatus: "idle" } },
                }))
              }
            />
            <TestRow
              status={s.postgres.databaseUrl.testStatus}
              message={s.postgres.databaseUrl.testMessage}
              onTest={testPostgres}
            />
            <NextRow
              enabled={s.postgres.databaseUrl.testStatus === "ok"}
              onNext={() => setStep("ollama")}
            />
          </StepShell>
        )}

        {s.step === "ollama" && (
          <StepShell
            title="Ollama (Semantic Search)"
            description="Lokales Ollama mit nomic-embed-text Modell. Wird für Tier-2-Search verwendet."
          >
            <Field
              label="OLLAMA_HOST"
              value={s.ollama.ollamaUrl.value}
              onChange={(v) =>
                setS((p) => ({
                  ...p,
                  ollama: { ...p.ollama, ollamaUrl: { value: v, testStatus: "idle" } },
                }))
              }
            />
            <TestRow
              status={s.ollama.ollamaUrl.testStatus}
              message={s.ollama.ollamaUrl.testMessage}
              onTest={testOllama}
            />
            {s.ollama.ollamaUrl.testStatus === "ok" && s.ollama.hasNomic === false && (
              <Note color={C.gold}>
                Ollama erreicht — aber `nomic-embed-text` fehlt. Führ aus:
                <code style={{ display: "block", marginTop: 6, padding: 8, background: C.elevated, fontFamily: FONT.mono, fontSize: 12 }}>
                  ollama pull nomic-embed-text
                </code>
              </Note>
            )}
            <NextRow
              enabled={s.ollama.ollamaUrl.testStatus === "ok"}
              onNext={() => setStep("admin")}
            />
          </StepShell>
        )}

        {s.step === "admin" && (
          <StepShell title="Admin-Account" description="Erster Nutzer mit Admin-Rolle.">
            <Field label="Name" value={s.admin.name} onChange={(v) => setS((p) => ({ ...p, admin: { ...p.admin, name: v } }))} />
            <Field label="E-Mail" value={s.admin.email} onChange={(v) => setS((p) => ({ ...p, admin: { ...p.admin, email: v } }))} />
            <Field type="password" label="Passwort" value={s.admin.password} onChange={(v) => setS((p) => ({ ...p, admin: { ...p.admin, password: v } }))} />
            <ActionRow
              busy={s.admin.submitState === "submitting"}
              done={s.admin.submitState === "ok"}
              error={s.admin.submitState === "fail" ? s.admin.error : undefined}
              label="Admin anlegen"
              onClick={submitAdmin}
            />
            <NextRow
              enabled={s.admin.submitState === "ok"}
              onNext={() => setStep("vault")}
            />
          </StepShell>
        )}

        {s.step === "vault" && (
          <StepShell title="Erster Vault" description="Wird dem Admin-Nutzer als Personal-Vault zugewiesen.">
            <Field label="Vault-Name" value={s.vault.name} onChange={(v) => setS((p) => ({ ...p, vault: { ...p.vault, name: v } }))} />
            <Field label="Slug (URL-tauglich)" value={s.vault.slug} onChange={(v) => setS((p) => ({ ...p, vault: { ...p.vault, slug: v } }))} />
            <Note color={C.textDim}>
              Forgejo-Remote: <span style={{ color: C.text, fontFamily: FONT.mono, fontSize: 12 }}>{s.forgejo.gitRemote.value}</span>
            </Note>
            <ActionRow
              busy={s.vault.submitState === "submitting"}
              done={s.vault.submitState === "ok"}
              error={s.vault.submitState === "fail" ? s.vault.error : undefined}
              label="Vault anlegen"
              onClick={submitVault}
            />
            <NextRow
              enabled={s.vault.submitState === "ok"}
              onNext={() => setStep("done")}
              label="Setup abschließen"
            />
          </StepShell>
        )}

        {s.step === "done" && (
          <StepShell title="Setup abschließen" description="Alle Vorbedingungen erfüllt. Letzter Schritt: Setup-Flag setzen und das System scharf schalten.">
            <button
              onClick={completeSetup}
              style={{
                ...btnStyle,
                background: C.accent,
                color: "#0f0a06",
                fontWeight: 600,
                padding: "12px 20px",
                marginTop: 12,
              }}
            >
              Setup abschließen →
            </button>
          </StepShell>
        )}
      </main>

      <footer style={{ marginTop: 24, color: C.textFaint, fontSize: 12 }}>
        Schritt {stepIdx + 1} von {STEP_ORDER.length} — lokyy-brain
      </footer>
    </div>
  );
}

function Stepper({ step }: { step: StepKey }) {
  return (
    <ol
      style={{
        display: "flex",
        gap: 8,
        listStyle: "none",
        padding: 0,
        margin: 0,
        flexWrap: "wrap",
      }}
    >
      {STEP_ORDER.map((k, i) => {
        const active = k === step;
        const passed = STEP_ORDER.indexOf(step) > i;
        return (
          <li
            key={k}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 12,
              border: `1px solid ${active ? C.accent : passed ? C.ok : C.border}`,
              background: active ? C.accentDim : "transparent",
              color: active ? C.accent : passed ? C.ok : C.textDim,
              fontFamily: FONT.mono,
            }}
          >
            {i + 1}. {STEP_LABEL[k]}
          </li>
        );
      })}
    </ol>
  );
}

function StepShell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 style={{ fontFamily: FONT.serif, fontSize: 22, margin: 0, color: C.text }}>{title}</h2>
      <p style={{ color: C.textDim, marginTop: 6, marginBottom: 20 }}>{description}</p>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4, fontFamily: FONT.mono, letterSpacing: 0.5 }}>
        {label}
      </div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          padding: "10px 12px",
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

function TestRow({
  status,
  message,
  onTest,
}: {
  status: FieldState["testStatus"];
  message?: string;
  onTest: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
      <button onClick={onTest} disabled={status === "testing"} style={btnStyle}>
        {status === "testing" ? <Loader2 size={14} className="sw-spin" /> : null}
        Test
      </button>
      {status === "ok" && (
        <span style={{ color: C.ok, display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
          <Check size={14} /> {message ?? "OK"}
        </span>
      )}
      {status === "fail" && (
        <span style={{ color: C.err, display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
          <X size={14} /> {message ?? "Fehler"}
        </span>
      )}
    </div>
  );
}

function ActionRow({
  busy,
  done,
  error,
  label,
  onClick,
}: {
  busy: boolean;
  done: boolean;
  error?: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
      <button onClick={onClick} disabled={busy || done} style={btnStyle}>
        {busy ? <Loader2 size={14} className="sw-spin" /> : null}
        {done ? "Angelegt" : label}
      </button>
      {done && <Check size={14} color={C.ok} />}
      {error && (
        <span style={{ color: C.err, fontSize: 13 }}>
          <X size={14} /> {error}
        </span>
      )}
    </div>
  );
}

function NextRow({ enabled, onNext, label = "Weiter" }: { enabled: boolean; onNext: () => void; label?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 24 }}>
      <button
        disabled={!enabled}
        onClick={onNext}
        style={{
          ...btnStyle,
          background: enabled ? C.accent : C.elevated,
          color: enabled ? "#0f0a06" : C.textDim,
          opacity: enabled ? 1 : 0.5,
          fontWeight: 600,
        }}
      >
        {label} <ArrowRight size={14} />
      </button>
    </div>
  );
}

function Note({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div
      style={{
        padding: 10,
        marginTop: 8,
        background: C.elevated,
        borderRadius: 6,
        color,
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
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

function SetupHelpPanel({
  info,
  onRecheck,
  onCopy,
  copiedKey,
}: {
  info: ForgejoInfo;
  onRecheck: () => void;
  onCopy: (text: string, key: string) => void;
  copiedKey: string | null;
}) {
  const appsUrl = info.baseUrl ? `${info.baseUrl.replace(/\/$/, "")}/user/settings/applications` : null;

  return (
    <div
      style={{
        padding: 24,
        background: C.elevated,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        marginTop: 8,
      }}
    >
      <h3 style={{ fontFamily: FONT.serif, fontSize: 18, margin: 0, color: C.text }}>
        Forgejo OAuth-App einrichten
      </h3>
      <p style={{ color: C.textDim, marginTop: 8, marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
        lokyy-brain authentifiziert sich per OAuth2 gegen deine Forgejo-Instanz — kein Token-Paste mehr,
        kein SSH-Key. Lege einmalig eine OAuth-App in Forgejo an und trage die beiden Werte
        in Coolify als Environment-Variablen ein.
      </p>

      <ol style={{ paddingLeft: 20, margin: 0, color: C.text, fontSize: 13, lineHeight: 1.7 }}>
        <li style={{ marginBottom: 12 }}>
          Öffne{" "}
          {appsUrl ? (
            <a
              href={appsUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: C.accent, display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <span style={{ fontFamily: FONT.mono, fontSize: 12 }}>{appsUrl}</span>
              <ExternalLink size={12} />
            </a>
          ) : (
            <span style={{ color: C.textDim }}>
              <code style={{ fontFamily: FONT.mono, fontSize: 12 }}>deine Forgejo-Instanz</code> →{" "}
              <code style={{ fontFamily: FONT.mono, fontSize: 12 }}>/user/settings/applications</code>
            </span>
          )}
          .
        </li>
        <li style={{ marginBottom: 12 }}>
          Section{" "}
          <code style={{ fontFamily: FONT.mono, fontSize: 12, color: C.gold }}>
            Manage OAuth2 Applications
          </code>{" "}
          →{" "}
          <code style={{ fontFamily: FONT.mono, fontSize: 12, color: C.gold }}>
            Create a new OAuth2 Application
          </code>
          .
        </li>
        <li style={{ marginBottom: 12 }}>
          Eingaben — beide Werte exakt so übernehmen (Redirect URI muss byte-identisch sein):
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            <CopyField
              label="Application Name"
              value="lokyy-brain"
              copyKey="app-name"
              copied={copiedKey === "app-name"}
              onCopy={onCopy}
            />
            <CopyField
              label="Redirect URI"
              value={info.redirectUri}
              copyKey="redirect-uri"
              copied={copiedKey === "redirect-uri"}
              onCopy={onCopy}
            />
          </div>
        </li>
        <li style={{ marginBottom: 12 }}>
          Häkchen{" "}
          <code style={{ fontFamily: FONT.mono, fontSize: 12, color: C.gold }}>Confidential Client</code>{" "}
          angelassen → <strong>Save</strong>.
        </li>
        <li style={{ marginBottom: 12 }}>
          Forgejo zeigt nun <strong>Client ID</strong> und <strong>Client Secret</strong>. Beide in
          Coolify → App → Environment Variables setzen:
          <ul style={{ paddingLeft: 18, marginTop: 8, listStyle: "disc", color: C.textDim, fontSize: 13 }}>
            <li>
              <code style={{ fontFamily: FONT.mono, fontSize: 12, color: C.text }}>FORGEJO_BASE_URL</code>{" "}
              = Forgejo-URL (z.B.{" "}
              <code style={{ fontFamily: FONT.mono, fontSize: 12 }}>https://forgejo.paione.de</code>)
            </li>
            <li>
              <code style={{ fontFamily: FONT.mono, fontSize: 12, color: C.text }}>FORGEJO_OAUTH_CLIENT_ID</code>{" "}
              = Client ID
            </li>
            <li>
              <code style={{ fontFamily: FONT.mono, fontSize: 12, color: C.text }}>FORGEJO_OAUTH_CLIENT_SECRET</code>{" "}
              = Client Secret
            </li>
          </ul>
        </li>
        <li>
          App in Coolify <strong>Redeploy</strong> → diese Seite neu laden bzw. Status erneut prüfen.
        </li>
      </ol>

      <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
        <button onClick={onRecheck} style={btnStyle}>
          <RefreshCw size={14} /> Status erneut prüfen
        </button>
      </div>
    </div>
  );
}

function CopyField({
  label,
  value,
  copyKey,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copyKey: string;
  copied: boolean;
  onCopy: (text: string, key: string) => void;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: C.textDim,
          marginBottom: 4,
          fontFamily: FONT.mono,
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: 1,
            padding: "8px 10px",
            background: C.bg,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            color: C.text,
            fontFamily: FONT.mono,
            fontSize: 12,
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={() => onCopy(value, copyKey)}
          style={{ ...btnStyle, padding: "0 10px" }}
          title="In Zwischenablage kopieren"
        >
          {copied ? <Check size={14} color={C.ok} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

function ConnectCta({ info }: { info: ForgejoInfo }) {
  return (
    <div
      style={{
        padding: 24,
        background: C.elevated,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        marginTop: 8,
        textAlign: "center",
      }}
    >
      <h3 style={{ fontFamily: FONT.serif, fontSize: 18, margin: 0, color: C.text }}>
        Mit Forgejo verbinden
      </h3>
      <p style={{ color: C.textDim, marginTop: 8, marginBottom: 16, fontSize: 13 }}>
        Client-ID:{" "}
        <span style={{ color: C.text, fontFamily: FONT.mono, fontSize: 12 }}>
          {info.clientIdPreview || "(unbekannt)"}
        </span>
        {info.baseUrl && (
          <>
            {" · "}
            <span style={{ color: C.text, fontFamily: FONT.mono, fontSize: 12 }}>{info.baseUrl}</span>
          </>
        )}
      </p>
      <button
        onClick={() => {
          window.location.href = "/api/auth/forgejo/start";
        }}
        style={{
          ...btnStyle,
          background: C.accent,
          color: "#0f0a06",
          fontWeight: 600,
          padding: "12px 20px",
        }}
      >
        Mit Forgejo verbinden <ArrowRight size={14} />
      </button>
      <p style={{ color: C.textFaint, marginTop: 14, marginBottom: 0, fontSize: 12 }}>
        Du wirst zu deinem Forgejo umgeleitet und nach dem Login zur Bestätigung gefragt.
      </p>
    </div>
  );
}

function RepoPicker({
  conn,
  repos,
  reposBusy,
  reposErr,
  onReloadRepos,
  mode,
  onModeChange,
  selected,
  onPick,
  newRepoName,
  setNewRepoName,
  newRepoPrivate,
  setNewRepoPrivate,
  newRepoBusy,
  newRepoErr,
  onCreate,
}: {
  conn: ForgejoConnection;
  repos: ForgejoRepo[] | null;
  reposBusy: boolean;
  reposErr?: string;
  onReloadRepos: () => void;
  mode: ForgejoMode;
  onModeChange: (m: ForgejoMode) => void;
  selected: ForgejoRepo | null;
  onPick: (repo: ForgejoRepo) => void;
  newRepoName: string;
  setNewRepoName: (v: string) => void;
  newRepoPrivate: boolean;
  setNewRepoPrivate: (v: boolean) => void;
  newRepoBusy: boolean;
  newRepoErr?: string;
  onCreate: () => void;
}) {
  return (
    <div style={{ marginTop: 4 }}>
      <h3 style={{ fontFamily: FONT.serif, fontSize: 18, margin: 0, color: C.text }}>
        Repository auswählen
      </h3>
      <p style={{ color: C.textDim, marginTop: 6, marginBottom: 16, fontSize: 13 }}>
        Verbunden als{" "}
        <span style={{ color: C.text, fontFamily: FONT.mono, fontSize: 12 }}>
          {conn.forgejoUserLogin ?? "?"}
        </span>{" "}
        ({conn.baseUrl ?? "?"}).
      </p>

      <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
          <input
            type="radio"
            name="forgejo-mode"
            checked={mode === "existing"}
            onChange={() => onModeChange("existing")}
          />
          Vorhandenes Repo nutzen
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
          <input
            type="radio"
            name="forgejo-mode"
            checked={mode === "new"}
            onChange={() => onModeChange("new")}
          />
          Neues Repo anlegen
        </label>
      </div>

      {mode === "existing" && (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 11,
              color: C.textDim,
              marginBottom: 4,
              fontFamily: FONT.mono,
              letterSpacing: 0.5,
            }}
          >
            REPO
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <select
              value={selected?.full_name ?? ""}
              onChange={(e) => {
                const repo = (repos ?? []).find((r) => r.full_name === e.target.value);
                if (repo) onPick(repo);
              }}
              disabled={reposBusy}
              style={{
                flex: 1,
                padding: "10px 12px",
                background: C.elevated,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                color: C.text,
                fontFamily: FONT.mono,
                fontSize: 13,
                outline: "none",
              }}
            >
              <option value="" disabled>
                {reposBusy
                  ? "Lade Repos …"
                  : repos && repos.length === 0
                    ? "Keine Repos gefunden — leg ein neues an."
                    : "— bitte wählen —"}
              </option>
              {(repos ?? []).map((r) => (
                <option key={r.full_name} value={r.full_name}>
                  {r.full_name}
                  {r.private ? " (private)" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onReloadRepos}
              disabled={reposBusy}
              style={{ ...btnStyle, padding: "0 10px" }}
              title="Repo-Liste neu laden"
            >
              {reposBusy ? <Loader2 size={14} className="sw-spin" /> : <RefreshCw size={14} />}
            </button>
          </div>
          {reposErr && (
            <div style={{ marginTop: 6, color: C.err, fontSize: 12 }}>
              <X size={12} /> {reposErr}
            </div>
          )}
        </div>
      )}

      {mode === "new" && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", marginBottom: 12 }}>
            <div
              style={{
                fontSize: 11,
                color: C.textDim,
                marginBottom: 4,
                fontFamily: FONT.mono,
                letterSpacing: 0.5,
              }}
            >
              REPO-NAME
            </div>
            <input
              type="text"
              value={newRepoName}
              onChange={(e) => setNewRepoName(e.target.value)}
              placeholder="lokyy-vault"
              style={{
                width: "100%",
                padding: "10px 12px",
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
          <label
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
              fontSize: 13,
              cursor: "pointer",
              marginBottom: 12,
            }}
          >
            <input
              type="checkbox"
              checked={newRepoPrivate}
              onChange={(e) => setNewRepoPrivate(e.target.checked)}
            />
            Privat (empfohlen)
          </label>
          <button
            type="button"
            onClick={onCreate}
            disabled={newRepoBusy || !newRepoName.trim()}
            style={btnStyle}
          >
            {newRepoBusy ? <Loader2 size={14} className="sw-spin" /> : null}
            Anlegen
          </button>
          {newRepoErr && (
            <div style={{ marginTop: 6, color: C.err, fontSize: 12 }}>
              <X size={12} /> {newRepoErr}
            </div>
          )}
        </div>
      )}

      {selected && (
        <div
          style={{
            marginTop: 12,
            padding: 14,
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            fontSize: 13,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: C.ok }}>
            <Check size={14} /> Repo ausgewählt
          </div>
          <div>
            <span style={{ color: C.textDim }}>Repository: </span>
            <span style={{ fontFamily: FONT.mono, fontSize: 12 }}>{selected.full_name}</span>
          </div>
          <div>
            <span style={{ color: C.textDim }}>Default-Branch: </span>
            <span style={{ fontFamily: FONT.mono, fontSize: 12 }}>{selected.default_branch}</span>
          </div>
          <div>
            <a
              href={selected.html_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: C.accent, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
            >
              In Forgejo öffnen <ExternalLink size={12} />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
