import { useEffect, useRef, useState } from "react";
import { api, type UpdateJob } from "../api.js";
import { C, FONT } from "../theme.js";
import { renewServiceWorker } from "./cacheRenewal.js";
import {
  INITIAL_POLL_STATE,
  PHASE_LABEL,
  PHASE_ORDER,
  classifyPollError,
  isFinished,
  isSuccess,
  nextPollState,
  resultMessage,
  type PollState,
} from "./pollState.js";

/**
 * Story 7.12 Task 5, AC#6 — the progress view.
 *
 * Two things matter more than looks here:
 *
 * 1. **A failed poll is a restart, not a failure.** The update replaces the
 *    container serving this very endpoint, so the connection WILL drop. The
 *    state machine in `pollState.ts` turns that into "startet neu …" and keeps
 *    asking; only 401/403 or five fruitless minutes become an error.
 * 2. **After success, the page renews itself** (AC#7 path b): ask the service
 *    worker for the new build and reload once it takes control, so nobody has
 *    to press Ctrl+Shift+R.
 *
 * Issue #32 added a third: **the view has to look alive.** „Bauen" can sit
 * there for many minutes, and a motionless orange dot is indistinguishable
 * from a frozen app — observed in the wild, people closed the window mid-build.
 * Three signals answer that, and none of them invents progress it cannot
 * measure: the active step pulses, the long step says up front that it is the
 * long one, and a clock counts up from the job's own start.
 */

const POLL_MS = 2000;

