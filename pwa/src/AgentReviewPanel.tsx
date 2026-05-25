import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  X,
  RefreshCw,
  Bot,
  Brain,
  ListChecks,
  Network,
  AlertTriangle,
  Info,
  AlertCircle,
  Check,
  ExternalLink,
  Loader2,
} from "lucide-react";
import {
  api,
  type AgentReviewQueue,
  type LintFindingItem,
  type LintSeverity,
  type Mem0ReviewItem,
  type Mem0Operation,
  type TopicNoteItem,
} from "./api.js";
import { C, FONT } from "./theme.js";
import { useIsMobile } from "./responsive.js";

/**
 * Phase C Wave C3 / Story 1 — Agent-Review Panel.
 *
 * Slide-over from the right, three tabs (mem0, lint, topics) plus an "All"
 * view. Reads the aggregated `/api/agent-review/queue` endpoint and offers
 * per-item accept/reject/dismiss actions that delegate to the existing
 * Wave C1 routes (`/api/mem0/review/*`, `/api/lint/findings/*`) or the
 * new Wave C3 topic-note routes (`/api/agent-review/topic-note/*`).
 *
 * The panel always refreshes the queue after a successful action so the
 * count badge in the header stays in sync with the on-disk truth.
 */

interface AgentReviewPanelProps {
  open: boolean;
  onClose: () => void;
  /** Opens a note in the main editor (used by the "View" action). */
  onOpenNote: (noteId: string) => void;
  /**
   * Called after every successful refresh so the App header badge can mirror
   * the latest pending count without firing its own fetch.
   */
  onCountChange?: (totalPending: number) => void;
}

type Tab = "all" | "mem0" | "lint" | "topics";

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

const OPERATION_COLOR: Record<Mem0Operation, string> = {
  ADD: "#22C55E",
  UPDATE: "#3B82F6",
  DELETE: C.err,
  NOOP: C.textFaint,
};

