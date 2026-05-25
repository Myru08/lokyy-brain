import { useState, type CSSProperties } from "react";
import { api, ApiError } from "./api";

/**
 * Obsidian-style "Today" button. Opens or creates today's daily note at
 * `40_daily/YYYY-MM-DD.md`. The note id is the path without the `.md`
 * extension, matching the rest of the app's id contract.
 *
 * The button delegates note opening to the parent via `onOpenNote` — this
 * component does not own the active-note state. It only handles the
 * resolve-or-create dance and reports errors inline.
 */

export interface DailyNoteButtonProps {
  /** Called with the note id (e.g. `40_daily/2026-05-25`) once it is on disk. */
  onOpenNote: (noteId: string) => void;
}

/** Pad a 1- or 2-digit number to two characters. */
function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Today's local date as `YYYY-MM-DD`. */
function todayLocalIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Markdown skeleton for a brand-new daily note. */
function dailyTemplate(date: string): string {
  return `# ${date}\n\n## Plan\n- [ ] \n\n## Done\n- \n\n## Notes\n\n`;
}

const baseStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid #2A323D",
  color: "#FFFFFF",
  padding: "4px 10px",
  borderRadius: 4,
  fontSize: 13,
  lineHeight: 1.2,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontFamily: "'Inter', system-ui, sans-serif",
  transition: "border-color 120ms ease, color 120ms ease",
};

const hoverStyle: CSSProperties = {
  borderColor: "#F97316",
  color: "#F97316",
};

const disabledStyle: CSSProperties = {
  opacity: 0.6,
  cursor: "wait",
};

const errorStyle: CSSProperties = {
  marginLeft: 8,
  color: "#F97316",
  fontSize: 12,
};

const iconStyle: CSSProperties = {
  fontSize: 20,
  lineHeight: 1,
};

export function DailyNoteButton({ onOpenNote }: DailyNoteButtonProps) {
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);
    const date = todayLocalIso();
    const id = `40_daily/${date}`;
    const path = `${id}.md`;

    try {
      // Try to open existing note first.
      try {
        await api.getNote(id);
        onOpenNote(id);
        return;
      } catch (err) {
        // 404 -> create. Anything else -> surface.
        if (!(err instanceof ApiError) || err.status !== 404) {
          throw err;
        }
      }

      // Create a SPEC-valid daily note. `notesService.createNote` defaults
      // `type` to "note" and `title` to the filename (the date), which is
      // exactly what we want — so the existing `(path, body)` signature
      // produces the required frontmatter without extending api.ts.
      await api.createNote(id, dailyTemplate(date));
      onOpenNote(id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Daily note could not be opened.";
      console.error("[DailyNoteButton] failed to open/create daily note", err);
      setError(message);
      // Block-modal alert as required by the spec — keeps parity with
      // existing toolbar error handling (see App.tsx handleCreate).
      window.alert(message);
    } finally {
      setLoading(false);
    }
  }

  const style: CSSProperties = {
    ...baseStyle,
    ...(hover && !loading ? hoverStyle : null),
    ...(loading ? disabledStyle : null),
  };

  const label = loading ? "Loading…" : "Today";

  return (
    <>
      <button
        type="button"
        onClick={() => {
          void handleClick();
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        disabled={loading}
        aria-label="Open today's daily note"
        title="Open today's daily note"
        style={style}
      >
        <span aria-hidden="true" style={iconStyle}>📅</span>
        <span>{label}</span>
      </button>
      {error ? (
        <span role="alert" style={errorStyle}>
          {error}
        </span>
      ) : null}
    </>
  );
}
