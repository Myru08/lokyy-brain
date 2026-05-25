import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { api } from "./api.js";
import { C, FONT } from "./theme.js";

interface Backlink {
  noteId: string;
  title: string;
  context: string;
}

/**
 * Backlinks-Panel — zeigt welche Notes auf die aktive Note verlinken.
 * Aktualisiert beim Note-Wechsel + nach jedem Save.
 *
 * Klick → öffnet die referenzierende Note.
 */
export function BacklinksPanel({
  noteId,
  onOpenNote,
  refreshSignal,
}: {
  noteId: string | null;
  onOpenNote: (id: string) => void;
  refreshSignal: number;
}) {
  const [items, setItems] = useState<Backlink[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!noteId) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api
      .backlinks(noteId)
      .then((r) => {
        if (!cancelled) setItems(r.backlinks);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [noteId, refreshSignal]);

  if (!noteId) return null;

  return (
    <aside
      style={{
        padding: "16px 16px 18px 16px",
        borderTop: `1px solid ${C.border}`,
        background: C.bg,
        color: C.text,
        fontFamily: FONT.ui,
        maxHeight: "32vh",
        overflow: "auto",
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: 1.2,
          color: C.textDim,
          textTransform: "uppercase",
          marginBottom: 10,
          fontFamily: FONT.mono,
        }}
      >
        Backlinks
        {loading && <span style={{ marginLeft: 6, color: C.textFaint }}>…</span>}
        {!loading && (
          <span style={{ marginLeft: 6, color: C.textFaint }}>
            {items.length === 0 ? "keine" : `${items.length}`}
          </span>
        )}
      </div>

      {items.length === 0 && !loading && (
        <div style={{ color: C.textFaint, fontSize: 12, fontStyle: "italic" }}>
          Diese Notiz ist noch nirgendwo verlinkt.
        </div>
      )}

      {items.map((b) => (
        <button
          key={b.noteId}
          onClick={() => onOpenNote(b.noteId)}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            background: "transparent",
            border: "none",
            padding: "8px 0",
            cursor: "pointer",
            color: C.text,
            borderBottom: `1px solid ${C.borderSoft}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <strong style={{ color: C.accent, fontSize: 13, fontFamily: FONT.serif }}>{b.title}</strong>
            <span style={{ color: C.textFaint, fontSize: 10, fontFamily: FONT.mono }}>{b.noteId}</span>
            <ArrowUpRight size={11} style={{ color: C.textDim, marginLeft: "auto" }} />
          </div>
          {b.context && (
            <div style={{ color: C.textDim, fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
              {b.context}
            </div>
          )}
        </button>
      ))}
    </aside>
  );
}
