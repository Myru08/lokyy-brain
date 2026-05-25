import { useEffect, useRef, useState } from "react";
import { Editor } from "./editor/Editor.js";
import { DragHandle, useResizableWidth } from "./Resizable.js";
import { api } from "./api.js";
import { C, FONT } from "./theme.js";

/**
 * Split-View Editor — Obsidian-style.
 *
 * Renders the primary <Editor> full-width when `secondaryNoteId` is null.
 * When a secondary note id is set, renders a horizontal split with the
 * primary on the left, a resizable drag-handle, and the secondary on the
 * right. The secondary pane fetches its own body, debounce-saves on edit
 * (800ms via api.putNote), and routes wikilink clicks to `onSecondaryOpen`
 * so the parent can keep them inside the secondary pane.
 *
 * The parent owns navigation state. This component owns only the secondary
 * pane's body cache, save-state, and the resizable column width.
 */

interface SplitViewProps {
  primaryNoteId: string;
  primaryBody: string;
  onPrimaryChange: (body: string) => void;
  onOpenLink: (target: string) => void;
  secondaryNoteId: string | null;
  onClosePane: () => void;
  onSecondaryOpen: (id: string) => void;
  /** Outline-Jump für die Primary-Pane (siehe Editor.scrollToLine). */
  primaryScrollToLine?: number | null;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; title: string; body: string }
  | { kind: "error" };

const DEBOUNCE_MS = 800;

export function SplitView({
  primaryNoteId,
  primaryBody,
  onPrimaryChange,
  onOpenLink,
  secondaryNoteId,
  onClosePane,
  onSecondaryOpen,
  primaryScrollToLine,
}: SplitViewProps): JSX.Element {
  // Primary pane width (pixels). Default seeded once; resizable handle updates it.
  const [primaryWidth, setPrimaryWidth] = useResizableWidth({
    storageKey: "splitview-primary",
    defaultWidth: 600,
    min: 240,
    max: 2400,
  });

  // Secondary pane state — fetched on id change.
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFetchedId = useRef<string | null>(null);

  // Fetch secondary body whenever the id changes.
  useEffect(() => {
    if (!secondaryNoteId) {
      setLoad({ kind: "idle" });
      lastFetchedId.current = null;
      return;
    }
    if (lastFetchedId.current === secondaryNoteId) return;
    lastFetchedId.current = secondaryNoteId;

    let cancelled = false;
    setLoad({ kind: "loading" });
    api
      .getNote(secondaryNoteId)
      .then((note) => {
        if (cancelled) return;
        setLoad({ kind: "ready", title: note.title, body: note.body });
      })
      .catch(() => {
        if (cancelled) return;
        setLoad({ kind: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [secondaryNoteId]);

  // Cleanup any pending debounced save when component unmounts or id changes.
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [secondaryNoteId]);

  function handleSecondaryChange(body: string): void {
    if (!secondaryNoteId) return;
    // Optimistic local update so the editor stays controlled.
    setLoad((prev) =>
      prev.kind === "ready" ? { ...prev, body } : prev,
    );
    setSaving(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const idAtCall = secondaryNoteId;
    saveTimer.current = setTimeout(() => {
      void api
        .putNote(idAtCall, body)
        .catch(() => {
          // Save errors are surfaced elsewhere (offline queue, toasts).
          // The "saving…" indicator just clears either way.
        })
        .finally(() => {
          // Only clear if no newer pending save was scheduled and id matches.
          if (lastFetchedId.current === idAtCall) setSaving(false);
        });
    }, DEBOUNCE_MS);
  }

  // Empty-state watermark when no note is open
  if (!primaryNoteId) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      >
        <img
          src="/logo-large.png"
          alt=""
          style={{
            maxWidth: "50%",
            maxHeight: "60%",
            opacity: 0.08,
            userSelect: "none",
          }}
        />
      </div>
    );
  }

  // Primary-only layout
  if (!secondaryNoteId) {
    return (
      <div style={{ height: "100%", width: "100%", overflow: "hidden" }}>
        <Editor
          noteId={primaryNoteId}
          initialBody={primaryBody}
          onChange={onPrimaryChange}
          onOpenLink={onOpenLink}
          onOpenLinkSplit={onSecondaryOpen}
          scrollToLine={primaryScrollToLine ?? null}
        />
      </div>
    );
  }

  // Split layout
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        height: "100%",
        width: "100%",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: primaryWidth,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <PaneHeader title={primaryNoteId} />
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <Editor
            noteId={primaryNoteId}
            initialBody={primaryBody}
            onChange={onPrimaryChange}
            onOpenLink={onOpenLink}
            onOpenLinkSplit={onSecondaryOpen}
            scrollToLine={primaryScrollToLine ?? null}
          />
        </div>
      </div>

      <DragHandle
        side="left"
        getWidth={() => primaryWidth}
        setWidth={setPrimaryWidth}
        onReset={() => setPrimaryWidth(600)}
      />

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <PaneHeader
          title={
            load.kind === "ready" ? load.title : secondaryNoteId
          }
          saving={saving}
          onClose={onClosePane}
        />
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          {load.kind === "loading" && (
            <div
              className="loading"
              style={{
                padding: "16px 20px",
                color: C.textDim,
                fontFamily: FONT.ui,
                fontSize: "0.9em",
              }}
            >
              Loading…
            </div>
          )}
          {load.kind === "error" && (
            <div
              className="error"
              style={{
                padding: "16px 20px",
                color: C.err,
                fontFamily: FONT.ui,
                fontSize: "0.9em",
              }}
            >
              Could not load note
            </div>
          )}
          {load.kind === "ready" && (
            <Editor
              noteId={secondaryNoteId}
              initialBody={load.body}
              onChange={handleSecondaryChange}
              onOpenLink={onSecondaryOpen}
              onOpenLinkSplit={onSecondaryOpen}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface PaneHeaderProps {
  title: string;
  saving?: boolean;
  onClose?: () => void;
}

function PaneHeader({ title, saving, onClose }: PaneHeaderProps): JSX.Element {
  return (
    <div
      style={{
        background: "#1A1F26",
        padding: "6px 12px",
        borderBottom: "1px solid #2A323D",
        fontSize: "0.85em",
        color: "#8B9099",
        fontFamily: FONT.ui,
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={title}
      >
        {title}
      </span>
      {saving && (
        <span style={{ color: C.textFaint, fontStyle: "italic" }}>
          saving…
        </span>
      )}
      {onClose && <CloseButton onClick={onClose} />}
    </div>
  );
}

function CloseButton({ onClick }: { onClick: () => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Close pane"
      title="Close pane"
      style={{
        background: "transparent",
        border: "none",
        color: hover ? C.accent : C.textDim,
        cursor: "pointer",
        padding: "0 4px",
        fontSize: "1.1em",
        lineHeight: 1,
        transition: "color 120ms",
      }}
    >
      ×
    </button>
  );
}
