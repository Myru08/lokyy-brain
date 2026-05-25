import { useEffect, useState } from "react";
import { SetupWizard } from "./SetupWizard.js";
import { C, FONT } from "./theme.js";

/**
 * Setup gate (Story 1.11).
 *
 * Polls /api/setup/status. If `setupComplete === false`, intercepts the
 * entire app and renders the SetupWizard. Otherwise renders children
 * (the normal App shell).
 */
export function SetupGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "needs-setup" | "ready">(
    "loading",
  );

  async function check() {
    try {
      const res = await fetch("/api/setup/status");
      const data = (await res.json()) as { setupComplete: boolean };
      setState(data.setupComplete ? "ready" : "needs-setup");
    } catch {
      // Backend down — render children, they'll show their own error states.
      setState("ready");
    }
  }

  useEffect(() => {
    void check();
  }, []);

  if (state === "loading") {
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
        }}
      >
        lokyy-brain · prüfe Setup-Status …
      </div>
    );
  }

  if (state === "needs-setup") {
    return <SetupWizard onDone={() => window.location.reload()} />;
  }

  return <>{children}</>;
}
