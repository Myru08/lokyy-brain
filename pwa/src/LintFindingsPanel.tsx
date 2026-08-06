import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  AlertCircle,
  Check,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import type { LintFindingItem, LintSeverity } from "./api.js";
import { C, FONT } from "./theme.js";
import { useIsMobile } from "./responsive.js";

/**
 * Lint-Funde-Panel (Story „Widerspruchs-Warnkasten", Paket B / AC3+AC4).
 *
 * Zeigt alle OFFENEN Funde mit beiden Aussagen im Klartext, nicht nur mit
 * Note-IDs — sonst muss man erst zwei Notizen öffnen, um zu verstehen, worum
 * der Streit geht. Von hier aus:
 *
 *   - „Kasten in Notiz"  → schreibt den Warnkasten in die betroffenen Notizen
 *   - „Auflösen"         → verlangt eine Entscheidung (welche Aussage gilt,
 *                          oder „beide ok"), schließt den Fund UND entfernt
 *                          den Kasten wieder
 *
 * Die Entscheidungspflicht ist Absicht: „Auflösen" ohne Auswahl wäre nur ein
 * Löschen des Kastens. Die Regel steht deshalb auch sichtbar im Panel —
 * Quelle reparieren, nicht nur den Kasten löschen.
 *
 * Die Fetches liegen bewusst lokal in dieser Datei statt in `api.ts`: die
 * Routen sind neu und `api.ts` wird parallel von anderen Arbeitspaketen
 * angefasst. Migration in den zentralen Client ist ein WIRING-TODO.
 */

const BOTH_OK = "both_ok";

export interface LintStatement {
  noteId: string;
  title: string;
  text: string;
}

export interface LintFindingWithStatements extends LintFindingItem {
  statements: LintStatement[];
}

interface LintFindingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Öffnet eine Notiz im Editor. */
  onOpenNote: (noteId: string) => void;
  /** Meldet die Anzahl offener Funde nach jedem Refresh (Badge im Header). */
  onCountChange?: (openCount: number) => void;
}

const SEVERITY_COLOR: Record<LintSeverity, string> = {
  info: "#3B82F6",
  warning: "#F59E0B",
  error: C.err,
};

const SEVERITY_ICON: Record<LintSeverity, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle,
};

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Alter eines Fundes in Alltagssprache — „seit 3 Tagen offen" liest sich besser als ein Timestamp. */
export function ageLabel(detectedAt: string, now: number = Date.now()): string {
  const ts = new Date(detectedAt).getTime();
  if (!Number.isFinite(ts)) return "unbekannt";
  const days = Math.floor((now - ts) / 86_400_000);
  if (days <= 0) return "heute entdeckt";
  if (days === 1) return "seit gestern offen";
  return `seit ${days} Tagen offen`;
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data.error) return data.error;
  } catch {
    // Antwort war kein JSON — Statuszeile genügt.
  }
  return `HTTP ${res.status}`;
}

async function fetchOpenFindings(): Promise<LintFindingWithStatements[]> {
  const res = await fetch(
    "/api/lint/findings?status=open&withStatements=1&limit=100",
    { credentials: "include" },
  );
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as { findings?: LintFindingWithStatements[] };
  return data.findings ?? [];
}

