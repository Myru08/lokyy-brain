import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, Moon, RefreshCw } from "lucide-react";
import { C, FONT } from "./theme.js";
import { Spinner } from "./Spinner.js";
import { fetchSleepAgentRuns, type SleepRunDto } from "./api.sleepAgent.js";
import { groupEntriesByDay, toProtocolEntries } from "./sleepAgentProtocol.js";
import { SleepAgentRunCard } from "./SleepAgentRunCard.js";
import type { ViewProps } from "./sidebar/views/registry.js";

/**
 * Nacht-Protokoll-Ansicht (Story C1) — „Bei dir läuft nachts ein Helfer über
 * deinen Vault. Hier siehst du, was er getan hat."
 *
 * REINE ANZEIGE: liest `GET /api/sleep-agent/runs` und rendert. Sie startet
 * keinen Lauf, bricht keinen ab und ändert nichts am Vault — der Trigger- und
 * der Cancel-Endpunkt bleiben bewusst ungenutzt.
 *
 * Sprache: durchgehend Deutsch und ohne Fachbegriffe. Die Zielgruppe hat
 * keinen Programmierhintergrund; jede technische Bezeichnung (Pass-Namen,
 * Phasen, Status) wird in `sleepAgentProtocol.ts` übersetzt, bevor sie hier
 * ankommt.
 *
 * Registry-kompatibel: die Komponente erfüllt `ViewProps` aus
 * `sidebar/views/registry.ts` (`item` + `onOpenNote`) und kann darum ohne
 * Anpassung als View-Typ registriert werden. `item` wird nicht ausgewertet —
 * das Protokoll hat keinen Ordner-Bezug. Der Typ-Import ist `import type`,
 * damit zur Laufzeit kein Zyklus zur Registry entsteht.
 *
 * Kein eigener Editor-/Routing-State: ein Klick auf eine Notiz geht über
 * `onOpenNote` nach oben in `App.open()`.
 */

/** Wie viele Läufe geladen werden. Server deckelt zusätzlich bei 200. */
const RUN_LIMIT = 30;

/** Karten pro Stufe — initial sichtbar und Zuwachs je „Ältere anzeigen". */
const RUNS_PER_STEP = 10;

const SHELL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  boxSizing: "border-box",
  fontFamily: FONT.ui,
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "10px 12px",
  borderBottom: `1px solid ${C.border}`,
  flexShrink: 0,
};

const HEADER_TITLE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  color: C.gold,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

const REFRESH_BTN_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "5px 10px",
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 7,
  color: C.textDim,
  fontFamily: FONT.ui,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  flexShrink: 0,
};

const INTRO_STYLE: CSSProperties = {
  padding: "10px 12px 0",
  color: C.textDim,
  fontSize: 12.5,
  lineHeight: 1.55,
};

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "12px",
  overflowY: "auto",
  flex: 1,
};

/** Ein Kalendertag mit seinen Karten. `flexShrink: 0` aus demselben Grund
 *  wie bei der Karte selbst — sonst staucht die Flex-Spalte die Gruppe. */
const GROUP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  flexShrink: 0,
};

const GROUP_TITLE_STYLE: CSSProperties = {
  color: C.textFaint,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  padding: "4px 2px 0",
};

const MORE_BTN_STYLE: CSSProperties = {
  alignSelf: "center",
  flexShrink: 0,
  padding: "7px 14px",
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  color: C.textDim,
  fontFamily: FONT.ui,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const CENTER_BOX_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  flex: 1,
  padding: "32px 24px",
  textAlign: "center",
};

const CENTER_TITLE_STYLE: CSSProperties = {
  color: C.text,
  fontSize: 14,
  fontWeight: 650,
};

const CENTER_TEXT_STYLE: CSSProperties = {
  color: C.textDim,
  fontSize: 12.5,
  lineHeight: 1.6,
  maxWidth: 380,
};

type LoadState = "loading" | "ready" | "error";

