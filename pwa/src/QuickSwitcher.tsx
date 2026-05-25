import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteSummary } from "@lokyy/shared";
import { api, logTrace } from "./api.js";
import { C, FONT } from "./theme.js";

/**
 * Quick-Switcher — Cmd/Ctrl+O.
 *
 * Obsidian-style. NO search across body — just title+id matching against a
 * client-side cache of `listNotes()`. One fetch on open, fuzzy-filter on every
 * keystroke locally → zero server roundtrips while typing.
 *
 * Keyboard:
 *  - Esc            close
 *  - ArrowUp/Down   navigate
 *  - Enter          open selected
 */
export interface QuickSwitcherProps {
  open: boolean;
  onClose: () => void;
  onOpenNote: (noteId: string) => void;
}

interface Ranked {
  id: string;
  title: string;
  score: number;
}

const MAX_RESULTS = 12;

/**
 * Score a single note against the query.
 *  - 100 → title starts with query
 *  -  50 → title contains query (not at start)
 *  -  25 → id contains query (and title didn't match)
 *  -   0 → no match (caller filters these out)
 *
 * Lowercase compare; query is already trimmed and lowercased by the caller.
 */
function scoreNote(title: string, id: string, q: string): number {
  const tLow = title.toLowerCase();
  const iLow = id.toLowerCase();
  if (tLow.startsWith(q)) return 100;
  if (tLow.includes(q)) return 50;
  if (iLow.includes(q)) return 25;
  return 0;
}

export function QuickSwitcher({ open, onClose, onOpenNote }: QuickSwitcherProps) {
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset + fetch on open. One round-trip per session of "open", then pure
  // client filtering until close.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQ("");
    setCursor(0);
    setLoading(true);
    api
      .listNotes()
      .then((rows) => {
        if (cancelled) return;
        setNotes(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setNotes([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    // small delay so the modal is on screen before focusing
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open]);

  // Client-side fuzzy rank. Memoised — re-runs only on query or cache change.
  const ranked = useMemo<Ranked[]>(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const out: Ranked[] = [];
    for (const n of notes) {
      const s = scoreNote(n.title, n.id, query);
      if (s > 0) out.push({ id: n.id, title: n.title, score: s });
    }
    // Higher score first; ties broken by shorter title (closer match feel).
    out.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
    return out.slice(0, MAX_RESULTS);
  }, [q, notes]);

  // Keep cursor in range whenever the result set shrinks.
  useEffect(() => {
    setCursor((c) => {
      if (ranked.length === 0) return 0;
      if (c >= ranked.length) return ranked.length - 1;
      return c;
    });
  }, [ranked]);

  // Scroll the active item into view on cursor change.
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const active = root.querySelector<HTMLDivElement>(
      `[data-qs-idx="${cursor}"]`,
    );
    if (active) active.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  function activate(idx: number) {
    const hit = ranked[idx];
    if (!hit) return;
    // Phase A Wave A1 / Story 3 — Retrieval-Trace-Log (Multi-Trace-Theory).
    logTrace({ noteId: hit.id, source: "cmd-o", query: q.trim() || undefined });
    onOpenNote(hit.id);
    onClose();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 92vw)",
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
          overflow: "hidden",
          fontFamily: FONT.serif,
        }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) =>
                ranked.length === 0 ? 0 : Math.min(c + 1, ranked.length - 1),
              );
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              activate(cursor);
            }
          }}
          placeholder="Quick switch…"
          style={{
            width: "100%",
            padding: "16px 20px",
            background: "transparent",
            border: "none",
            borderBottom: `1px solid ${C.border}`,
            color: C.text,
            fontFamily: FONT.serif,
            fontSize: 17,
            outline: "none",
          }}
        />

        <div
          ref={listRef}
          style={{ maxHeight: "60vh", overflow: "auto" }}
        >
          {loading && (
            <div
              style={{
                padding: 14,
                fontSize: 12,
                color: C.textDim,
                fontFamily: FONT.mono,
              }}
            >
              loading notes …
            </div>
          )}

          {!loading && ranked.length === 0 && (
            <div
              style={{
                padding: 18,
                color: C.textDim,
                fontSize: 13,
                fontFamily: FONT.serif,
              }}
            >
              No notes match
              <br />
              <span
                style={{
                  fontFamily: FONT.mono,
                  fontSize: 11,
                  color: C.textFaint,
                }}
              >
                ↑↓ navigate · ↵ open · Esc close
              </span>
            </div>
          )}

          {ranked.map((r, i) => (
            <Row
              key={r.id}
              idx={i}
              title={r.title}
              id={r.id}
              active={cursor === i}
              onMouseEnter={() => setCursor(i)}
              onClick={() => activate(i)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({
  idx,
  title,
  id,
  active,
  onMouseEnter,
  onClick,
}: {
  idx: number;
  title: string;
  id: string;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  return (
    <div
      data-qs-idx={idx}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      style={{
        padding: "10px 16px",
        cursor: "pointer",
        background: active ? "rgba(249,115,22,0.20)" : "transparent",
        borderLeft: `3px solid ${active ? C.accent : "transparent"}`,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div
        style={{
          color: active ? C.accent : C.text,
          fontFamily: FONT.serif,
          fontSize: 15,
          lineHeight: 1.3,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </div>
      <div
        style={{
          color: C.textFaint,
          fontFamily: FONT.mono,
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {id}
      </div>
    </div>
  );
}
