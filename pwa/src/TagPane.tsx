import { useEffect, useMemo, useRef, useState } from "react";
import { Hash } from "lucide-react";
import { api } from "./api.js";
import { C, FONT } from "./theme.js";

/**
 * Tag-Sidebar. Zeigt alle Tags im Vault, sortiert nach Häufigkeit (desc).
 *
 * Klick auf einen Tag setzt ihn als Filter — Klick auf den bereits aktiven
 * Tag hebt den Filter wieder auf (`onSelectTag(null)`).
 *
 * Refresh per `refreshKey`-Prop: Parent erhöht den Counter nach Saves /
 * Imports, und wir holen die Tag-Liste neu. So bleibt die Liste live,
 * ohne dass wir uns auf Websockets festlegen müssen.
 *
 * Anti-Flicker-Regeln:
 *  - Während eines Refetches bleibt die alte Tagliste sichtbar (kein
 *    Zurückschalten auf "loading"). Nur der initiale Load zeigt den
 *    Loading-State.
 *  - Refetches werden um 250ms gedebounct, damit schnell aufeinander
 *    folgende Save-Pulse während des Tippens nicht jeden einzelnen
 *    Roundtrip auslösen.
 *  - Sortierung läuft via `useMemo`, damit Re-Renders der Parent (z.B.
 *    durch jeden Tastendruck im Editor) nicht in der TagPane weitere
 *    Arbeit verursachen.
 */

interface TagPaneProps {
  /** Wird hochgezählt, um ein Neu-Laden zu erzwingen. */
  refreshKey?: number;
  activeTag: string | null;
  onSelectTag: (tag: string | null) => void;
}

interface TagEntry {
  tag: string;
  count: number;
  noteIds: string[];
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; tags: TagEntry[] }
  | { status: "error"; message: string };

export function TagPane({ refreshKey, activeTag, onSelectTag }: TagPaneProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Tracks whether we've ever successfully loaded — so we know whether
  // to show the "loading" placeholder or quietly refetch in the
  // background while keeping the existing list painted.
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    // Debounce: collapse rapid refreshKey bumps (e.g. a burst of saves
    // during typing) into a single fetch. The first load fires
    // immediately because hasLoadedRef is false.
    const delay = hasLoadedRef.current ? 250 : 0;

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      // Only reset to "loading" on the initial fetch. Subsequent
      // refetches keep the previous tags visible to avoid the
      // disappearing-list flicker that steals editor focus.
      if (!hasLoadedRef.current) {
        setState({ status: "loading" });
      }
      api
        .listTags()
        .then((tags) => {
          if (cancelled) return;
          hasLoadedRef.current = true;
          setState({ status: "ready", tags });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const message =
            err instanceof Error ? err.message : "Tag-Laden fehlgeschlagen";
          // Don't blow away a previously-good list with an error
          // panel — keep showing the stale tags and just log.
          if (hasLoadedRef.current) {
            console.warn("TagPane refresh failed:", message);
          } else {
            setState({ status: "error", message });
          }
        });
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refreshKey]);

  // Sorting is cheap but lifting it into useMemo means parent re-renders
  // (every keystroke in the editor re-renders App, which re-renders us)
  // don't redo the work on each frame.
  const sortedTags = useMemo(() => {
    if (state.status !== "ready") return [];
    return [...state.tags].sort((a, b) => b.count - a.count);
  }, [state]);

  return (
    <aside
      style={{
        background: C.bg,
        borderLeft: `1px solid ${C.accentDim}`,
        borderRight: `1px solid ${C.accentDim}`,
        fontFamily: FONT.ui,
        userSelect: "none",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        maxHeight: 320,
        overflowY: "auto",
      }}
    >
      {/* Kopf */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "4px 6px 8px",
          gap: 6,
          position: "sticky",
          top: 0,
          background: C.bg,
          zIndex: 1,
        }}
      >
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: C.gold,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            flex: 1,
          }}
        >
          TAGS
        </span>
        {activeTag !== null && (
          <button
            title="Filter zurücksetzen"
            aria-label="Filter zurücksetzen"
            onClick={() => onSelectTag(null)}
            style={{
              border: "none",
              background: "transparent",
              color: C.accent,
              fontSize: 10,
              fontFamily: FONT.ui,
              cursor: "pointer",
              padding: "2px 4px",
            }}
          >
            clear
          </button>
        )}
      </div>

      {state.status === "loading" && (
        <div
          style={{
            fontSize: 11,
            color: C.textFaint,
            padding: "8px",
            fontFamily: FONT.mono,
          }}
        >
          lade tags…
        </div>
      )}

      {state.status === "error" && (
        <div
          style={{
            fontSize: 11,
            color: C.err,
            padding: "8px",
            fontFamily: FONT.mono,
          }}
        >
          {state.message}
        </div>
      )}

      {state.status === "ready" && sortedTags.length === 0 && (
        <div
          style={{
            fontSize: 11,
            color: C.textFaint,
            padding: "8px",
            fontFamily: FONT.mono,
            lineHeight: 1.5,
          }}
        >
          No tags yet — add <code style={{ color: C.accent }}>#foo</code> to a
          note or set <code style={{ color: C.accent }}>tags: [foo]</code> in
          frontmatter.
        </div>
      )}

      {state.status === "ready" && sortedTags.length > 0 && (
        <div style={{ padding: "0 2px 8px" }}>
          {sortedTags.map((entry) => (
            <TagRow
              key={entry.tag}
              entry={entry}
              isActive={entry.tag === activeTag}
              onClick={() =>
                onSelectTag(entry.tag === activeTag ? null : entry.tag)
              }
            />
          ))}
        </div>
      )}
    </aside>
  );
}

/* ---------------- Row ---------------- */

interface TagRowProps {
  entry: TagEntry;
  isActive: boolean;
  onClick: () => void;
}

function TagRow({ entry, isActive, onClick }: TagRowProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        marginBottom: 2,
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 14,
        background: isActive
          ? C.selection
          : hover
            ? "rgba(249,115,22,0.08)"
            : "transparent",
        borderLeft: isActive || hover ? `3px solid ${C.accent}` : "3px solid transparent",
        color: isActive ? C.text : C.textDim,
      }}
    >
      <Hash
        size={18}
        style={{
          color: isActive || hover ? C.accent : C.textDim,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.tag}
      </span>
      <span
        style={{
          fontSize: 12,
          color: isActive ? C.accentHi : C.textDim,
          fontFamily: FONT.mono,
          flexShrink: 0,
          fontWeight: 600,
        }}
      >
        {entry.count}
      </span>
    </div>
  );
}
