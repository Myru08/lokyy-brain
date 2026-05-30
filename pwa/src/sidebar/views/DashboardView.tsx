import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  api,
  type DashboardSummary,
  type DashboardActivity,
  type DashboardActivityDay,
  type DashboardLooseEnds,
  type AgentReviewQueue,
} from "../../api.js";
import { C, FONT } from "../../theme.js";
import type { ViewProps } from "./registry.js";

/**
 * DashboardView — echter Renderer für `viewType: "dashboard"` (Story 11.11).
 *
 * Home-Landing als **Bento-Grid**: das Vault-Wissens-Cockpit. Zeigt die
 * wichtigsten Vault-Zahlen, Git-Aktivität, Streak, zuletzt Bearbeitetes,
 * heutiges Journal, Serendipity, lose Enden, Sync/System, Quick-Capture +
 * Quick-Actions und die Konsolidierungs-Warteschlange.
 *
 * Ausrichtung (O-5): Vault-Wissens-Cockpit + Entdeckung — **keine**
 * Projekte/Tasks/Ziele (das ist Life-OS → separates Lokyy OS).
 *
 * Datenquelle (Addendum §0): ausschließlich die bestehenden HTTP-Routen über
 * `api.*`. KEIN MCP-Client im Browser, kein `@lokyy/core`-Import.
 *
 * Latenz (Addendum §5):
 *   - `getDashboard()` (billig) wird synchron beim Mount geladen.
 *   - `getDashboardActivity()` + `getDashboardLooseEnds()` (teuer) laden LAZY
 *     nach; bis dahin Skeleton. Die Konsolidierungs-Kachel zieht zusätzlich
 *     `getAgentReviewQueue()` und degradiert leer (R-1).
 *
 * Kein eigener Routing-/Editor-State: Klicks delegieren über `onOpenNote` in
 * `App.open()`. Quick-Capture postet an die bestehende Pipe-Route via
 * `api.share()`; das heutige Journal wird bei Bedarf via `api.createNote()`
 * unter `40_daily/` angelegt.
 *
 * [Source: epic-11-architecture-addendum.md §5 + §7 R-1; Story 11.11]
 */

/** Vault-Ordner für die täglichen Journal-Notizen. */
const DAILY_FOLDER = "40_daily";

/* ── kleine Helfer ───────────────────────────────────────────────────────── */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Lokales `YYYY-MM-DD` für heute (für die Journal-Karte). */
function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** Relative deutsche Zeitangabe aus einem ISO-Timestamp ("vor 3 Std."). */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days < 30) return `vor ${days} ${days === 1 ? "Tag" : "Tagen"}`;
  const months = Math.round(days / 30);
  return `vor ${months} ${months === 1 ? "Monat" : "Monaten"}`;
}

/* ── Kachel-Primitive ──────────────────────────────────────────────────────── */

/**
 * Eine Bento-Kachel. `span`/`rowSpan` steuern, wie viele Grid-Spalten/Zeilen
 * sie belegt (responsives auto-fill-Grid, s. Container unten).
 */
function Tile({
  title,
  span = 1,
  rowSpan = 1,
  children,
}: {
  title: string;
  span?: number;
  rowSpan?: number;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        gridColumn: `span ${span}`,
        gridRow: `span ${rowSpan}`,
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          color: C.gold,
          fontFamily: FONT.mono,
          fontSize: 11,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 10,
          flexShrink: 0,
        }}
      >
        {title}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </section>
  );
}

/** Eine große Kennzahl mit Beschriftung. */
function Stat({
  value,
  label,
  accent = false,
}: {
  value: ReactNode;
  label: string;
  accent?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div
        style={{
          color: accent ? C.accent : C.text,
          fontFamily: FONT.serif,
          fontSize: 34,
          fontWeight: 600,
          lineHeight: 1.05,
        }}
      >
        {value}
      </div>
      <div style={{ color: C.textDim, fontSize: 12 }}>{label}</div>
    </div>
  );
}