async function postLint(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`/api/lint${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export function LintFindingsPanel({
  open,
  onClose,
  onOpenNote,
  onCountChange,
}: LintFindingsPanelProps) {
  const [findings, setFindings] = useState<LintFindingWithStatements[] | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchOpenFindings();
      setFindings(rows);
      onCountChange?.(rows.length);
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

  const runAction = useCallback(
    async (id: string, fn: () => Promise<void>) => {
      setBusyId(id);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Aktion fehlgeschlagen");
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  return (
    <>
      <div
        onClick={onClose}
        data-testid="lint-backdrop"
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
        aria-label="Lint-Funde"
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
          <AlertTriangle size={18} style={{ color: "#F59E0B" }} aria-hidden="true" />
          <strong style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
            Offene Funde{findings ? ` (${findings.length})` : ""}
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
              padding: 4,
            }}
          >
            <X size={16} />
          </button>
        </header>

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
          Quelle reparieren, nicht nur den Kasten löschen — beim Auflösen musst
          du entscheiden, welche Aussage gilt.
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

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {loading && !findings && (
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

          {findings && findings.length === 0 && (
            <div
              style={{
                color: C.textFaint,
                fontSize: 12.5,
                fontFamily: FONT.mono,
                padding: "12px 0",
              }}
            >
              keine offenen funde
            </div>
          )}

          {findings?.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              busy={busyId === finding.id}
              onOpenNote={onOpenNote}
              onWriteCallout={() =>
                void runAction(finding.id, () =>
                  postLint(`/findings/${finding.id}/callout`),
                )
              }
              onResolve={(choice) =>
                void runAction(finding.id, () =>
                  postLint(`/findings/${finding.id}/resolve`, { choice }),
                )
              }
            />
          ))}
        </div>
      </aside>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */

interface FindingCardProps {
  finding: LintFindingWithStatements;
  busy: boolean;
  onOpenNote: (noteId: string) => void;
  onWriteCallout: () => void;
  onResolve: (choice: string) => void;
}

function FindingCard({
  finding,
  busy,
  onOpenNote,
  onWriteCallout,
  onResolve,
}: FindingCardProps) {
  const [resolving, setResolving] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const SevIcon = SEVERITY_ICON[finding.severity] ?? AlertTriangle;
  const color = SEVERITY_COLOR[finding.severity] ?? C.err;
  const statements = finding.statements ?? [];

  return (
    <div
      style={{
        background: C.elevated,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SevIcon size={14} style={{ color, flexShrink: 0 }} aria-hidden="true" />
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
          {finding.kind.replace("_", " ")}
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: C.textFaint,
            fontFamily: FONT.mono,
            marginLeft: "auto",
          }}
        >
          {ageLabel(finding.detectedAt)}
        </span>
      </div>

      <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.45 }}>
        {finding.message}
      </div>

      {statements.map((statement, i) => (
        <div
          key={statement.noteId}
          style={{
            borderLeft: `2px solid ${C.border}`,
            paddingLeft: 8,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <button
            onClick={() => onOpenNote(statement.noteId)}
            title={statement.noteId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              background: "transparent",
              border: "none",
              padding: 0,
              color: C.accent,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: FONT.ui,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            {LABELS[i] ?? i + 1} · {statement.title}
            <ExternalLink size={11} aria-hidden="true" />
          </button>
          <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.45 }}>
            {statement.text}
          </div>
        </div>
      ))}

      {!resolving && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
          <SmallButton
            label="Kasten in Notiz"
            variant="muted"
            disabled={busy}
            onClick={onWriteCallout}
          />
          <SmallButton
            label="Auflösen"
            variant="accent"
            disabled={busy}
            onClick={() => setResolving(true)}
          />
        </div>
      )}

      {resolving && (
        <fieldset
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: "8px 10px",
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <legend
            style={{
              fontSize: 11,
              color: C.textFaint,
              fontFamily: FONT.mono,
              padding: "0 4px",
            }}
          >
            Was gilt?
          </legend>

          {statements.map((statement, i) => (
            <label
              key={statement.noteId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: C.textDim,
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name={`resolve-${finding.id}`}
                value={statement.noteId}
                checked={choice === statement.noteId}
                onChange={() => setChoice(statement.noteId)}
              />
              {LABELS[i] ?? i + 1} gilt — {statement.title}
            </label>
          ))}

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: C.textDim,
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name={`resolve-${finding.id}`}
              value={BOTH_OK}
              checked={choice === BOTH_OK}
              onChange={() => setChoice(BOTH_OK)}
            />
            beide ok — kein echter Widerspruch
          </label>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <SmallButton
              label="Auflösen & Kasten entfernen"
              variant="accent"
              icon={Check}
              disabled={busy || choice === null}
              onClick={() => {
                if (choice) onResolve(choice);
              }}
            />
            <SmallButton
              label="Abbrechen"
              variant="muted"
              disabled={busy}
              onClick={() => {
                setResolving(false);
                setChoice(null);
              }}
            />
          </div>
        </fieldset>
      )}
    </div>
  );
}

interface SmallButtonProps {
  label: string;
  variant: "accent" | "muted";
  disabled?: boolean;
  onClick: () => void;
  icon?: typeof Check;
}

function SmallButton({
  label,
  variant,
  disabled,
  onClick,
  icon: Icon,
}: SmallButtonProps) {
  const s =
    variant === "accent"
      ? { bg: C.accent, fg: "#1a1110", border: C.accent }
      : { bg: "transparent", fg: C.textDim, border: C.border };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "5px 10px",
        background: disabled ? C.elevated : s.bg,
        border: `1px solid ${disabled ? C.border : s.border}`,
        borderRadius: 6,
        color: disabled ? C.textFaint : s.fg,
        fontSize: 11.5,
        fontWeight: 600,
        fontFamily: FONT.ui,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {Icon && <Icon size={12} />}
      {label}
    </button>
  );
}
