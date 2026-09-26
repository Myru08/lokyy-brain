import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  Check,
  FilePlus2,
  GitMerge,
  Info,
  Link as LinkIcon,
  Loader2,
  Merge,
  MinusCircle,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { api } from "./api.js";
import type {
  IngestProposal,
  IngestProposalAction,
  IngestProposalsApplyResult,
} from "./api.js";
import { C, FONT } from "./theme.js";
import { useIsMobile } from "./responsive.js";

/**
 * Approval-Karte der Ingest-Time-Synthese (Story #67, AC 10–12).
 *
 * **Eigener Ort, nicht im Import-Panel.** Drei Gründe, und alle drei kommen
 * aus dem Vertrag und dem bestehenden Code:
 *
 *  1. Vorschläge überleben den Import. `GET /api/ingest/proposals?status=pending`
 *     ist nicht nach Job gefiltert — sie sammeln sich an und dürfen Tage später
 *     entschieden werden. Die Job-Liste im Import-Panel wird dagegen nur
 *     gepollt, solange das Panel offen ist, und das Panel schließt sich, sobald
 *     man eine importierte Notiz öffnet. Eine Entscheidungs-Oberfläche, die
 *     verschwindet, sobald man nachsieht, worum es geht, ist keine.
 *  2. Es ist ein Review-Vorgang, und dafür gibt es hier schon eine Form:
 *     `LintFindingsPanel` (520 px Slide-over, Liste offener Funde, Entscheidung
 *     mit Folgen, Refresh, ruhiger Leerzustand). Das ist das Vorbild, nicht die
 *     Job-Zeile. Das Import-Panel ist 360 px breit und beherbergt drei Reiter;
 *     zwei Notiz-Titel plus Begründung plus Folgenschwere passen da nicht hin,
 *     ohne den Import selbst zu verdrängen.
 *  3. AC 12: die Karte ergänzt, sie blockiert nicht. Getrennte Oberfläche heißt,
 *     der Import bleibt buchstäblich unberührt bedienbar.
 *
 * Die **Brücke** zurück ist ein Hinweis an der Job-Zeile im Import-Panel
 * („2 Vorschläge · ansehen"), der dieses Panel öffnet — damit die Vorschläge
 * gefunden werden, wenn der Nutzer die Quelle noch im Kopf hat. Er ist optional
 * und verschwindet bei null Vorschlägen restlos.
 *
 * **Folgenschwere ist die zweite Achse der Oberfläche.** Ein Haken an `merge`
 * darf nicht aussehen wie einer an `link`. Deshalb: eigene Sektion oben,
 * eigene Farbe, ausgeschriebene Konsequenz je Karte, und der Sammel-Haken
 * greift sie NICHT — schwere Vorschläge bekommen ihre Freigabe einzeln.
 *
 * **Ablehnen ist eine Entscheidung.** Drei Lagen je Vorschlag: unentschieden
 * (Default, wird nicht gesendet), freigegeben, abgelehnt. Abgelehntes geht als
 * `rejected` mit und bleibt serverseitig im Protokoll — die Oberfläche sagt das
 * ausdrücklich, damit „Ablehnen" nicht wie „Löschen" gelesen wird.
 */

type Impact = "heavy" | "additive" | "notice";

interface ActionMeta {
  impact: Impact;
  label: string;
  /** Was passiert, in einem Satz, ohne Fachjargon. */
  consequence: string;
  icon: typeof Check;
}

