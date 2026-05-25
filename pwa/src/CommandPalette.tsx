import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { C, FONT } from "./theme.js";

interface Hit {
  noteId: string;
  title: string;
  snippet?: string;
  score: number;
  tier: "t1" | "t2";
}

/**
 * Command Palette — Cmd/Ctrl+K from anywhere in the App.
 *
 * Combines fuzzy note search with an actions menu. Today: jump to note.
 * Easily extended with commands like "New note", "Toggle settings", etc.
 *
 * Keyboard:
 *  - Cmd/Ctrl+K   open/close
 *  - Esc          close
 *  - ArrowUp/Down navigate hits
 *  - Enter        open selected note
 */
export function CommandPalette({
  open,
  onClose,
  onOpenNote,
  onNewNote,
}: {
  open: boolean;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onNewNote: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // focus input on open
  useEffect(() => {
    if (open) {
      setQ("");
      setHits([]);
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // search on type (debounced)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      const raw = q.trim();
      if (!raw) {
        setHits([]);
        return;
      }
      // Parse `tag:foo rest of query` → filter hits to noteIds with that tag.
      // If only `tag:foo` is given (no text query), list all notes for the
      // tag via /api/graph/tags (no semantic search needed).
      const tagMatch = /^tag:(\S+)\s*(.*)$/i.exec(raw);
      const tagFilter = tagMatch?.[1] ?? null;
      const textQuery = tagMatch ? tagMatch[2].trim() : raw;

      setLoading(true);
      try {
        if (tagFilter && !textQuery) {
          // Pure tag listing.
          const tags = await api.listTags();
          const hit = tags.find((t) => t.tag === tagFilter);
          const ids = hit?.noteIds ?? [];
          setHits(
            ids.map((id) => ({
              noteId: id,
              title: id.split("/").pop() ?? id,
              score: 1,
              tier: "t1" as const,
            })),
          );
          setCursor(0);
          return;
        }

        const r = await api.search(textQuery || raw, 20);
        let results = r.results;
        if (tagFilter) {
          const tags = await api.listTags();
          const hit = tags.find((t) => t.tag === tagFilter);
          const allowed = new Set(hit?.noteIds ?? []);
          results = results.filter((h) => allowed.has(h.noteId));
        }
        setHits(results);
        setCursor(0);
      } finally {
        setLoading(false);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [q, open]);

  if (!open) return null;

  // Action items always present (above search hits)
  const actions = q.trim()
    ? [{ kind: "new" as const, label: `Neue Notiz: "${q.trim()}"` }]
    : [];

  const totalItems = actions.length + hits.length;

  function activate(idx: number) {
    if (idx < actions.length) {
      onNewNote();
      onClose();
      return;
    }
    const hit = hits[idx - actions.length];
    if (hit) {
      onOpenNote(hit.noteId);
      onClose();
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 1000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 92vw)",
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") return onClose();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, Math.max(0, totalItems - 1)));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              activate(cursor);
            }
          }}
          placeholder="Suche · Befehle · Notes …"
          style={{
            width: "100%",
            padding: "16px 20px",
            background: "transparent",
            border: "none",
            borderBottom: `1px solid ${C.border}`,
            color: C.text,
            fontFamily: FONT.ui,
            fontSize: 16,
            outline: "none",
          }}
        />

        <div style={{ maxHeight: "60vh", overflow: "auto" }}>
          {loading && (
            <div style={{ padding: 14, fontSize: 12, color: C.textDim, fontFamily: FONT.mono }}>
              suchen …
            </div>
          )}

          {actions.map((a, i) => (
            <Item
              key={`action-${i}`}
              active={cursor === i}
              onMouseEnter={() => setCursor(i)}
              onClick={() => activate(i)}
              title={a.label}
              right="↵ neu"
              accent
            />
          ))}

          {hits.map((h, i) => {
            const idx = i + actions.length;
            return (
              <Item
                key={h.noteId}
                active={cursor === idx}
                onMouseEnter={() => setCursor(idx)}
                onClick={() => activate(idx)}
                title={h.title}
                subtitle={h.noteId}
                snippet={h.snippet}
                right={
                  <span
                    style={{
                      fontSize: 10,
                      padding: "2px 6px",
                      background: h.tier === "t2" ? C.accentDim : C.elevated,
                      color: h.tier === "t2" ? C.accent : C.textDim,
                      borderRadius: 4,
                      fontFamily: FONT.mono,
                    }}
                  >
                    {h.tier}
                  </span>
                }
              />
            );
          })}

          {!loading && !q.trim() && (
            <div style={{ padding: 18, color: C.textDim, fontSize: 13 }}>
              Tippe um Notes zu suchen. Cmd/Ctrl+K öffnet diese Palette.
              <br /><br />
              <span style={{ fontFamily: FONT.mono, fontSize: 11, color: C.textFaint }}>
                ↑↓ navigieren · ↵ öffnen · Esc schließen
              </span>
            </div>
          )}

          {!loading && q.trim() && hits.length === 0 && actions.length > 0 && (
            <div style={{ padding: 14, color: C.textDim, fontSize: 13 }}>
              Keine Notes gefunden. ↵ legt neue Note an.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Item({
  title,
  subtitle,
  snippet,
  active,
  onClick,
  onMouseEnter,
  right,
  accent,
}: {
  title: string;
  subtitle?: string;
  snippet?: string;
  active: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  right?: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      style={{
        padding: "10px 16px",
        cursor: "pointer",
        background: active ? C.elevated : "transparent",
        borderLeft: `3px solid ${active ? C.accent : "transparent"}`,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: accent ? C.accent : C.text, fontWeight: accent ? 600 : 400, fontSize: 14 }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ color: C.textFaint, fontSize: 11, fontFamily: FONT.mono, marginTop: 2 }}>
            {subtitle}
          </div>
        )}
        {snippet && (
          <div style={{ color: C.textDim, fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
            {snippet}
          </div>
        )}
      </div>
      {right && <div style={{ color: C.textDim, fontSize: 11 }}>{right}</div>}
    </div>
  );
}
