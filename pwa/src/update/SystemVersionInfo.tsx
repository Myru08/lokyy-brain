import { useContext, useState } from "react";
import { SessionUserContext } from "../AuthGate.js";
import { C, FONT } from "../theme.js";
import { Highlights } from "./Highlights.js";
import { refreshSystemVersion, useSystemVersion } from "./useSystemVersion.js";

/**
 * Story 7.12 Task 5 — version and update status in Einstellungen → System.
 *
 * The banner is the loud channel; this is the quiet one, for after it has been
 * dismissed. It carries exactly one action, „Jetzt prüfen" — a READ. Starting
 * an update still happens in exactly one place, the banner.
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

  async function checkNow(): Promise<void> {
    setChecking(true);
    setCheckFailed(false);
    try {
      // Never throws by contract; `null` means "could not run".
      const payload = await refreshSystemVersion();
      setCheckFailed(payload === null);
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

      {version.updateAvailable && isAdmin && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 13, color: C.accent, marginBottom: 8 }}>
            Eine neue Version steht bereit. Der Hinweis oben in der App führt dich
            durch die Aktualisierung; deine Notizen und Einstellungen bleiben dabei
            unangetastet.
          </div>
          <Highlights items={version.highlights} limit={8} />
        </div>
      )}

      {!version.updateAvailable && version.status === "ok" && (
        <div style={{ marginTop: 14, fontSize: 13, color: C.textDim }}>
          Deine Installation ist aktuell.
        </div>
      )}
    </div>
  );
}
