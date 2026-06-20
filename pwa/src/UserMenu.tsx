import { useContext, useEffect, useRef, useState } from "react";
import { LogOut, User as UserIcon } from "lucide-react";
import { SessionUserContext } from "./AuthGate.js";
import { C, FONT } from "./theme.js";

/**
 * Profile + logout menu (top bar). Shows the logged-in operator's name/email/
 * role and a logout action. Logout POSTs /api/auth/logout (clears the session
 * cookie server-side) then reloads — AuthGate re-checks /api/auth/me, gets 401,
 * and renders the login screen.
 */
const TOUCH_MIN = 44;

function initials(name: string, email: string): string {
  const base = (name || email || "?").trim();
  const parts = base.split(/[\s@._-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts[1]?.[0] ?? "";
  return (a + b).toUpperCase();
}

export function UserMenu({ isMobile }: { isMobile: boolean }) {
  const user = useContext(SessionUserContext);
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  // The top bar (<header>) has `overflow: hidden`, which would clip an
  // absolutely-positioned dropdown. We render it `position: fixed` against the
  // viewport using the trigger's measured rect, so it escapes the clip.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  function toggle() {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    }
    setOpen((o) => !o);
  }

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!user) return null;

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      /* even if the call fails, drop the client + force re-auth */
    }
    window.location.reload();
  }

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={toggle}
        title={user.name || user.email}
        aria-label="Profil"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: C.elevated,
          border: `1px solid ${open ? C.accent : C.border}`,
          borderRadius: 7,
          padding: isMobile ? "0" : "4px 8px",
          width: isMobile ? TOUCH_MIN : undefined,
          height: isMobile ? TOUCH_MIN : undefined,
          minHeight: 36,
          cursor: "pointer",
          color: C.text,
          gap: 7,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: C.accent,
            color: "#000",
            fontSize: 11,
            fontWeight: 700,
            fontFamily: FONT.ui,
            flexShrink: 0,
          }}
        >
          {initials(user.name, user.email)}
        </span>
        {!isMobile && (
          <span
            style={{
              fontSize: 13,
              maxWidth: 120,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {user.name || user.email}
          </span>
        )}
      </button>

      {open && pos && (
        <div
          style={{
            position: "fixed",
            right: pos.right,
            top: pos.top,
            minWidth: 240,
            background: C.panel,
            border: `1px solid ${C.borderStrong}`,
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
            zIndex: 60,
            overflow: "hidden",
          }}
        >
          {/* Profil-Kopf */}
          <div style={{ padding: "14px 16px", display: "flex", gap: 12, alignItems: "center" }}>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 40,
                height: 40,
                borderRadius: "50%",
                background: C.accent,
                color: "#000",
                fontSize: 15,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {initials(user.name, user.email)}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: C.text, fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {user.name || "—"}
              </div>
              <div style={{ color: C.textDim, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {user.email}
              </div>
              <div style={{ color: C.gold, fontSize: 11, marginTop: 2, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <UserIcon size={11} style={{ display: "inline", verticalAlign: "-1px", marginRight: 4 }} />
                {user.role}
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: C.border }} />

          <button
            onClick={() => void logout()}
            disabled={loggingOut}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "transparent",
              border: "none",
              color: C.err,
              padding: "12px 16px",
              cursor: "pointer",
              fontSize: 14,
              fontFamily: FONT.ui,
              textAlign: "left",
            }}
          >
            <LogOut size={16} />
            {loggingOut ? "Logge aus …" : "Ausloggen"}
          </button>
        </div>
      )}
    </div>
  );
}
