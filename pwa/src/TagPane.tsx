import { useEffect, useState } from "react";
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

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api
      .listTags()
      .then((tags) => {
        if (cancelled) return;
        const sorted = [...tags].sort((a, b) => b.count - a.count);
        setState({ status: "ready", tags: sorted });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Tag-Laden fehlgeschlagen";
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

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

      {state.status === "ready" && state.tags.length === 0 && (
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

      {state.status === "ready" && state.tags.length > 0 && (
        <div style={{ padding: "0 2px 8px" }}>
          {state.tags.map((entry) => (
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