/** Klickbare Zeile (Notiz-Link) — delegiert in `onOpenNote`. */
function NoteRow({
  label,
  meta,
  onOpen,
}: {
  label: string;
  meta?: string;
  onOpen: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: "pointer",
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 8,
        padding: "5px 7px",
        borderRadius: 6,
        background: hover ? C.elevated : "transparent",
        transition: "background 100ms ease",
        outline: "none",
      }}
    >
      <span
        style={{
          color: C.text,
          fontSize: 13,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {label}
      </span>
      {meta && (
        <span
          style={{
            color: C.textFaint,
            fontFamily: FONT.mono,
            fontSize: 10.5,
            flexShrink: 0,
          }}
        >
          {meta}
        </span>
      )}
    </div>
  );
}

/** Schmaler Skeleton-Block für die lazy nachladenden Kacheln. */
function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 10,
            borderRadius: 5,
            background: C.elevated,
            width: `${90 - i * 12}%`,
          }}
        />
      ))}
    </div>
  );
}

const QUIET_HINT: CSSProperties = {
  color: C.textFaint,
  fontFamily: FONT.mono,
  fontSize: 11.5,
  lineHeight: 1.5,
};

/* ── Git-Activity-Heatmap (GitHub-Stil) ──────────────────────────────────── */

/** Vier Intensitätsstufen → Farbe (0 = leer, 3 = stark). */
function heatColor(commits: number, max: number): string {
  if (commits <= 0) return C.elevated;
  if (max <= 0) return C.accentSoft;
  const ratio = commits / max;
  if (ratio > 0.66) return C.accent;
  if (ratio > 0.33) return C.accentHi;
  return C.gold;
}

/**
 * GitHub-artige Wochen-Spalten-Heatmap aus den gap-gefüllten `days[]`.
 * Spalten = Wochen, Zeilen = Wochentage (So…Sa). Wir richten den Start auf
 * den Wochentag des ersten Tages aus, damit die Spalten sauber sitzen.
 */
