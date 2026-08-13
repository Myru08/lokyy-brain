import { createContext, useEffect, useState } from "react";
import { Login } from "./Login.js";
import { clearDataCaches, UNAUTHENTICATED_EVENT } from "./api.js";
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
        // A real HTTP answer that isn't OK means the session is gone: a 401
        // from an expired/revoked cookie, or an explicit logout that reloaded
        // the page (the logout POST clears the cookie, so this GET now 401s).
        // Either way the cached vault data belongs to a logged-out state, so
        // purge the runtime caches before dropping to the login screen — a
        // locally-readable copy would undercut the access gate. A NETWORK
        // failure lands in the `catch` below and must NOT clear (offline is a
        // feature, see clearDataCaches).
        await clearDataCaches();
        setState("guest");
        return;
      }
      const user = (await res.json()) as SessionUser;
      setState({ user });
    } catch {
      // Fetch threw → offline / server unreachable. Keep the caches so the
      // offline experience survives; just fall back to the login screen.
      setState("guest");
    }
  }

  useEffect(() => {
    void check();
  }, []);

  /**
   * A 401 from any API call means this session is gone — expired, revoked, or
   * the server was reinstalled. Since the auth sweep (issue #37) that applies to
   * every data route, so the honest response is to show the login screen again
   * rather than let the shell render on top of an API that answers nothing.
   *
   * Re-checking instead of trusting the event keeps one stray 401 from throwing
   * out a session that is actually fine (a route the user has no rights for,
   * say): `/api/auth/me` is the authority, this is only the trigger.
   */
  useEffect(() => {
    const onUnauthenticated = () => void check();
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
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
