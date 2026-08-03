import { useContext, useEffect, useState } from "react";
import { SessionUserContext } from "../AuthGate.js";
import {
  UpdateApiError,
  api,
  type SystemVersion,
  type UpdateCapability,
  type UpdateJob,
} from "../api.js";
import { C, FONT } from "../theme.js";
import { Highlights } from "./Highlights.js";
import { dismiss, isDismissed } from "./dismissal.js";
import { UpdateProgress } from "./UpdateProgress.js";

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
  const [capability, setCapability] = useState<UpdateCapability | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** The job we are following: an id, plus the `POST` snapshot when we have it. */
  const [job, setJob] = useState<{ id: string; snapshot: UpdateJob | null } | null>(null);

  // Ask whether this installation can update ITSELF only when the notice is
  // actually going up — the probe reaches through to the updater sidecar and
  // has no business running on every page load for every user.
  useEffect(() => {
    if (!shouldShow) return;
    let cancelled = false;
    void api.getUpdateCapability().then((c) => {
      if (cancelled) return;
      setCapability(c);
      // A job is already running — the tab was reloaded mid-update, or the
      // brain restarted under us. Rejoin it instead of offering to start a
      // second one.
      if (c.currentJobId) setJob({ id: c.currentJobId, snapshot: null });
    });
    return () => {
      cancelled = true;
    };
  }, [shouldShow]);

  if (job) {
    return (
      <UpdateProgress
        jobId={job.id}
        initialJob={job.snapshot}
        onClose={() => setJob(null)}
      />
    );
  }

  if (!shouldShow || closed || isDismissed(latest)) return null;

  const canUpdate = capability?.canUpdate === true;
  // Only once we actually KNOW. While the answer is in flight there is neither
  // a button nor a claim about how this installation updates — asserting
  // either before we know would be a guess with a short half-life.
  const cannotUpdate = capability !== null && !canUpdate;
  const blockers = capability?.blockers ?? [];
  const highlights = version?.highlights ?? [];
  const shown = expanded ? highlights : highlights.slice(0, MAX_HIGHLIGHTS_COLLAPSED);

  async function start(): Promise<void> {
    setStarting(true);
    setStartError(null);
    try {
      const started = await api.startUpdate();
      setJob({ id: started.id, snapshot: started });
    } catch (err) {
      // A 409 means exactly one thing — a job is already running — because the
      // server split "blocked" out into a 503. So: attach, never report.
      if (err instanceof UpdateApiError && err.currentJobId) {
        setJob({ id: err.currentJobId, snapshot: null });
        return;
      }
      setStartError(
        err instanceof Error && err.message
          ? err.message
          : "Das Update konnte nicht gestartet werden.",
      );
    } finally {
      setStarting(false);
    }
  }

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
