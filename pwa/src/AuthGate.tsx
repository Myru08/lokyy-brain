import { createContext, useEffect, useState } from "react";
import { Login } from "./Login.js";
import { C, FONT } from "./theme.js";

interface SessionUser {
  userId: string;
  email: string;
  name: string;
  role: string;
}

export const SessionUserContext = createContext<SessionUser | null>(null);

/**
 * AuthGate (Story 3.6). Mounted INSIDE SetupGate. Checks /api/auth/me.
 * 401 → renders Login; success → renders children with user in context.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "guest" | { user: SessionUser }>(
    "loading",
  );

  async function check() {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) {
        setState("guest");
        return;
      }
      const user = (await res.json()) as SessionUser;
      setState({ user });
    } catch {
      setState("guest");
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
        lokyy-brain · prüfe Auth …
      </div>
    );
  }

  if (state === "guest") {
    return <Login onAuthed={() => void check()} />;
  }

  return (
    <SessionUserContext.Provider value={state.user}>
      {children}
    </SessionUserContext.Provider>
  );
}
