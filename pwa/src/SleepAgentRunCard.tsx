import { useState } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
} from "lucide-react";
import { C, FONT } from "./theme.js";
import type { ProtocolEntry, StatusTone } from "./sleepAgentProtocolViewModel.js";

/**
 * Eine Karte je Nachtlauf — Unterkomponente von `SleepAgentProtocol.tsx`
 * (Story C1).
 *
 * Zugeklappt beantwortet die Karte die drei Fragen, die der Nutzer wirklich
 * hat: WANN lief es, WIE LANGE, und WAS ist dabei herausgekommen. Erst der
 * Klick klappt die einzelnen Arbeitsschritte und die berührten Notizen aus —
 * so bleibt die Liste auch nach hundert Läufen überschaubar.
 *
 * Die Karte rechnet NICHT: alle Texte kommen fertig aus
 * `sleepAgentProtocolViewModel.ts`.
 */

/** Theme-Farbe je Status-Ton. */
const TONE_COLORS: Record<StatusTone, string> = {
  ok: C.ok,
  warn: C.gold,
  err: C.err,
  muted: C.textFaint,
};

/**
 * `flexShrink: 0` ist hier NICHT Kosmetik, sondern der Fix gegen gequetschte
 * Karten: die Liste in `SleepAgentProtocol.tsx` ist eine Flex-Spalte, und
 * `overflow: hidden` setzt die automatische Mindesthöhe eines Flex-Elements
 * (`min-height: auto`) außer Kraft. Ohne die Sperre staucht der Flex-
 * Algorithmus bei vielen Läufen jede Karte auf wenige Pixel zusammen — der
 * Text steht vollständig im DOM und wird trotzdem weggeschnitten.
 */
const CARD_STYLE: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  background: C.panel,
  overflow: "hidden",
  flexShrink: 0,
};

const HEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "11px 12px",
  background: "transparent",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
  fontFamily: FONT.ui,
};

const TITLE_STYLE: CSSProperties = {
  color: C.text,
  fontSize: 13.5,
  fontWeight: 650,
};

const SUMMARY_STYLE: CSSProperties = {
  color: C.textDim,
  fontSize: 12.5,
  marginTop: 2,
};

const META_STYLE: CSSProperties = {
  color: C.textFaint,
  fontSize: 11.5,
  marginTop: 3,
};

const BODY_STYLE: CSSProperties = {
  padding: "2px 12px 12px",
  borderTop: `1px solid ${C.borderSoft}`,
};

const SECTION_TITLE_STYLE: CSSProperties = {
  color: C.gold,
  fontFamily: FONT.ui,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  margin: "12px 0 6px",
};

const ACTION_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  padding: "5px 0",
  borderBottom: `1px solid ${C.borderSoft}`,
  fontFamily: FONT.ui,
  fontSize: 12.5,
  color: C.text,
};

const NOTE_BTN_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 7,
  color: C.textDim,
  fontFamily: FONT.ui,
  fontSize: 12,
  cursor: "pointer",
  maxWidth: "100%",
};

const HINT_STYLE: CSSProperties = {
  color: C.textFaint,
  fontFamily: FONT.ui,
  fontSize: 12,
  lineHeight: 1.5,
};

const ERROR_BOX_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 7,
  marginTop: 10,
  padding: "8px 10px",
  borderRadius: 7,
  background: "rgba(239,68,68,0.10)",
  border: `1px solid rgba(239,68,68,0.35)`,
  color: C.err,
  fontFamily: FONT.ui,
  fontSize: 12,
  lineHeight: 1.5,
};

/** `countLabel(1,"Notiz","Notizen")` → „1 Notiz“. */
function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface SleepAgentRunCardProps {
  entry: ProtocolEntry;
  /** Öffnet eine Notiz — delegiert nach oben in `App.open()`. */
  onOpenNote: (noteId: string) => void;
  /** Erste Karte startet aufgeklappt, damit die Ansicht nicht leer wirkt. */
  defaultOpen?: boolean;
}

