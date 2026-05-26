import { useEffect, useState } from "react";
import { Check, X, Loader2, ArrowRight } from "lucide-react";
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

export function SetupWizard({ onDone }: { onDone: () => void }) {
  const [s, setS] = useState<WizardState>(initialState);

  const stepIdx = STEP_ORDER.indexOf(s.step);

  function setStep(step: StepKey) {
    setS((p) => ({ ...p, step }));
  }

  async function testForgejo() {
    setS((p) => ({
      ...p,
      forgejo: { ...p.forgejo, gitRemote: { ...p.forgejo.gitRemote, testStatus: "testing" } },
    }));
    const res = await postJson<{ ok: boolean; error?: string }>("/test-forgejo", {
      gitRemote: s.forgejo.gitRemote.value,
      gitBranch: s.forgejo.gitBranch,
    });
    setS((p) => ({
      ...p,
      forgejo: {
        ...p.forgejo,
        gitRemote: {
          ...p.forgejo.gitRemote,
          testStatus: res.ok ? "ok" : "fail",
          testMessage: res.error,
        },
      },
    }));
  }

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
            description="Die Vault-Wahrheit liegt in einem git-Repo. Trage hier dein Forgejo-Remote (SSH empfohlen)."
          >
            <Field
              label="GIT_REMOTE"
              value={s.forgejo.gitRemote.value}
              onChange={(v) =>
                setS((p) => ({
                  ...p,
                  forgejo: { ...p.forgejo, gitRemote: { value: v, testStatus: "idle" } },
                }))
              }
              placeholder="git@forgejo.example.com:oliver/vault.git"
            />
            <Field
              label="GIT_BRANCH"
              value={s.forgejo.gitBranch}
              onChange={(v) => setS((p) => ({ ...p, forgejo: { ...p.forgejo, gitBranch: v } }))}
            />
            <TestRow
              status={s.forgejo.gitRemote.testStatus}
              message={s.forgejo.gitRemote.testMessage}
              onTest={testForgejo}
            />
            <NextRow
              enabled={s.forgejo.gitRemote.testStatus === "ok"}
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
