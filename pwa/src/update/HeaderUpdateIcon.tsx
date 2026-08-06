import { useContext, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { SessionUserContext } from "../AuthGate.js";
import { C, FONT } from "../theme.js";
import { undismiss } from "./dismissal.js";
import { UpdateProgress } from "./UpdateProgress.js";
import { refreshSystemVersion, useSystemVersion } from "./useSystemVersion.js";
import { useUpdateFlow } from "./useUpdateFlow.js";

/**
 * The permanently visible update affordance in the header bar.
 *
 * Banner and version card are both situational: the banner can be dismissed
 * per version, the card is three clicks deep in Einstellungen. Neither answers
 * "is there anything for me right now?" at a glance, which is what this is for.
 *
 * ONE element, two meanings, decided by the state — never two buttons:
 * - nothing due  → a dim circular arrow that CHECKS on click (the forced
 *   `POST /api/system/version/check`, throttling and all), and reports back in
 *   one short sentence.
 * - update due   → the same element turns orange, gains `→ vX.Y.Z`, and its
 *   click STARTS the update — the banner's flow verbatim, `UpdateProgress`
 *   included.
 *
 * Every piece of state is borrowed, none is owned: `useSystemVersion` is the
 * app-wide store the banner and the card already read (so a check here moves
 * all three without a reload), and `useUpdateFlow` is the same probe/POST/job
 * machine both other entry points run. What lives here is only the popover
 * text and whether a check is in flight.
 */

/** How long the answer to a click stays on screen before it fades out. */
const NOTE_MS = 8000;

function Keyframes() {
  return (
    <style data-lokyy-header-update-anim>{`
      @keyframes lokyy-spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
    `}</style>
  );
}

/**
 * `compact` drops the `→ vX.Y.Z` text and leaves the orange icon alone. The
 * header is `overflow: hidden` and on a phone every extra millimetre pushes the
 * user menu off the edge, so on mobile the colour carries the message.
 */
export function HeaderUpdateIcon({ compact = false }: { compact?: boolean }) {
  const { version } = useSystemVersion();
  const sessionUser = useContext(SessionUserContext);
  const isAdmin = sessionUser?.role === "admin";

  const latest = version?.latest ?? null;
  /**
   * The update meaning is offered under exactly the banner's condition. A
   * non-admin keeps the check-only icon: they may ask the question, but the
   * answer they could act on is not theirs to act on, and an orange button
   * that refuses on click is the dead button this story exists to avoid.
   */
  const updateOffered = !!version?.updateAvailable && !!latest && isAdmin;
  const flow = useUpdateFlow(updateOffered);

  const [checking, setChecking] = useState(false);
  /** The one-line answer to the last click. `null` = nothing to say. */
  const [note, setNote] = useState<string | null>(null);
  /** Only ever filled for `reason === "blocked"` — actionable, so listed. */
  const [noteDetails, setNoteDetails] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function say(text: string, details: string[] = []): void {
    setNote(text);
    setNoteDetails(details);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), NOTE_MS);
  }

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function checkNow(): Promise<void> {
    setChecking(true);
    setNote(null);
    setNoteDetails([]);
    try {
      // Never throws by contract; `null` means "could not run at all".
      const payload = await refreshSystemVersion();
      if (!payload) {
        say("Prüfung gerade nicht möglich — später noch einmal versuchen.");
        return;
      }
      if (payload.updateAvailable && payload.latest) {
        // The user just asked. A dismissal of exactly this version from an hour
        // ago must not swallow the answer — same rule as the settings card.
        undismiss(payload.latest);
        say(`Neue Version verfügbar: ${payload.latest}`);
        return;
      }
      const time =
        payload.checkedAt === null
          ? null
          : new Date(payload.checkedAt).toLocaleTimeString("de-DE", {
              hour: "2-digit",
              minute: "2-digit",
            });
      const running = payload.running ?? "unbekannt";
      say(
        time
          ? `Alles aktuell — Version ${running}, zuletzt geprüft ${time}`
          : `Alles aktuell — Version ${running}`,
      );
    } finally {
      setChecking(false);
    }
  }

  function onClick(): void {
    if (!updateOffered) {
      void checkNow();
      return;
    }
    if (flow.canUpdate) {
      void flow.start();
      return;
    }
    if (flow.cannotUpdate) {
      // The server's own sentence — it knows WHY (managed / off / blocked /
      // unreachable). We only fall back when it sent none.
      say(
        flow.capability?.message ??
          "Diese Installation wird über deine Deploy-Plattform aktualisiert. " +
            "Starte das Update dort — hier gibt es bewusst keinen Knopf.",
        flow.capability?.reason === "blocked" ? flow.blockers : [],
      );
      return;
    }
    // The probe has not landed yet. Saying nothing would read as a broken
    // button, and claiming either answer now would be a guess.
    say("Einen Moment — die Update-Möglichkeit wird gerade geprüft.");
  }

  const busy = checking || flow.starting;
  const label = updateOffered
    ? `Update verfügbar — Version ${latest} installieren`
    : "Nach Updates suchen";

  return (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <Keyframes />
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-busy={busy}
        aria-label={label}
        title={
          updateOffered
            ? `Neue Version ${latest} — jetzt aktualisieren`
            : "Nach Updates suchen"
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          // Same chrome as the neighbouring header icons — this is one of them,
          // not a new kind of control.
          background: updateOffered ? C.accentSoft : C.elevated,
          border: `1px solid ${updateOffered ? C.accent : C.border}`,
          borderRadius: 7,
          padding: "6px 9px",
          cursor: busy ? "default" : "pointer",
          color: updateOffered ? C.accent : C.text,
          fontSize: 12,
          fontWeight: updateOffered ? 600 : 400,
          fontFamily: FONT.ui,
          minHeight: 36,
          opacity: busy ? 0.7 : 1,
          whiteSpace: "nowrap",
        }}
      >
        <RefreshCw
          size={20}
          style={{
            // Quiet by default so the bar stays calm; orange the moment there
            // is actually something to do.
            color: updateOffered ? C.accent : C.textDim,
            animation: busy ? "lokyy-spin 0.9s linear infinite" : undefined,
          }}
        />
        {updateOffered && !compact && <span>→ {latest}</span>}
      </button>

      {note && (
        <div
          role="status"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 60,
            minWidth: 220,
            maxWidth: 320,
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "9px 11px",
            color: C.text,
            fontSize: 12,
            fontFamily: FONT.ui,
            lineHeight: 1.5,
            boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
            whiteSpace: "normal",
          }}
        >
          {note}
          {noteDetails.length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: C.textDim }}>
              {noteDetails.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {flow.startError && (
        <div
          role="status"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 60,
            minWidth: 220,
            maxWidth: 320,
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "9px 11px",
            color: C.err,
            fontSize: 12,
            fontFamily: FONT.ui,
            lineHeight: 1.5,
            boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
            whiteSpace: "normal",
          }}
        >
          {flow.startError}
        </div>
      )}

      {/* The banner's own progress view — a fixed overlay, so the header stays
          where it is underneath. */}
      {flow.job && (
        <UpdateProgress
          jobId={flow.job.id}
          initialJob={flow.job.snapshot}
          onClose={flow.closeJob}
        />
      )}
    </span>
  );
}
