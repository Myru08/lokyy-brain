import { useContext, useState } from "react";
import { SessionUserContext } from "../AuthGate.js";
import { type SystemVersion } from "../api.js";
import { C, FONT } from "../theme.js";
import { Highlights } from "./Highlights.js";
import { dismiss, isDismissed } from "./dismissal.js";
import { UpdateProgress } from "./UpdateProgress.js";
import { useUpdateFlow } from "./useUpdateFlow.js";

/**
 * Story 7.12 Task 5 — the update notice in the app shell (AC#2, #5, #10, #11).
 *
 * Visible only when the server says an update exists AND the session is an
 * admin. Closable per version, so dismissing v1.12 does not silence v1.13.
 * When the installation cannot update itself (Coolify: no updater sidecar),
 * the banner still appears but carries a sentence instead of a button — a
 * dead button is explicitly not an acceptable answer.
 */

const MAX_HIGHLIGHTS_COLLAPSED = 4;

export function UpdateBanner({ version }: { version: SystemVersion | null }) {
  const sessionUser = useContext(SessionUserContext);
  const isAdmin = sessionUser?.role === "admin";
  const latest = version?.latest ?? null;
  const shouldShow = !!version?.updateAvailable && !!latest && isAdmin;

  const [closed, setClosed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // The probe, the POST and the job we follow all live in `useUpdateFlow` —
  // shared with the version card in Einstellungen → System, which offers the
  // same action from a different place. `shouldShow` gates the probe: it only
  // runs when the notice is actually going up.
  const { capability, canUpdate, cannotUpdate, blockers, job, starting, startError, start, closeJob } =
    useUpdateFlow(shouldShow);

  if (job) {
    return <UpdateProgress jobId={job.id} initialJob={job.snapshot} onClose={closeJob} />;
  }

  if (!shouldShow || closed || isDismissed(latest)) return null;

  const highlights = version?.highlights ?? [];
  const shown = expanded ? highlights : highlights.slice(0, MAX_HIGHLIGHTS_COLLAPSED);

  return (
    <div
      role="status"
      aria-label="Neue Version verfügbar"
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        padding: "12px 14px",
        background: C.elevated,
        borderBottom: `1px solid ${C.border}`,
        borderLeft: `3px solid ${C.accent}`,
        color: C.text,
        fontFamily: FONT.ui,
        flexShrink: 0,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 14 }}>Neue Version verfügbar</strong>
          <span style={{ fontSize: 12, color: C.textDim, fontFamily: FONT.mono }}>
            {version?.running ?? "unbekannt"} → {latest}
          </span>
        </div>

        {highlights.length > 0 && (
          <>
            <Highlights items={shown} />
            {highlights.length > MAX_HIGHLIGHTS_COLLAPSED && (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                style={{
                  alignSelf: "flex-start",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  color: C.accent,
                  fontSize: 12,
                  cursor: "pointer",
                  fontFamily: FONT.ui,
                }}
              >
                {expanded ? "weniger anzeigen" : "alle Änderungen anzeigen"}
              </button>
            )}
          </>
        )}

        <p style={{ margin: 0, fontSize: 12, color: C.textDim, lineHeight: 1.5 }}>
          Deine Notizen, deine Datenbank und deine Einstellungen bleiben beim
          Update unangetastet. Der Vorgang dauert mehrere Minuten.
        </p>

        {/* AC#11 — no self-update here: a sentence, never a dead button. The
            sentence comes from the server, which knows WHY (managed / off /
            blocked / unreachable); we only fall back if it sent none. */}
        {cannotUpdate && (
          <p style={{ margin: 0, fontSize: 12, color: C.gold, lineHeight: 1.5 }}>
            {capability?.message ??
              "Diese Installation wird über deine Deploy-Plattform aktualisiert. " +
                "Starte das Update dort — hier gibt es bewusst keinen Knopf."}
          </p>
        )}

        {/* `blocked` means an updater IS there but is misconfigured — that is
            actionable, so the concrete reasons are shown. Every other reason
            gets the sentence alone. */}
        {cannotUpdate && capability?.reason === "blocked" && blockers.length > 0 && (
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12,
              color: C.textDim,
              lineHeight: 1.5,
            }}
          >
            {blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        )}

        {startError && (
          <p style={{ margin: 0, fontSize: 12, color: C.err, lineHeight: 1.5 }}>{startError}</p>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {canUpdate && (
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting}
            style={{
              background: C.accent,
              border: `1px solid ${C.accent}`,
              color: "#13171D",
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: starting ? "default" : "pointer",
              opacity: starting ? 0.6 : 1,
              fontFamily: FONT.ui,
              whiteSpace: "nowrap",
            }}
          >
            {starting ? "Startet …" : "Jetzt aktualisieren"}
          </button>
        )}
        <button
          type="button"
          aria-label="Hinweis schließen"
          title="Hinweis für diese Version ausblenden"
          onClick={() => {
            dismiss(latest);
            setClosed(true);
          }}
          style={{
            background: "transparent",
            border: "none",
            color: C.textDim,
            fontSize: 18,
            lineHeight: 1,
            cursor: "pointer",
            padding: "4px 6px",
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
