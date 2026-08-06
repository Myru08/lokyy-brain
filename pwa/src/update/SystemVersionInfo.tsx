import { useContext, useState } from "react";
import { SessionUserContext } from "../AuthGate.js";
import { C, FONT } from "../theme.js";
import { Highlights } from "./Highlights.js";
import { undismiss } from "./dismissal.js";
import { UpdateProgress } from "./UpdateProgress.js";
import { refreshSystemVersion, useSystemVersion } from "./useSystemVersion.js";
import { useUpdateFlow } from "./useUpdateFlow.js";

/**
 * Story 7.12 Task 5 — version and update status in Einstellungen → System.
 *
 * The banner is the loud channel; this is the quiet one, for after it has been
 * dismissed. It carries two actions: „Jetzt prüfen" (a READ) and, once an
 * update is actually there, „Jetzt aktualisieren". The second one runs the
 * banner's flow verbatim — same `useUpdateFlow`, same `UpdateProgress` — because
 * the card is where people find out about the update, and sending them back to
 * a banner that is not on this page was the whole complaint.
 *
 * A failed check is not reported as a problem (AC#3) — it reads "zuletzt
 * geprüft: —", which is the truth without being alarming. The same applies to
 * a manual check that cannot run: one quiet line, never a red alarm.
 */

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        padding: "7px 0",
        borderBottom: `1px solid ${C.borderSoft}`,
        fontSize: 13,
      }}
    >
      <span style={{ color: C.textDim }}>{label}</span>
      <span style={{ fontFamily: FONT.mono, textAlign: "right", overflowWrap: "anywhere" }}>
        {value}
      </span>
    </div>
  );
}

export function SystemVersionInfo() {
  const { version } = useSystemVersion();
  const sessionUser = useContext(SessionUserContext);
  const isAdmin = sessionUser?.role === "admin";
  const [checking, setChecking] = useState(false);
  /** Set only when a manual check could not run at all. Cleared on retry. */
  const [checkFailed, setCheckFailed] = useState(false);

  /** The one condition under which this card offers to start an update. */
  const updateOffered = !!version?.updateAvailable && isAdmin;
  const flow = useUpdateFlow(updateOffered);

  async function checkNow(): Promise<void> {
    setChecking(true);
    setCheckFailed(false);
    try {
      // Never throws by contract; `null` means "could not run".
      const payload = await refreshSystemVersion();
      setCheckFailed(payload === null);
      // The user just asked. If the answer is "there is an update", an earlier
      // dismissal of exactly that version must not keep the banner silent —
      // that state survives a reload, so nothing else would bring it back.
      if (payload?.updateAvailable) undismiss(payload.latest);
    } finally {
      setChecking(false);
    }
  }

  if (!version) {
    return <div style={{ fontSize: 13, color: C.textDim }}>Version wird geladen …</div>;
  }

  const checked =
    version.checkedAt === null
      ? "—"
      : new Date(version.checkedAt).toLocaleString("de-DE", {
          dateStyle: "medium",
          timeStyle: "short",
        });

  return (
    <div>
      <Row label="Laufende Version" value={version.running ?? "unbekannt"} />
      {version.buildSha && <Row label="Build" value={version.buildSha.slice(0, 12)} />}
      <Row
        label="Verfügbare Version"
        value={
          version.status === "disabled"
            ? "Prüfung ausgeschaltet"
            : (version.latest ?? "unbekannt")
        }
      />
      <Row
        label="Zuletzt geprüft"
        value={
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 10 }}
          >
            {checked}
            {version.status !== "disabled" && (
              <button
                type="button"
                onClick={() => void checkNow()}
                disabled={checking}
                style={{
                  background: "transparent",
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  color: checking ? C.textDim : C.text,
                  padding: "3px 9px",
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  cursor: checking ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {checking ? "Prüfe …" : "Jetzt prüfen"}
              </button>
            )}
          </span>
        }
      />

      {/* AC#4 — a check that cannot run is a non-event, not a fault of this
          installation. One dim line, no red, and the previous answer stays
          on screen above it. */}
      {checkFailed && (
        <div style={{ marginTop: 8, fontSize: 12, color: C.textDim }}>
          Prüfung gerade nicht möglich — später noch einmal versuchen.
        </div>
      )}

      {updateOffered && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, color: C.accent, marginBottom: 10 }}>
            Eine neue Version steht bereit. Deine Notizen, deine Datenbank und deine
            Einstellungen bleiben beim Update unangetastet.
          </div>

          {/* AC#1 — the action lives where the news is. Same flow as the
              banner, down to the progress view. */}
          {flow.canUpdate && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: 10,
              }}
            >
              <button
                type="button"
                onClick={() => void flow.start()}
                disabled={flow.starting}
                style={{
                  background: C.accent,
                  border: `1px solid ${C.accent}`,
                  color: "#13171D",
                  borderRadius: 8,
                  padding: "8px 14px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: flow.starting ? "default" : "pointer",
                  opacity: flow.starting ? 0.6 : 1,
                  fontFamily: FONT.ui,
                  whiteSpace: "nowrap",
                }}
              >
                {flow.starting ? "Startet …" : "Jetzt aktualisieren"}
              </button>
              <span style={{ fontSize: 12, color: C.textDim }}>
                Der Vorgang dauert mehrere Minuten.
              </span>
            </div>
          )}

          {/* AC#2 — no self-update here: the server's own sentence, never a
              dead button. */}
          {flow.cannotUpdate && (
            <p style={{ margin: "0 0 10px", fontSize: 12, color: C.gold, lineHeight: 1.5 }}>
              {flow.capability?.message ??
                "Diese Installation wird über deine Deploy-Plattform aktualisiert. " +
                  "Starte das Update dort — hier gibt es bewusst keinen Knopf."}
            </p>
          )}

          {/* `blocked` means an updater IS there but is misconfigured — that is
              actionable, so the concrete reasons are shown. */}
          {flow.cannotUpdate &&
            flow.capability?.reason === "blocked" &&
            flow.blockers.length > 0 && (
              <ul
                style={{
                  margin: "0 0 10px",
                  paddingLeft: 18,
                  fontSize: 12,
                  color: C.textDim,
                  lineHeight: 1.5,
                }}
              >
                {flow.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}

          {flow.startError && (
            <p style={{ margin: "0 0 10px", fontSize: 12, color: C.err, lineHeight: 1.5 }}>
              {flow.startError}
            </p>
          )}

          <Highlights items={version.highlights} limit={8} />
        </div>
      )}

      {/* AC#4 — the banner's own progress view, phases and log included. It is
          a fixed overlay, so the card stays where it is underneath. */}
      {flow.job && (
        <UpdateProgress
          jobId={flow.job.id}
          initialJob={flow.job.snapshot}
          onClose={flow.closeJob}
        />
      )}

      {!version.updateAvailable && version.status === "ok" && (
        <div style={{ marginTop: 14, fontSize: 13, color: C.textDim }}>
          Deine Installation ist aktuell.
        </div>
      )}
    </div>
  );
}
