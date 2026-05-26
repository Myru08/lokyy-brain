import { useState } from "react";
import { Loader2, LogIn, UserPlus } from "lucide-react";
import { C, FONT } from "./theme.js";

/**
 * Login/Register screen (Story 3.6). Mounted by AuthGate when /api/auth/me
 * returns 401. On success the cookie is set and the AuthGate re-checks,
 * unmounts this, and renders the App shell.
 */
export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body =
        mode === "login"
          ? { email, password }
          : { email, password, name };
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fehler");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: C.bg,
        color: C.text,
        fontFamily: FONT.ui,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 360,
          padding: 32,
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
        }}
      >
        <img
          src="/logo-header.png"
          alt="lokyy-brain"
          style={{ display: "block", margin: "0 auto 4px", maxWidth: 140, width: "100%", height: "auto" }}
        />
        <p style={{ color: C.textDim, marginTop: 4, marginBottom: 24, fontSize: 13, textAlign: "center" }}>
          {mode === "login" ? "Anmelden" : "Account anlegen"}
        </p>

        {mode === "register" && (
          <Field label="Name" value={name} onChange={setName} />
        )}
        <Field label="E-Mail" value={email} onChange={setEmail} type="email" />
        <Field
          label="Passwort"
          value={password}
          onChange={setPassword}
          type="password"
          onEnter={submit}
        />

        {error && (
          <div style={{ color: C.err, fontSize: 12, marginBottom: 10 }}>{error}</div>
        )}

        <button
          onClick={submit}
          disabled={busy || !email || !password || (mode === "register" && !name)}
          style={{
            width: "100%",
            padding: "10px 14px",
            background: C.accent,
            color: "#0f0a06",
            border: "none",
            borderRadius: 6,
            fontFamily: FONT.ui,
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginTop: 4,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? <Loader2 size={14} className="sw-spin" /> : mode === "login" ? <LogIn size={14} /> : <UserPlus size={14} />}
          {mode === "login" ? "Anmelden" : "Account anlegen"}
        </button>

        <button
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
          style={{
            background: "transparent",
            border: "none",
            color: C.textDim,
            fontSize: 12,
            cursor: "pointer",
            marginTop: 16,
            display: "block",
            width: "100%",
            textAlign: "center",
          }}
        >
          {mode === "login" ? "Noch keinen Account? Registrieren →" : "← Zurück zum Login"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  onEnter,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  onEnter?: () => void;
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
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
        autoComplete={type === "password" ? "current-password" : "email"}
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