function ActivityHeatmap({ days }: { days: DashboardActivityDay[] }) {
  const max = useMemo(
    () => days.reduce((m, d) => (d.commits > m ? d.commits : m), 0),
    [days],
  );
  // In Wochen-Spalten gruppieren (7 Zeilen, Index = Wochentag des Datums).
  const weeks = useMemo(() => {
    const cols: (DashboardActivityDay | null)[][] = [];
    let current: (DashboardActivityDay | null)[] = [];
    for (const day of days) {
      const dow = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      if (current.length === 0 && cols.length === 0 && dow > 0) {
        // Erste Spalte mit Leerzellen bis zum ersten Wochentag auffüllen.
        for (let i = 0; i < dow; i++) current.push(null);
      }
      current.push(day);
      if (current.length === 7) {
        cols.push(current);
        current = [];
      }
    }
    if (current.length > 0) {
      while (current.length < 7) current.push(null);
      cols.push(current);
    }
    return cols;
  }, [days]);

  if (days.length === 0) {
    return <div style={QUIET_HINT}>Noch keine Commit-Aktivität.</div>;
  }

  return (
    <div style={{ overflowX: "auto", paddingBottom: 2 }}>
      <div style={{ display: "flex", gap: 3 }}>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {week.map((day, di) => (
              <div
                key={di}
                title={day ? `${day.date}: ${day.commits} Commit(s)` : ""}
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 2.5,
                  background: day ? heatColor(day.commits, max) : "transparent",
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Quick-Action-Button + Quick-Capture ───────────────────────────────────── */

function ActionButton({
  label,
  onClick,
  primary = false,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: "pointer",
        fontFamily: FONT.ui,
        fontSize: 12.5,
        fontWeight: 600,
        padding: "7px 12px",
        borderRadius: 7,
        border: `1px solid ${primary ? C.accent : C.border}`,
        background: primary
          ? hover
            ? C.accentHi
            : C.accent
          : hover
            ? C.elevated
            : C.panel,
        color: primary ? "#13171D" : C.text,
        transition: "background 100ms ease, border-color 100ms ease",
      }}
    >
      {label}
    </button>
  );
}

/* ── Haupt-View ─────────────────────────────────────────────────────────────── */

export function DashboardView({ onOpenNote }: ViewProps) {
  // Billige Kacheln — synchron beim Mount.
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);

  // Teure Kacheln — lazy.
  const [activity, setActivity] = useState<DashboardActivity | null>(null);
  const [looseEnds, setLooseEnds] = useState<DashboardLooseEnds | null>(null);
  const [review, setReview] = useState<AgentReviewQueue | null>(null);

  // Quick-Capture.
  const [capture, setCapture] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    setSummaryErr(null);
    try {
      setSummary(await api.getDashboard());
    } catch (e) {
      setSummaryErr(
        e instanceof Error ? e.message : "Dashboard konnte nicht geladen werden",
      );
    }
  }, []);

  useEffect(() => {
    void loadSummary();
    // Teure Kacheln lazy nachladen; einzelne Fehler dürfen das Dashboard
    // NICHT killen — pro Kachel still degradieren.
    void api.getDashboardActivity().then(setActivity).catch(() => setActivity(null));
    void api
      .getDashboardLooseEnds()
      .then(setLooseEnds)
      .catch(() => setLooseEnds(null));
    // R-1: Konsolidierung darf leer/fehlend sein.
    void api.getAgentReviewQueue().then(setReview).catch(() => setReview(null));
  }, [loadSummary]);

  // Heutiges Journal öffnen oder anlegen.
  const openOrCreateToday = useCallback(async () => {
    if (summary?.today) {
      onOpenNote(summary.today.id);
      return;
    }
    const path = `${DAILY_FOLDER}/${todayKey()}`;
    try {
      const note = await api.createNote(path);
      onOpenNote(note.id);
      void loadSummary(); // today-Kachel auffrischen
    } catch {
      // Falls die Notiz bereits existiert (Race), trotzdem öffnen.
      onOpenNote(path);
    }
  }, [summary, onOpenNote, loadSummary]);

  const submitCapture = useCallback(async () => {
    const text = capture.trim();
    if (!text || capturing) return;
    setCapturing(true);
    setCaptureMsg(null);
    try {
      // Erkennt der Text eine URL? Dann als `url` mitschicken — der Pipe-
      // Handler routet sie passend (YouTube/Website); sonst reiner Text.
      const urlMatch = /\bhttps?:\/\/\S+/i.exec(text);
      await api.share(urlMatch ? { text, url: urlMatch[0] } : { text });
      setCapture("");
      setCaptureMsg("In die Pipe gelegt ✓");
    } catch (e) {
      setCaptureMsg(
        e instanceof Error ? e.message : "Capture fehlgeschlagen",
      );
    } finally {
      setCapturing(false);
    }
  }, [capture, capturing]);

  if (summaryErr) {
    return (
      <div style={{ padding: 16, color: C.err, fontFamily: FONT.mono, fontSize: 12 }}>
        {summaryErr}
      </div>
    );
  }

  if (!summary) {
    return (
      <div
        style={{ padding: 16, color: C.textFaint, fontFamily: FONT.mono, fontSize: 12 }}
      >
        Lade Dashboard…
      </div>
    );
  }

  const reviewTotal = review?.totalPending ?? 0;

  return (
    <div
      style={{
        padding: "16px 16px 28px",
        fontFamily: FONT.ui,
        overflowY: "auto",
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gridAutoRows: "minmax(120px, auto)",
          gridAutoFlow: "dense",
          gap: 12,
        }}
      >
        {/* Hero-Zahlen */}
        <Tile title="Vault" span={2}>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
            <Stat value={summary.counts.notes} label="Notizen" accent />
            <Stat value={summary.counts.tags} label="Tags" />
            <Stat
              value={Object.keys(summary.counts.byType).length}
              label="Typen"
            />
          </div>
        </Tile>

        {/* Vault-Gesundheit */}
        <Tile title="Gesundheit">
          <Stat
            value={summary.health.brokenLinks}
            label="defekte Links"
            accent={summary.health.brokenLinks > 0}
          />
          {summary.health.brokenTop.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {summary.health.brokenTop.slice(0, 4).map((b, i) => (
                <NoteRow
                  key={`${b.sourceId}-${i}`}
                  label={`↪ ${b.target}`}
                  onOpen={() => onOpenNote(b.sourceId)}
                />
              ))}
            </div>
          )}
        </Tile>

        {/* Sync / System */}
        <Tile title="System">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background:
                    summary.system.syncState === "clean" ||
                    summary.system.syncState === "synced"
                      ? C.ok
                      : C.gold,
                  flexShrink: 0,
                }}
              />
              <span style={{ color: C.text, fontSize: 13 }}>
                {summary.system.syncState || "unbekannt"}
              </span>
            </div>
            <div style={QUIET_HINT}>Vault: {summary.system.vaultId}</div>
          </div>
        </Tile>

        {/* Git-Activity-Heatmap + Streak */}
        <Tile title="Aktivität" span={2}>
          {activity ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <ActivityHeatmap days={activity.days} />
              <div style={{ display: "flex", gap: 24 }}>
                <Stat
                  value={`${activity.currentStreak}🔥`}
                  label="aktuelle Streak"
                  accent={activity.currentStreak > 0}
                />
                <Stat value={activity.longestStreak} label="längste Streak" />
              </div>
            </div>
          ) : (
            <Skeleton lines={4} />
          )}
        </Tile>

        {/* Zuletzt bearbeitet */}
        <Tile title="Zuletzt bearbeitet" span={2} rowSpan={2}>
          {summary.recent.length === 0 ? (
            <div style={QUIET_HINT}>Noch keine Notizen.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {summary.recent.map((r) => (
                <NoteRow
                  key={r.id}
                  label={r.title}
                  meta={relativeTime(r.updated)}
                  onOpen={() => onOpenNote(r.id)}
                />
              ))}
            </div>
          )}
        </Tile>

        {/* Heutiges Journal */}
        <Tile title="Heutiges Journal">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ color: C.textDim, fontSize: 13 }}>
              {summary.today
                ? summary.today.title || todayKey()
                : `Noch kein Eintrag für ${todayKey()}.`}
            </div>
            <ActionButton
              label={summary.today ? "Journal öffnen" : "Journal anlegen"}
              primary={!summary.today}
              onClick={() => void openOrCreateToday()}
            />
          </div>
        </Tile>

        {/* Serendipity */}
        <Tile title="Serendipität">
          {summary.serendipity ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={QUIET_HINT}>Zufällig aus deinem Vault:</div>
              <NoteRow
                label={summary.serendipity.title}
                onOpen={() => onOpenNote(summary.serendipity!.id)}
              />
            </div>
          ) : (
            <div style={QUIET_HINT}>Vault ist noch leer.</div>
          )}
        </Tile>

        {/* Lose Enden */}
        <Tile title="Lose Enden" span={2} rowSpan={2}>
          {looseEnds === null ? (
            <Skeleton lines={5} />
          ) : looseEnds.items.length === 0 ? (
            <div style={QUIET_HINT}>Keine offenen Punkte. Sauber. ✓</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {looseEnds.items.slice(0, 12).map((e, i) => (
                <NoteRow
                  key={`${e.noteId}-${e.line}-${i}`}
                  label={e.text || e.title}
                  meta={`:${e.line}`}
                  onOpen={() => onOpenNote(e.noteId)}
                />
              ))}
              {looseEnds.total > looseEnds.items.length && (
                <div style={{ ...QUIET_HINT, marginTop: 6 }}>
                  +{looseEnds.total - looseEnds.items.length} weitere
                </div>
              )}
            </div>
          )}
        </Tile>

        {/* Quick-Capture + Quick-Actions */}
        <Tile title="Quick-Capture" span={2}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea
              value={capture}
              onChange={(e) => setCapture(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void submitCapture();
                }
              }}
              placeholder="Gedanke oder URL… (⌘/Ctrl+Enter)"
              rows={2}
              style={{
                resize: "vertical",
                fontFamily: FONT.ui,
                fontSize: 13,
                color: C.text,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                padding: "8px 10px",
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <ActionButton
                label={capturing ? "Sende…" : "Erfassen"}
                primary
                onClick={() => void submitCapture()}
              />
              <ActionButton
                label="Heutiges Journal"
                onClick={() => void openOrCreateToday()}
              />
              {captureMsg && (
                <span style={{ ...QUIET_HINT, color: C.textDim }}>{captureMsg}</span>
              )}
            </div>
          </div>
        </Tile>

        {/* Konsolidierung (graceful empty) */}
        <Tile title="Konsolidierung">
          {reviewTotal === 0 ? (
            <div style={QUIET_HINT}>
              Keine offenen Vorschläge. Der Kurator meldet sich, wenn er etwas
              findet.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Stat value={reviewTotal} label="offene Vorschläge" accent />
              <div style={QUIET_HINT}>
                {review?.mem0.length ?? 0} Memo · {review?.lint.length ?? 0} Lint ·{" "}
                {review?.topicNotes.length ?? 0} Themen
              </div>
            </div>
          )}
        </Tile>
      </div>
    </div>
  );
}