/** `mm:ss`, and past an hour simply `62:03` — never a wrap back to zero. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function Keyframes() {
  return (
    <style data-lokyy-update-anim>{`
      @keyframes lokyy-update-pulse {
        0%, 100% { opacity: 1;    transform: scale(1); }
        50%      { opacity: 0.35; transform: scale(0.72); }
      }
    `}</style>
  );
}

export function UpdateProgress({
  jobId,
  initialJob = null,
  onClose,
  /** Test seams — production uses the real API, timer and reload. */
  poll = (id: string) => api.getUpdateJob(id),
  pollMs = POLL_MS,
  renew = renewServiceWorker,
}: {
  /**
   * The job to follow. Given as an id rather than an object because we also
   * attach to jobs we never started: a 409 from `POST` and `currentJobId`
   * from the capability endpoint both hand us an id and nothing else. That is
   * how the UI finds its way back after the tab was reloaded mid-update.
   */
  jobId: string;
  /** The snapshot from `POST`, when we have one — avoids an empty first frame. */
  initialJob?: UpdateJob | null;
  onClose: () => void;
  poll?: (id: string) => Promise<UpdateJob>;
  pollMs?: number;
  renew?: (deps?: { reload?: () => void; fallbackMs?: number }) => Promise<void>;
}) {
  const [state, setState] = useState<PollState>({
    ...INITIAL_POLL_STATE,
    job: initialJob,
  });
  const [renewing, setRenewing] = useState(false);
  /** Re-read once per second — the only reason this component re-renders idle. */
  const [now, setNow] = useState(() => Date.now());
  // Guards the one-shot reload so a late poll can't trigger a second one.
  const renewedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      try {
        const job = await poll(jobId);
        if (cancelled) return;
        setState((prev) => nextPollState(prev, { kind: "job", job }));
        if (isFinished(job)) return; // terminal — stop polling
      } catch (err) {
        if (cancelled) return;
        const outcome = classifyPollError(err);
        let stop = false;
        setState((prev) => {
          const next = nextPollState(prev, outcome);
          stop = next.error !== null;
          return next;
        });
        if (stop) return;
      }
      timer = setTimeout(() => void tick(), pollMs);
    }

    // Attaching to a job we did not start (409 / `currentJobId`) means we hold
    // an id and nothing else — ask at once so the view is not blank.
    timer = setTimeout(() => void tick(), initialJob ? pollMs : 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `initialJob` is a first-frame seed only; re-running on a new object
    // identity would restart the poll loop for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, poll, pollMs]);

  // Success → pull the new shell in and reload. Once.
  useEffect(() => {
    if (renewedRef.current) return;
    if (state.job?.result !== "success") return;
    renewedRef.current = true;
    setRenewing(true);
    void renew();
  }, [state.job?.result, renew]);

  const job = state.job;
  const finished = isFinished(job);
  const outcome = job && finished ? resultMessage(job) : null;
  const activeIndex = job ? PHASE_ORDER.indexOf(job.phase) : -1;

  /**
   * The clock counts from the job's OWN `startedAt`, not from when this view
   * opened — otherwise a tab reloaded mid-update would restart at 00:00 and
   * quietly deny the ten minutes that already passed. Only when the server has
   * not (yet) given us a usable timestamp does the mount time stand in.
   */
  const startedFallback = useRef(Date.now());
  const parsed = Date.parse(job?.startedAt ?? "");
  const startedAtMs = Number.isNaN(parsed) ? startedFallback.current : parsed;
  const elapsed = formatElapsed(now - startedAtMs);
  const running = !finished && state.error === null;

  // Tick while it runs; freeze on the exact final value when it stops, so the
  // last thing on screen is how long the update actually took.
  useEffect(() => {
    if (!running) {
      setNow(Date.now());
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Update läuft"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 400,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        fontFamily: FONT.ui,
      }}
    >
      <div
        style={{
          width: "min(640px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          background: C.panel,
          border: `1px solid ${C.borderStrong}`,
          borderRadius: 12,
          padding: 20,
          color: C.text,
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
        }}
      >
        <Keyframes />
        <h2 style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 600 }}>
          {finished ? "Update abgeschlossen" : "Lokyy Brain wird aktualisiert"}
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: C.textDim, lineHeight: 1.5 }}>
          Das dauert mehrere Minuten — bitte lass dieses Fenster offen. Deine
          Notizen, deine Datenbank und deine Einstellungen bleiben dabei
          unangetastet.
        </p>

        {/* Phase track */}
        <ol
          style={{
            listStyle: "none",
            margin: "0 0 16px",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {PHASE_ORDER.map((phase, i) => {
            const done = activeIndex > i || (finished && !state.error);
            const active = activeIndex === i && !finished;
            return (
              <li
                key={phase}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                  fontSize: 13,
                  color: active ? C.text : done ? C.textDim : C.textFaint,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    aria-hidden
                    data-testid={`phase-marker-${phase}`}
                    style={{
                      width: 16,
                      textAlign: "center",
                      color: done ? C.ok : active ? C.accent : C.textFaint,
                      // The one moving thing on screen during a long phase.
                      // CSS only: nothing here needs a timer to look alive.
                      animation: active
                        ? "lokyy-update-pulse 1.4s ease-in-out infinite"
                        : undefined,
                    }}
                  >
                    {done ? "✓" : active ? "●" : "○"}
                  </span>
                  <span style={{ fontWeight: active ? 600 : 400 }}>{PHASE_LABEL[phase]}</span>
                </span>

                {/* Issue #32 — „Bauen" is where people gave up. Say beforehand
                    that the wait is expected, and point at the clock as the
                    thing to watch instead of the dot. */}
                {phase === "build" && active && (
                  <span
                    style={{
                      marginLeft: 24,
                      fontSize: 12,
                      color: C.textDim,
                      lineHeight: 1.45,
                      fontWeight: 400,
                    }}
                  >
                    {"Dauert am längsten — je nach Rechner mehrere Minuten. " +
                      "Solange sich die Zeit unten bewegt, arbeitet Lokyy."}
                  </span>
                )}
              </li>
            );
          })}
          {job?.phase === "rollback" && (
            <li style={{ fontSize: 13, color: C.gold, display: "flex", gap: 8 }}>
              <span aria-hidden style={{ width: 16, textAlign: "center" }}>
                ↩
              </span>
              <span>{PHASE_LABEL.rollback}</span>
            </li>
          )}
        </ol>

        {/* A dropped connection is a restart, never an error (AC#6). */}
        {state.restarting && (
          <p
            style={{
              margin: "0 0 12px",
              padding: "10px 12px",
              borderRadius: 8,
              background: C.elevated,
              border: `1px solid ${C.border}`,
              fontSize: 13,
              color: C.textDim,
              lineHeight: 1.5,
            }}
          >
            Lokyy Brain startet gerade neu. Die Verbindung ist deshalb kurz weg —
            das ist normal. Die Seite meldet sich von selbst zurück, sobald der
            Dienst wieder da ist.
          </p>
        )}

        {renewing && (
          <p style={{ margin: "0 0 12px", fontSize: 13, color: C.textDim }}>
            Neue Oberfläche wird geladen …
          </p>
        )}

        {outcome && (
          <p
            style={{
              margin: "0 0 12px",
              padding: "10px 12px",
              borderRadius: 8,
              background: C.elevated,
              border: `1px solid ${
                outcome.tone === "ok" ? C.ok : outcome.tone === "warn" ? C.gold : C.err
              }`,
              fontSize: 13,
              lineHeight: 1.5,
              color: C.text,
            }}
          >
            {outcome.text}
          </p>
        )}

        {state.error && (
          <p
            style={{
              margin: "0 0 12px",
              padding: "10px 12px",
              borderRadius: 8,
              background: C.elevated,
              border: `1px solid ${C.err}`,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {state.error}
          </p>
        )}

        {job && job.log.length > 0 && (
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: "pointer", fontSize: 12, color: C.textDim }}>
              Protokoll anzeigen
            </summary>
            <pre
              style={{
                margin: "8px 0 0",
                padding: 10,
                maxHeight: 220,
                overflow: "auto",
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                fontFamily: FONT.mono,
                fontSize: 11,
                color: C.textDim,
                whiteSpace: "pre-wrap",
              }}
            >
              {job.log.join("\n")}
            </pre>
          </details>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {/* The living proof that nothing is stuck. `role="timer"` keeps a
              screen reader from announcing every single second. */}
          <span style={{ fontSize: 12, color: C.textDim, display: "flex", gap: 6 }}>
            {finished || state.error ? "Gesamtdauer" : "Läuft seit"}
            <span
              role="timer"
              aria-label={finished || state.error ? "Gesamtdauer" : "Laufzeit"}
              style={{ fontFamily: FONT.mono, color: C.text }}
            >
              {elapsed}
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: finished || state.error ? C.accent : "transparent",
              border: `1px solid ${finished || state.error ? C.accent : C.border}`,
              color: finished || state.error ? "#13171D" : C.textDim,
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: FONT.ui,
            }}
          >
            {finished || state.error ? "Schließen" : "Im Hintergrund weiterlaufen lassen"}
          </button>
        </div>
      </div>
    </div>
  );
}