export function AgentReviewPanel({
  open,
  onClose,
  onOpenNote,
  onCountChange,
}: AgentReviewPanelProps) {
  const [tab, setTab] = useState<Tab>("all");
  const [queue, setQueue] = useState<AgentReviewQueue | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** ids of items currently being acted on — disables their buttons. */
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = await api.getAgentReviewQueue(30);
      setQueue(q);
      onCountChange?.(q.totalPending);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Laden fehlgeschlagen");
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  // Phase D Wave D1 — slide-over goes full-width on mobile so the action
  // buttons inside each review row aren't squeezed into a 50%-screen pane.
  const isMobile = useIsMobile();

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Esc closes the panel — same UX contract as Settings/Import.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const counts = useMemo(() => {
    if (!queue) return { all: 0, mem0: 0, lint: 0, topics: 0 };
    return {
      all: queue.totalPending,
      mem0: queue.mem0.length,
      lint: queue.lint.length,
      topics: queue.topicNotes.length,
    };
  }, [queue]);

  /**
   * Wraps an action so the per-item busy state, error surface and refresh
   * are handled identically across all 7 accept/reject/dismiss flows. We
   * intentionally re-fetch the whole queue after each action — items can
   * disappear from multiple tabs (e.g. accepting a mem0 UPDATE deletes the
   * source-capture note which might also be the target of a lint finding),
   * and a delta update would have to encode that cross-stream invalidation
   * client-side, which isn't worth the complexity.
   */
  const runAction = useCallback(
    async (id: string, fn: () => Promise<void>) => {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Aktion fehlgeschlagen");
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [refresh],
  );

  const showMem0 = tab === "all" || tab === "mem0";
  const showLint = tab === "all" || tab === "lint";
  const showTopics = tab === "all" || tab === "topics";

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
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

      {/* Panel */}
      <aside
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: isMobile ? "100vw" : 480,
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
        {/* Header */}
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
          <Bot size={18} style={{ color: C.accent }} aria-hidden="true" />
          <strong style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
            Agent Review
          </strong>
          <button
            onClick={() => void refresh()}
            title="Neu laden"
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
            <RefreshCw
              size={16}
              className={loading ? "sw-spin" : undefined}
            />
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

        {/* Tabs */}
        <div
          style={{
            display: "flex",
            gap: 0,
            padding: "8px 10px 0 10px",
            borderBottom: `1px solid ${C.border}`,
            flexShrink: 0,
            background: C.panel,
          }}
        >
          <TabButton
            label="Alle"
            icon={ListChecks}
            count={counts.all}
            active={tab === "all"}
            onClick={() => setTab("all")}
          />
          <TabButton
            label="Mem0"
            icon={Brain}
            count={counts.mem0}
            active={tab === "mem0"}
            onClick={() => setTab("mem0")}
          />
          <TabButton
            label="Lint"
            icon={AlertTriangle}
            count={counts.lint}
            active={tab === "lint"}
            onClick={() => setTab("lint")}
          />
          <TabButton
            label="Topics"
            icon={Network}
            count={counts.topics}
            active={tab === "topics"}
            onClick={() => setTab("topics")}
          />
        </div>

        {/* Error banner */}
        {error && (
          <div
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

        {/* Body */}
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
          {loading && !queue && (
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

          {queue && counts.all === 0 && (
            <div
              style={{
                color: C.textFaint,
                fontSize: 12.5,
                fontFamily: FONT.mono,
                padding: "12px 0",
              }}
            >
              keine offenen agent-vorschläge
            </div>
          )}

          {queue && showMem0 &&
            queue.mem0.map((item) => (
              <Mem0Card
                key={item.id}
                item={item}
                busy={busyIds.has(item.id)}
                onOpenNote={onOpenNote}
                onAccept={() =>
                  void runAction(item.id, () => api.acceptMem0Review(item.id))
                }
                onReject={() =>
                  void runAction(item.id, () => api.rejectMem0Review(item.id))
                }
              />
            ))}

          {queue && showLint &&
            queue.lint.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                busy={busyIds.has(item.id)}
                onOpenNote={onOpenNote}
                onAcknowledge={() =>
                  void runAction(item.id, () =>
                    api.acknowledgeLintFinding(item.id),
                  )
                }
                onMarkFixed={() =>
                  void runAction(item.id, () =>
                    api.markLintFindingFixed(item.id),
                  )
                }
                onDismiss={() =>
                  void runAction(item.id, () =>
                    api.dismissLintFinding(item.id),
                  )
                }
              />
            ))}

          {queue && showTopics &&
            queue.topicNotes.map((item) => (
              <TopicCard
                key={item.id}
                item={item}
                busy={busyIds.has(item.id)}
                onOpenNote={onOpenNote}
                onAccept={() =>
                  void runAction(item.id, () => api.acceptTopicNote(item.id))
                }
                onReject={() =>
                  void runAction(item.id, () => api.rejectTopicNote(item.id))
                }
              />
            ))}
        </div>
      </aside>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Sub-components                                                           */
/* ──────────────────────────────────────────────────────────────────────── */

interface TabButtonProps {
  label: string;
  icon: typeof ListChecks;
  count: number;
  active: boolean;
  onClick: () => void;
}

function TabButton({ label, icon: Icon, count, active, onClick }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 12px",
        background: "transparent",
        border: "none",
        borderBottom: `2px solid ${active ? C.accent : "transparent"}`,
        color: active ? C.text : C.textDim,
        fontSize: 12.5,
        fontFamily: FONT.ui,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        marginBottom: -1,
      }}
    >
      <Icon size={13} style={{ color: active ? C.accent : C.textFaint }} />
      {label}
      <span
        style={{
          fontSize: 10.5,
          fontFamily: FONT.mono,
          color: active ? C.accent : C.textFaint,
          background: active ? "rgba(249,115,22,0.12)" : C.elevated,
          borderRadius: 8,
          padding: "1px 6px",
          minWidth: 16,
          textAlign: "center",
        }}
      >
        {count}
      </span>
    </button>
  );
}

interface CardShellProps {
  badge: { label: string; color: string };
  title: string;
  meta?: string;
  body: ReactNode;
  actions: ReactNode;
}

function CardShell({ badge, title, meta, body, actions }: CardShellProps) {
  return (
    <div
      style={{
        background: C.elevated,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 9.5,
            fontFamily: FONT.mono,
            color: badge.color,
            border: `1px solid ${badge.color}`,
            borderRadius: 4,
            padding: "1px 6px",
            letterSpacing: 0.4,
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          {badge.label}
        </span>
        <strong
          style={{
            flex: 1,
            fontSize: 13,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={title}
        >
          {title}
        </strong>
      </div>
      {meta && (
        <div
          style={{
            fontSize: 10.5,
            color: C.textFaint,
            fontFamily: FONT.mono,
          }}
        >
          {meta}
        </div>
      )}
      <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.45 }}>
        {body}
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          marginTop: 4,
          flexWrap: "wrap",
        }}
      >
        {actions}
      </div>
    </div>
  );
}

interface ActionButtonProps {
  label: string;
  variant: "accent" | "danger" | "muted";
  disabled?: boolean;
  onClick: () => void;
  icon?: typeof Check;
}

function ActionButton({
  label,
  variant,
  disabled,
  onClick,
  icon: Icon,
}: ActionButtonProps) {
  const styles: Record<ActionButtonProps["variant"], { bg: string; fg: string; border: string }> = {
    accent: { bg: C.accent, fg: "#1a1110", border: C.accent },
    danger: { bg: "transparent", fg: C.err, border: C.err },
    muted: { bg: "transparent", fg: C.textDim, border: C.border },
  };
  const s = styles[variant];
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

/* ──── Mem0 card ──── */

interface Mem0CardProps {
  item: Mem0ReviewItem;
  busy: boolean;
  onOpenNote: (id: string) => void;
  onAccept: () => void;
  onReject: () => void;
}

function Mem0Card({ item, busy, onOpenNote, onAccept, onReject }: Mem0CardProps) {
  const pct = Math.round(item.confidence * 100);
  const meta = item.targetNoteId
    ? `${item.noteId} → ${item.targetNoteId} · confidence ${pct}%`
    : `${item.noteId} · confidence ${pct}%`;
  return (
    <CardShell
      badge={{
        label: `MEM0 · ${item.operation}`,
        color: OPERATION_COLOR[item.operation],
      }}
      title={item.reasoning.split("\n")[0]?.slice(0, 80) ?? item.operation}
      meta={meta}
      body={
        <div style={{ whiteSpace: "pre-wrap" }}>{item.reasoning}</div>
      }
      actions={
        <>
          <ActionButton
            label="Accept"
            variant="accent"
            icon={Check}
            disabled={busy}
            onClick={onAccept}
          />
          <ActionButton
            label="Reject"
            variant="danger"
            disabled={busy}
            onClick={onReject}
          />
          <ActionButton
            label="View"
            variant="muted"
            icon={ExternalLink}
            disabled={busy}
            onClick={() => onOpenNote(item.targetNoteId ?? item.noteId)}
          />
        </>
      }
    />
  );
}

/* ──── Lint card ──── */

interface LintCardProps {
  item: LintFindingItem;
  busy: boolean;
  onOpenNote: (id: string) => void;
  onAcknowledge: () => void;
  onMarkFixed: () => void;
  onDismiss: () => void;
}

function LintCard({
  item,
  busy,
  onOpenNote,
  onAcknowledge,
  onMarkFixed,
  onDismiss,
}: LintCardProps) {
  const SevIcon = SEVERITY_ICON[item.severity];
  const primary = item.noteIds[0];
  return (
    <CardShell
      badge={{
        label: `LINT · ${item.kind.replace("_", " ")}`,
        color: SEVERITY_COLOR[item.severity],
      }}
      title={item.message}
      meta={`${item.noteIds.length} note${item.noteIds.length === 1 ? "" : "s"} · ${item.severity}`}
      body={
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
          <SevIcon
            size={13}
            style={{
              color: SEVERITY_COLOR[item.severity],
              flexShrink: 0,
              marginTop: 2,
            }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: FONT.mono, fontSize: 11, color: C.textFaint }}>
              {item.noteIds.slice(0, 3).join(", ")}
              {item.noteIds.length > 3 && ` +${item.noteIds.length - 3}`}
            </div>
          </div>
        </div>
      }
      actions={
        <>
          <ActionButton
            label="Acknowledge"
            variant="accent"
            icon={Check}
            disabled={busy}
            onClick={onAcknowledge}
          />
          <ActionButton
            label="Mark Fixed"
            variant="muted"
            disabled={busy}
            onClick={onMarkFixed}
          />
          <ActionButton
            label="Dismiss"
            variant="danger"
            disabled={busy}
            onClick={onDismiss}
          />
          {primary && (
            <ActionButton
              label="View"
              variant="muted"
              icon={ExternalLink}
              disabled={busy}
              onClick={() => onOpenNote(primary)}
            />
          )}
        </>
      }
    />
  );
}

/* ──── Topic card ──── */

interface TopicCardProps {
  item: TopicNoteItem;
  busy: boolean;
  onOpenNote: (id: string) => void;
  onAccept: () => void;
  onReject: () => void;
}

function TopicCard({ item, busy, onOpenNote, onAccept, onReject }: TopicCardProps) {
  const pct =
    item.confidence !== null ? `${Math.round(item.confidence * 100)}%` : "—";
  const meta = `Cluster of ${item.sourceNotes.length} notes · confidence ${pct}`;
  return (
    <CardShell
      badge={{ label: "TOPIC · auto-synth", color: "#A855F7" }}
      title={item.title}
      meta={meta}
      body={
        <div style={{ fontStyle: "italic", color: C.textFaint }}>
          {item.bodyPreview || "(empty)"}
        </div>
      }
      actions={
        <>
          <ActionButton
            label="Accept (move)"
            variant="accent"
            icon={Check}
            disabled={busy}
            onClick={onAccept}
          />
          <ActionButton
            label="Reject (delete)"
            variant="danger"
            disabled={busy}
            onClick={onReject}
          />
          <ActionButton
            label="View"
            variant="muted"
            icon={ExternalLink}
            disabled={busy}
            onClick={() => onOpenNote(item.id)}
          />
        </>
      }
    />
  );
}
