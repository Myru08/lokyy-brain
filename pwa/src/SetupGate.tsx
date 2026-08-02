import { useEffect, useState } from "react";
import { SetupWizard } from "./SetupWizard.js";
import { C, FONT } from "./theme.js";

/**
 * Setup gate (Story 1.11, hardened in Story 1.21).
 *
 * Polls /api/setup/status. If `setupComplete === false`, intercepts the
 * entire app and renders the SetupWizard. Otherwise renders children
 * (the normal App shell).
 *
 * Story 1.21 — why the retry loop exists:
 * The old `catch` fell through to `setState("ready")`, i.e. a FAILED status
 * request was treated as "setup is complete". On a fresh install the static
 * PWA is served by nginx long before the brain has finished migrating, so
 * the very first status fetch fails and the user landed on the LOGIN form
 * with no credentials to enter. A failed fetch says nothing about the setup
 * state — so we retry instead of guessing, and never fall silently into the
 * children/login branch.
 */

/**
 * Retry bounds. 20 attempts × 1.5 s ≈ 30 s of patience — comfortably longer
 * than a normal cold boot (container start + DB migration), short enough that
 * a genuinely dead backend surfaces an explicit error instead of spinning
 * forever. Overridable via props so tests don't have to wait in real time.
 */
const RETRY_DELAY_MS = 1500;
const MAX_ATTEMPTS = 20;

type GateState = "loading" | "waiting" | "needs-setup" | "ready" | "error";

export function SetupGate({
  children,
  retryDelayMs = RETRY_DELAY_MS,
  maxAttempts = MAX_ATTEMPTS,
}: {
  children: React.ReactNode;
  retryDelayMs?: number;
  maxAttempts?: number;
}) {
  const [state, setState] = useState<GateState>("loading");
  const [attempt, setAttempt] = useState(1);
  // Bumped by the "retry" button to re-run the effect from scratch.
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(n: number) {
      try {
        const res = await fetch("/api/setup/status");
        // A 502 from nginx while the brain boots is a failure, not an answer.
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { setupComplete: boolean };
        if (cancelled) return;
        setState(data.setupComplete ? "ready" : "needs-setup");
      } catch {
        if (cancelled) return;
        if (n >= maxAttempts) {
          setState("error");
          return;
        }
        setState("waiting");
        setAttempt(n + 1);
        timer = setTimeout(() => void poll(n + 1), retryDelayMs);
      }
    }

    setState("loading");
    setAttempt(1);
    void poll(1);

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [retryDelayMs, maxAttempts, retryToken]);

  if (state === "loading" || state === "waiting") {
    return (
      <Shell>
        {state === "loading"
          ? "lokyy-brain · prüfe Setup-Status …"
          : `lokyy-brain · warte auf den Server … (Versuch ${attempt}/${maxAttempts})`}
      </Shell>
    );
  }

  if (state === "error") {
    return (
      <Shell>
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <div style={{ color: C.text, marginBottom: 8 }}>
            Der Server antwortet nicht.
          </div>
          <div style={{ marginBottom: 16, lineHeight: 1.6 }}>
            lokyy-brain konnte den Setup-Status nicht abfragen. Läuft der
            Server schon? Prüfe den Status mit{" "}
            <code>docker compose ps</code> und versuche es dann erneut.
          </div>
          <button
            type="button"
            onClick={() => setRetryToken((t) => t + 1)}
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              color: C.accent,
              cursor: "pointer",
              fontFamily: FONT.mono,
              fontSize: 13,
              padding: "8px 16px",
            }}
          >
            Erneut versuchen
          </button>
        </div>
      </Shell>
    );
  }

  if (state === "needs-setup") {
    return <SetupWizard onDone={() => window.location.reload()} />;
  }

  return <>{children}</>;
}

/** Full-viewport centred frame shared by the loading/waiting/error states. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: C.bg,
        color: C.textDim,
        fontFamily: FONT.mono,
        fontSize: 13,
        padding: 24,
      }}
    >
      {children}
    </div>
  );
}
