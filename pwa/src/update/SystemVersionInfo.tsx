import { useContext } from "react";
import { SessionUserContext } from "../AuthGate.js";
import { C, FONT } from "../theme.js";
import { Highlights } from "./Highlights.js";
import { useSystemVersion } from "./useSystemVersion.js";

/**
 * Story 7.12 Task 5 — version and update status in Einstellungen → System.
 *
 * The banner is the loud channel; this is the quiet one, for after it has been
 * dismissed. Read-only on purpose: the button lives in the banner, so there is
 * exactly one place that starts an update.
 *
 * A failed check is not reported as a problem (AC#3) — it reads "zuletzt
 * geprüft: —", which is the truth without being alarming.
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
      <Row label="Zuletzt geprüft" value={checked} />

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