export function SleepAgentRunCard({
  entry,
  onOpenNote,
  defaultOpen = false,
}: SleepAgentRunCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const tone = TONE_COLORS[entry.statusTone];
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div style={CARD_STYLE} data-testid="sleep-run-card">
      <button
        type="button"
        style={HEAD_STYLE}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Chevron size={15} color={C.textFaint} style={{ flexShrink: 0 }} />
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: tone,
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={TITLE_STYLE}>{entry.startedAtLabel}</span>
          <span
            style={{
              color: tone,
              fontSize: 11.5,
              fontWeight: 600,
              marginLeft: 8,
            }}
          >
            {entry.statusLabel}
          </span>
          <div style={SUMMARY_STYLE}>{entry.summary}</div>
          <div style={META_STYLE}>
            Dauer: {entry.durationLabel} · {entry.phaseLabel} ·{" "}
            {entry.triggerLabel}
          </div>
        </span>
      </button>

      {open && (
        <div style={BODY_STYLE}>
          <div style={SECTION_TITLE_STYLE}>Was gemacht wurde</div>
          {entry.actions.length === 0 ? (
            <div style={HINT_STYLE}>
              In diesem Lauf war kein Arbeitsschritt nötig.
            </div>
          ) : (
            entry.actions.map((action) => (
              <div key={action.passName} style={ACTION_ROW_STYLE}>
                <span
                  aria-hidden
                  style={{
                    color: action.failed ? C.err : C.ok,
                    flexShrink: 0,
                  }}
                >
                  {action.failed ? "✕" : "✓"}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: action.failed ? C.textDim : C.text }}>
                    {action.label}
                  </span>
                  {action.failed && action.errorMessage && (
                    <div
                      style={{
                        color: C.err,
                        fontSize: 11.5,
                        marginTop: 2,
                        wordBreak: "break-word",
                      }}
                    >
                      Dieser Schritt hat nicht geklappt: {action.errorMessage}
                    </div>
                  )}
                  {action.detail && (
                    <div
                      style={{
                        color: C.textFaint,
                        fontFamily: FONT.mono,
                        fontSize: 11,
                        marginTop: 2,
                        wordBreak: "break-word",
                      }}
                    >
                      {action.detail}
                    </div>
                  )}
                </span>
                {/*
                  Zähler stehen bei JEDEM Schritt — auch beim abgebrochenen.
                  „0 Notizen · 1 Fehler“ ist genau die Zeile, an der man einen
                  dauerhaft kaputten Schritt erkennt.
                */}
                <span
                  style={{
                    color: action.errors > 0 ? C.err : C.textFaint,
                    fontSize: 11.5,
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  {countLabel(action.processed, "Notiz", "Notizen")}
                  {action.errors > 0 &&
                    ` · ${countLabel(action.errors, "Fehler", "Fehler")}`}
                </span>
              </div>
            ))
          )}

          <div style={SECTION_TITLE_STYLE}>
            Berührte Notizen
            {entry.touchedNotesKnown && ` (${entry.touchedNotes.length})`}
          </div>
          {entry.touchedNotesKnown ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {entry.touchedNotes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  style={NOTE_BTN_STYLE}
                  onClick={() => onOpenNote(note.id)}
                  title={`„${note.label}“ öffnen`}
                >
                  <FileText size={13} color={C.textFaint} />
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {note.label}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div style={HINT_STYLE}>
              {entry.notesProcessed === 0
                ? "In diesem Lauf wurde keine Notiz verändert."
                : `${entry.notesProcessed === 1 ? "1 Notiz wurde" : `${entry.notesProcessed} Notizen wurden`} bearbeitet. Welche das im Einzelnen waren, hält das Protokoll bisher nicht fest.`}
            </div>
          )}

          {entry.errorMessage && (
            <div style={ERROR_BOX_STYLE}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Der Lauf wurde abgebrochen: {entry.errorMessage}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