const ACTIONS: Record<IngestProposalAction, ActionMeta> = {
  merge: {
    impact: "heavy",
    label: "Notizen zusammenführen",
    consequence:
      "Führt die beiden Notizen zusammen. Verändert die bestehende Notiz — nicht mit einem Klick rückgängig.",
    icon: Merge,
  },
  append_to_note: {
    impact: "heavy",
    label: "An bestehende Notiz anhängen",
    consequence:
      "Schreibt in eine bestehende Notiz. Ihr Inhalt wächst; der Verlauf liegt in git.",
    icon: GitMerge,
  },
  create_note: {
    impact: "additive",
    label: "Zusätzliche Notiz anlegen",
    consequence:
      "Legt eine weitere Notiz an. Die importierte Quelle liegt bereits im Vault und bleibt unberührt.",
    icon: FilePlus2,
  },
  link: {
    impact: "additive",
    label: "Verknüpfung setzen",
    consequence: "Setzt einen Wikilink zwischen den beiden Notizen.",
    icon: LinkIcon,
  },
  flag_contradiction: {
    impact: "notice",
    label: "Widerspruch melden",
    consequence:
      "Legt einen Fund in der Widerspruchs-Liste an. Meldet nur — bewertet keine der beiden Notizen ab.",
    icon: AlertTriangle,
  },
  skip: {
    impact: "notice",
    label: "Nichts tun",
    consequence: "Hält fest, dass hier bewusst nichts passiert.",
    icon: MinusCircle,
  },
};

const IMPACT_COLOR: Record<Impact, string> = {
  heavy: "#F59E0B",
  additive: C.accent,
  notice: "#3B82F6",
};

const SECTIONS: { impact: Impact; title: string; hint: string }[] = [
  {
    impact: "heavy",
    title: "Verändert Bestehendes",
    hint: "Einzeln freigeben — der Sammel-Haken unten lässt diese absichtlich aus.",
  },
  {
    impact: "additive",
    title: "Ergänzt",
    hint: "Legt an oder verknüpft; nichts Bestehendes wird überschrieben.",
  },
  {
    impact: "notice",
    title: "Meldet nur",
    hint: "Schreibt keinen Notiz-Inhalt.",
  },
];

/** Unentschieden ist die dritte Lage und wird nicht gesendet. */
type Decision = "approve" | "reject";

export function impactOf(action: IngestProposalAction): Impact {
  return ACTIONS[action]?.impact ?? "notice";
}

interface IngestProposalsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Öffnet eine Notiz im Editor. */
  onOpenNote: (noteId: string) => void;
  /** Meldet die Anzahl offener Vorschläge nach jedem Refresh (Badge im Header). */
  onCountChange?: (pendingCount: number) => void;
}