export function SleepAgentProtocol({ onOpenNote }: ViewProps) {
  const [runs, setRuns] = useState<SleepRunDto[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorText, setErrorText] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setErrorText(null);
    try {
      setRuns(await fetchSleepAgentRuns(RUN_LIMIT));
      setState("ready");
    } catch (e) {
      // Netzwerkfehler (Server aus) und HTTP-Fehler landen beide hier — der
      // Nutzer bekommt in jedem Fall eine gestaltete Seite, nie einen weißen
      // Bildschirm (AC2).
      setErrorText(
        e instanceof Error && e.message
          ? e.message
          : "Das Nacht-Protokoll konnte nicht geladen werden",
      );
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // `toProtocolEntries` liest die Uhrzeit für „Heute"/„Gestern" — an `runs`
  // gebunden, damit die Labels bei jedem Neuladen frisch berechnet werden.
  const entries = useMemo(() => toProtocolEntries(runs), [runs]);

  // Der Leerlauf-Auslöser produziert dutzende Läufe pro Tag. Sichtbar sind
  // zunächst nur die neuesten `RUNS_PER_STEP`; „Ältere anzeigen" schaltet
  // weitere aus der BEREITS geladenen Antwort frei — kein zweiter Request.
  const [visibleCount, setVisibleCount] = useState(RUNS_PER_STEP);
  useEffect(() => setVisibleCount(RUNS_PER_STEP), [runs]);

  const hiddenCount = Math.max(0, entries.length - visibleCount);
  const groups = useMemo(
    () => groupEntriesByDay(entries.slice(0, visibleCount)),
    [entries, visibleCount],
  );

  return (
    <div style={SHELL_STYLE}>
      <div style={HEADER_STYLE}>
        <span style={HEADER_TITLE_STYLE}>
          <Moon size={14} />
          Nacht-Protokoll
        </span>
        <button
          type="button"
          style={REFRESH_BTN_STYLE}
          onClick={() => void load()}
          disabled={state === "loading"}
        >
          <RefreshCw size={13} />
          Aktualisieren
        </button>
      </div>

      {state === "ready" && entries.length > 0 && (
        <div style={INTRO_STYLE}>
          Während du schläfst, geht ein Helfer durch deinen Vault: er sortiert,
          verknüpft und räumt auf. Hier steht, was er dabei getan hat.
        </div>
      )}

      {state === "loading" && (
        <div style={CENTER_BOX_STYLE}>
          <Spinner size={22} label="Nacht-Protokoll wird geladen" />
          <div style={CENTER_TEXT_STYLE}>Protokoll wird geladen …</div>
        </div>
      )}

      {state === "error" && (
        <div style={CENTER_BOX_STYLE}>
          <AlertTriangle size={26} color={C.err} />
          <div style={CENTER_TITLE_STYLE}>
            Das Protokoll ist gerade nicht erreichbar
          </div>
          <div style={CENTER_TEXT_STYLE}>
            Deine Notizen sind davon nicht betroffen — es lässt sich nur die
            Liste der nächtlichen Läufe nicht abrufen. Versuche es gleich noch
            einmal.
          </div>
          <div
            style={{
              color: C.textFaint,
              fontFamily: FONT.mono,
              fontSize: 11,
              wordBreak: "break-word",
              maxWidth: 380,
            }}
          >
            {errorText}
          </div>
          <button type="button" style={REFRESH_BTN_STYLE} onClick={() => void load()}>
            <RefreshCw size={13} />
            Erneut versuchen
          </button>
        </div>
      )}

      {state === "ready" && entries.length === 0 && (
        <div style={CENTER_BOX_STYLE}>
          <Moon size={26} color={C.textFaint} />
          <div style={CENTER_TITLE_STYLE}>Noch kein Lauf protokolliert</div>
          <div style={CENTER_TEXT_STYLE}>
            Der nächtliche Helfer war noch nicht unterwegs — oder er hatte noch
            nichts zu tun. Sobald er das erste Mal durch deinen Vault gegangen
            ist, steht der Lauf hier.
          </div>
        </div>
      )}

      {state === "ready" && entries.length > 0 && (
        <div style={LIST_STYLE}>
          {groups.map((group) => (
            <div key={group.key} style={GROUP_STYLE}>
              <div style={GROUP_TITLE_STYLE}>{group.label}</div>
              {group.entries.map((entry, index) => (
                <SleepAgentRunCard
                  key={entry.id || `${group.key}-${index}`}
                  entry={entry}
                  onOpenNote={onOpenNote}
                  defaultOpen={entry === entries[0]}
                />
              ))}
            </div>
          ))}

          {hiddenCount > 0 && (
            <button
              type="button"
              style={MORE_BTN_STYLE}
              onClick={() => setVisibleCount((n) => n + RUNS_PER_STEP)}
            >
              Ältere anzeigen ({hiddenCount} weitere)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default SleepAgentProtocol;