export function IngestProposalsPanel({
  open,
  onClose,
  onOpenNote,
  onCountChange,
}: IngestProposalsPanelProps) {
  const isMobile = useIsMobile();
  const [proposals, setProposals] = useState<IngestProposal[] | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestProposalsApplyResult | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.listIngestProposals("pending");
      setProposals(rows);
      onCountChange?.(rows.length);
      // Entscheidungen zu Vorschlägen, die es nicht mehr gibt, fallen weg —
      // sonst schickt ein zweiter Klick IDs mit, die der Server längst
      // abgeräumt hat.
      const alive = new Set(rows.map((r) => r.id));
      setDecisions((prev) =>
        Object.fromEntries(
          Object.entries(prev).filter(([id]) => alive.has(id)),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Laden fehlgeschlagen");
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const setDecision = useCallback((id: string, next: Decision | null) => {
    setDecisions((prev) => {
      const copy = { ...prev };
      if (next === null) delete copy[id];
      else copy[id] = next;
      return copy;
    });
  }, []);

  const grouped = useMemo(() => {
    const map: Record<Impact, IngestProposal[]> = {
      heavy: [],
      additive: [],
      notice: [],
    };
    for (const p of proposals ?? []) map[impactOf(p.action)].push(p);
    return map;
  }, [proposals]);

  const approved = Object.entries(decisions)
    .filter(([, d]) => d === "approve")
    .map(([id]) => id);
  const rejected = Object.entries(decisions)
    .filter(([, d]) => d === "reject")
    .map(([id]) => id);
  const undecided = (proposals ?? []).length - approved.length - rejected.length;
  const heavyApproved = approved.filter((id) => {
    const p = (proposals ?? []).find((x) => x.id === id);
    return p ? impactOf(p.action) === "heavy" : false;
  }).length;

  /** Sammel-Haken: alles außer den schweren Vorschlägen. */
  function approveAllAdditive() {
    setDecisions((prev) => {
      const next = { ...prev };
      for (const p of proposals ?? []) {
        if (impactOf(p.action) !== "heavy") next[p.id] = "approve";
      }
      return next;
    });
  }

  async function apply() {
    if (applying || (approved.length === 0 && rejected.length === 0)) return;
    setApplying(true);
    setError(null);
    try {
      const res = await api.applyIngestProposals({ approved, rejected });
      setResult(res);
      setDecisions({});
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Übernahme fehlgeschlagen");
    } finally {
      setApplying(false);
    }
  }

  const hasProposals = (proposals?.length ?? 0) > 0;

  return (
    <>
      <div
        onClick={onClose}
        data-testid="proposals-backdrop"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.18s",
          zIndex: 40,
        }}
      />

      <aside
        aria-label="Vorschläge aus dem Import"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: isMobile ? "100vw" : 520,
          maxWidth: "100vw",
          background: C.panel,
          borderLeft: isMobile ? "none" : `1px solid ${C.border}`,
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.22s ease",
          zIndex: 41,
          display: "flex",
          flexDirection: "column",
          fontFamily: FONT.ui,
          color: C.text,
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 14px",
            height: 48,
            borderBottom: `1px solid ${C.border}`,
            flexShrink: 0,
          }}
        >
          <Sparkles size={18} style={{ color: C.accent }} aria-hidden="true" />
          <strong style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
            Vorschläge aus dem Import
            {proposals ? ` (${proposals.length})` : ""}
          </strong>
          <button
            onClick={() => void refresh()}
            title="Neu laden"
            aria-label="Neu laden"
            disabled={loading}
            style={{
              display: "flex",
              alignItems: "center",
              border: "none",
              background: "transparent",
              color: loading ? C.textFaint : C.textDim,
              cursor: loading ? "default" : "pointer",
              padding: 4,
            }}
          >
            <RefreshCw size={16} className={loading ? "sw-spin" : undefined} />
          </button>
          <button
            onClick={onClose}
            aria-label="Schließen"
            style={{
              display: "flex",
              border: "none",
              background: "transparent",
              color: C.textDim,
              cursor: "pointer",
              padding: isMobile ? 10 : 4,
            }}
          >
            <X size={isMobile ? 22 : 16} />
          </button>
        </header>

        {/* Die Trennlinie, die der Nutzer nicht verwechseln darf: die erfasste
            Notiz liegt schon im Vault. Freigegeben wird nur die Verknüpfung. */}
        <p
          style={{
            margin: 0,
            padding: "8px 14px",
            fontSize: 11.5,
            lineHeight: 1.45,
            color: C.textFaint,
            borderBottom: `1px solid ${C.border}`,
            flexShrink: 0,
          }}
        >
          Die importierte Notiz liegt bereits im Vault — hier geht es nur um die
          vorgeschlagenen Verknüpfungen. Ohne Freigabe wird davon nichts
          geschrieben; Abgelehntes bleibt im Protokoll und wird nicht gelöscht.
        </p>

        {error && (
          <div
            role="alert"
            style={{
              padding: "8px 14px",
              background: "rgba(239,68,68,0.08)",
              borderBottom: `1px solid ${C.border}`,
              color: C.err,
              fontSize: 12,
              fontFamily: FONT.mono,
              flexShrink: 0,
            }}
          >
            {error}
          </div>
        )}

        {result && (
          <ResultBlock result={result} onDismiss={() => setResult(null)} />
        )}

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {loading && !proposals && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: C.textDim,
                fontSize: 12,
              }}
            >
              <Loader2 size={14} className="sw-spin" />
              lädt…
            </div>
          )}

          {/* Keine Vorschläge ist der Normalfall — eine ruhige Zeile, keine
              leere Karte, die aussieht als wäre etwas schiefgegangen. */}
          {proposals && !hasProposals && (
            <div
              data-testid="proposals-none"
              style={{
                color: C.textFaint,
                fontSize: 12.5,
                lineHeight: 1.5,
                padding: "10px 0",
              }}
            >
              Keine offenen Vorschläge. Beim letzten Import gab es nichts zu
              verknüpfen — das ist der häufigste Fall, nicht ein Fehler.
            </div>
          )}

          {hasProposals &&
            SECTIONS.map(({ impact, title, hint }) => {
              const rows = grouped[impact];
              if (rows.length === 0) return null;
              return (
                <section key={impact}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 2,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.5,
                        textTransform: "uppercase",
                        color: IMPACT_COLOR[impact],
                      }}
                    >
                      {title} ({rows.length})
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      color: C.textFaint,
                      marginBottom: 8,
                    }}
                  >
                    {hint}
                  </div>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 10 }}
                  >
                    {rows.map((p) => (
                      <ProposalCard
                        key={p.id}
                        proposal={p}
                        decision={decisions[p.id] ?? null}
                        onDecide={(next) => setDecision(p.id, next)}
                        onOpenNote={onOpenNote}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
        </div>

        {hasProposals && (
          <footer
            style={{
              borderTop: `1px solid ${C.border}`,
              padding: 14,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11.5,
                  color: C.textDim,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  data-testid="approve-additive"
                  checked={
                    (proposals ?? [])
                      .filter((p) => impactOf(p.action) !== "heavy")
                      .every((p) => decisions[p.id] === "approve") &&
                    (proposals ?? []).some(
                      (p) => impactOf(p.action) !== "heavy",
                    )
                  }
                  onChange={approveAllAdditive}
                />
                Alle ergänzenden freigeben
              </label>
              <span style={{ flex: 1 }} />
              {undecided > 0 && (
                <span style={{ fontSize: 11, color: C.textFaint }}>
                  {undecided} unentschieden — bleiben offen
                </span>
              )}
            </div>

            <button
              data-testid="apply-decisions"
              onClick={() => void apply()}
              disabled={
                applying || (approved.length === 0 && rejected.length === 0)
              }
              style={{
                width: "100%",
                padding: "9px 0",
                borderRadius: 7,
                border: "none",
                background:
                  applying || (approved.length === 0 && rejected.length === 0)
                    ? C.elevated
                    : C.accent,
                color:
                  applying || (approved.length === 0 && rejected.length === 0)
                    ? C.textFaint
                    : "#1a1110",
                fontSize: 13,
                fontWeight: 600,
                fontFamily: FONT.ui,
                cursor:
                  applying || (approved.length === 0 && rejected.length === 0)
                    ? "default"
                    : "pointer",
              }}
            >
              {applying
                ? "wird übernommen…"
                : `Entscheidung übernehmen — ${approved.length} freigeben, ${rejected.length} ablehnen`}
            </button>

            {/* Der schwere Teil steht ausgeschrieben unter dem Knopf, damit er
                nicht in einer Zahl untergeht. */}
            {heavyApproved > 0 && (
              <div
                data-testid="heavy-warning"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11.5,
                  color: IMPACT_COLOR.heavy,
                }}
              >
                <AlertTriangle size={13} />
                Davon {heavyApproved}, die bestehende Notizen verändern.
              </div>
            )}
          </footer>
        )}
      </aside>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */

function ResultBlock({
  result,
  onDismiss,
}: {
  result: IngestProposalsApplyResult;
  onDismiss: () => void;
}) {
  const skipped = result.skipped ?? [];
  return (
    <div
      data-testid="apply-result"
      style={{
        borderBottom: `1px solid ${C.border}`,
        padding: "10px 14px",
        background: C.elevated,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Check size={14} style={{ color: C.ok }} aria-hidden="true" />
        <span style={{ fontSize: 12.5 }}>
          {(result.applied ?? []).length} angewandt
          {skipped.length > 0 ? `, ${skipped.length} nicht möglich` : ""}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onDismiss}
          aria-label="Ergebnis ausblenden"
          style={{
            border: "none",
            background: "transparent",
            color: C.textDim,
            cursor: "pointer",
            padding: 2,
            display: "flex",
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Jeder übersprungene Vorschlag mit Grund. Ohne diesen Block hätte der
          Nutzer freigegeben und nichts wäre passiert, ohne dass er es erfährt. */}
      {skipped.length > 0 && (
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.5,
              color: C.err,
              marginBottom: 4,
            }}
          >
            <Ban size={12} />
            NICHT ANGEWANDT ({skipped.length})
          </div>
          {skipped.map((s) => (
            <div
              key={s.id}
              style={{
                fontFamily: FONT.mono,
                fontSize: 11,
                padding: "3px 0",
                borderBottom: `1px solid ${C.borderSoft}`,
              }}
            >
              <div
                style={{
                  color: C.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {s.id}
              </div>
              <div style={{ color: C.err, fontSize: 10.5 }}>
                {s.reason || "ohne Angabe"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ProposalCardProps {
  proposal: IngestProposal;
  decision: Decision | null;
  onDecide: (next: Decision | null) => void;
  onOpenNote: (noteId: string) => void;
}

function ProposalCard({
  proposal,
  decision,
  onDecide,
  onOpenNote,
}: ProposalCardProps) {
  const meta = ACTIONS[proposal.action] ?? ACTIONS.skip;
  const color = IMPACT_COLOR[meta.impact];
  const Icon = meta.icon;
  const rejectedHere = decision === "reject";

  return (
    <div
      data-testid={`proposal-${proposal.id}`}
      data-impact={meta.impact}
      style={{
        background: C.elevated,
        border: `1px solid ${decision === "approve" ? color : C.border}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        opacity: rejectedHere ? 0.6 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon size={14} style={{ color, flexShrink: 0 }} aria-hidden="true" />
        <span
          style={{
            fontSize: 9.5,
            fontFamily: FONT.mono,
            color,
            border: `1px solid ${color}`,
            borderRadius: 4,
            padding: "1px 6px",
            letterSpacing: 0.4,
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          {meta.label}
        </span>
      </div>

      <div
        style={{
          fontSize: 12.5,
          color: C.text,
          lineHeight: 1.45,
          textDecoration: rejectedHere ? "line-through" : "none",
        }}
      >
        {proposal.rationale}
      </div>

      <div style={{ fontSize: 11.5, color: C.textDim, lineHeight: 1.45 }}>
        {meta.consequence}
      </div>

      {/* Die betroffenen Notizen mit Pfad und Rolle — „neu" und „betroffen"
          auseinanderzuhalten ist bei `merge` der ganze Unterschied. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <NoteRef
          role="neu importiert"
          noteId={proposal.sourceNoteId}
          onOpenNote={onOpenNote}
        />
        {proposal.targetNoteId && (
          <NoteRef
            role="betroffen"
            noteId={proposal.targetNoteId}
            onOpenNote={onOpenNote}
          />
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginTop: 2,
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: decision === "approve" ? C.text : C.textDim,
            cursor: "pointer",
            fontWeight: decision === "approve" ? 600 : 400,
          }}
        >
          <input
            type="checkbox"
            data-testid={`approve-${proposal.id}`}
            checked={decision === "approve"}
            onChange={(e) => onDecide(e.target.checked ? "approve" : null)}
          />
          Freigeben
        </label>

        <button
          type="button"
          data-testid={`reject-${proposal.id}`}
          onClick={() => onDecide(rejectedHere ? null : "reject")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 9px",
            background: rejectedHere ? C.hover : "transparent",
            border: `1px solid ${rejectedHere ? C.borderStrong : C.border}`,
            borderRadius: 6,
            color: rejectedHere ? C.text : C.textDim,
            fontSize: 11.5,
            fontFamily: FONT.ui,
            cursor: "pointer",
          }}
        >
          <Ban size={12} />
          {rejectedHere ? "abgelehnt" : "Ablehnen"}
        </button>

        <span
          style={{
            fontSize: 10.5,
            color: C.textFaint,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Info size={11} />
          Ablehnen löscht nichts — der Vorschlag bleibt im Protokoll.
        </span>
      </div>
    </div>
  );
}

function NoteRef({
  role,
  noteId,
  onOpenNote,
}: {
  role: string;
  noteId: string;
  onOpenNote: (noteId: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        borderLeft: `2px solid ${C.border}`,
        paddingLeft: 8,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: C.textFaint,
          fontFamily: FONT.mono,
          minWidth: 82,
        }}
      >
        {role}
      </span>
      <button
        onClick={() => onOpenNote(noteId)}
        title={noteId}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          background: "transparent",
          border: "none",
          padding: 0,
          color: C.accent,
          fontSize: 12,
          fontFamily: FONT.mono,
          cursor: "pointer",
          textAlign: "left",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {noteId}
        <ArrowUpRight size={11} aria-hidden="true" />
      </button>
    </div>
  );
}
