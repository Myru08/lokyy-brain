import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { C, FONT } from "./theme.js";

/**
 * NoteHeader — compact header strip above the editor pane.
 *
 * Shows the active note's title on the left, and on the right two
 * affordances designed for AI-conversation workflows:
 *
 *   [📋 AI-Prompt]  ── copies a fully-formatted prompt block (title +
 *                      ULID + path + MCP tool hint + free-form prompt
 *                      placeholder) to the clipboard. Paste into any
 *                      AI chat that has the lokyy-brain MCP server
 *                      configured and the AI can resolve the note
 *                      automatically via `mcp__lokyy-brain__resolve_by_id`.
 *
 *   [01KSFC0T…825X9 📎]  ── ID badge. Truncated middle so both ends
 *                            stay visible (the ULID's timestamp prefix
 *                            and random suffix). Click copies ONLY the
 *                            raw ULID. Hover reveals the full string.
 *
 * Why HERE and not in PropertiesPanel:
 *   The PropertiesPanel already exposes `id` as a read-only field but
 *   it's collapsed by default — the user has to expand Properties to
 *   see/copy. The ID is high-leverage for AI-pasting workflows, so we
 *   surface it where it's one click away. PropertiesPanel still owns
 *   raw editing of every frontmatter field — this is purely a fast
 *   path for the two most common share actions.
 */

export interface NoteHeaderProps {
  /** Note path-id (e.g. `30_captures/youtube/foo`). Required for prompt body. */
  noteId: string;
  /** Display title (frontmatter title or filename). */
  title: string;
  /** Full markdown including frontmatter — we extract `id:` from it. */
  body: string;
  /**
   * Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
   * Toggle the note's `forgotten:` frontmatter field. App.tsx owns the
   * API call + reload-after-toggle so the editor sees the updated body.
   * Optional — if omitted, the forget affordance is hidden.
   */
  onForget?: (noteId: string) => void;
  onUnforget?: (noteId: string) => void;
}

/** Strip a top-level YAML scalar value. No nested mapping support needed. */
function extractFrontmatterUlid(body: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!m) return null;
  const block = m[1] ?? "";
  for (const line of block.split(/\r?\n/)) {
    const km = /^id\s*:\s*(.+?)\s*$/.exec(line);
    if (!km) continue;
    const raw = (km[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw) ? raw : null;
  }
  return null;
}

/**
 * Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
 *
 * Extract the `forgotten:` value from the YAML frontmatter. Returns:
 *   - `true`           — `forgotten: true` (boolean) or a non-empty
 *                        ISO-timestamp string the server wrote.
 *   - `false`          — `forgotten: false`, empty string, or absent.
 *
 * The schema accepts both boolean and string variants; both resolve to
 * the same boolean visible-state here. The PWA does not distinguish
 * between "user-forgot-now" and "user-forgot-six-months-ago" — both look
 * identical in the editor.
 */
function extractFrontmatterForgotten(body: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!m) return false;
  const block = m[1] ?? "";
  for (const line of block.split(/\r?\n/)) {
    const km = /^forgotten\s*:\s*(.+?)\s*$/.exec(line);
    if (!km) continue;
    const raw = (km[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (raw === "" || raw === "false") return false;
    return true;
  }
  return false;
}

/** Middle-truncate so first 8 + last 4 chars stay legible. */
function truncateUlid(ulid: string): string {
  if (ulid.length <= 14) return ulid;
  return `${ulid.slice(0, 8)}…${ulid.slice(-4)}`;
}

/**
 * Clipboard write with a Secure-Context fallback. `navigator.clipboard`
 * is unavailable on http:// and on some embedded webviews — fall back
 * to a transient `<textarea>` + `document.execCommand("copy")` so the
 * feature still works in the local-dev / LAN deployment scenarios that
 * lokyy-brain explicitly supports.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function buildAiPrompt(title: string, ulid: string, path: string): string {
  return [
    "Bitte beziehe dich auf folgendes Dokument aus meinem Lokyy-Brain Vault:",
    "",
    `📄 Titel: ${title}`,
    `🆔 ID: ${ulid}`,
    `📁 Pfad: ${path}`,
    "",
    "Nutze das MCP-Tool `mcp__lokyy-brain__resolve_by_id` mit der ID oben,",
    "ODER `mcp__lokyy-brain__read_note` mit dem Pfad, um den vollen Inhalt zu lesen.",
    "",
    "Meine Frage / Aufgabe: ",
  ].join("\n");
}

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 14px",
  background: C.panel,
  borderBottom: `1px solid ${C.border}`,
  flexShrink: 0,
  minHeight: 36,
  fontFamily: FONT.ui,
};

/**
 * Phase C Wave C3 / Story 2 — forgotten-state override.
 *
 * When the note carries `forgotten: true` (or an ISO timestamp), we tint
 * the header strip with a subtle red wash so the user always sees the
 * state at a glance. The body editor is untouched — the user can still
 * read + edit a forgotten note; only retrieval ignores it.
 */
const HEADER_STYLE_FORGOTTEN: CSSProperties = {
  ...HEADER_STYLE,
  background: "rgba(200, 74, 50, 0.05)",
  borderBottom: "1px solid rgba(200, 74, 50, 0.25)",
};

const TITLE_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 14,
  fontWeight: 500,
  color: C.text,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const AI_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "rgba(249,115,22,0.12)",
  border: "1px solid rgba(249,115,22,0.45)",
  borderRadius: 5,
  padding: "3px 10px",
  cursor: "pointer",
  color: "#F97316",
  fontSize: 12,
  fontWeight: 600,
  fontFamily: FONT.ui,
  letterSpacing: "0.02em",
};

const ID_BADGE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  padding: "3px 8px",
  cursor: "pointer",
  color: C.textDim,
  fontSize: 11,
  fontFamily: FONT.mono,
  letterSpacing: "0.02em",
};

const TOAST_STYLE: CSSProperties = {
  fontSize: 11,
  color: C.ok,
  fontFamily: FONT.mono,
  marginLeft: 4,
};

/**
 * Phase C Wave C3 / Story 2 — Forget button. Same shape as the AI-Prompt
 * pill but softer (lower opacity, neutral red); the affordance is meant
 * to be present without competing with the primary AI-Prompt CTA.
 */
const FORGET_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "rgba(200, 74, 50, 0.08)",
  border: "1px solid rgba(200, 74, 50, 0.30)",
  borderRadius: 5,
  padding: "3px 10px",
  cursor: "pointer",
  color: "rgba(239, 68, 68, 0.75)",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: FONT.ui,
  letterSpacing: "0.02em",
  opacity: 0.7,
};

/**
 * Phase C Wave C3 / Story 2 — Unforget button. Brighter / more confident
 * than the forget button because reactivation is the recovery action and
 * we want the user to see it immediately on a forgotten note.
 */
const UNFORGET_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "rgba(127, 163, 122, 0.15)",
  border: "1px solid rgba(127, 163, 122, 0.5)",
  borderRadius: 5,
  padding: "3px 10px",
  cursor: "pointer",
  color: C.ok,
  fontSize: 12,
  fontWeight: 600,
  fontFamily: FONT.ui,
  letterSpacing: "0.02em",
};

const FORGOTTEN_SUBTITLE_STYLE: CSSProperties = {
  fontSize: 11,
  color: "rgba(239, 68, 68, 0.65)",
  fontFamily: FONT.ui,
  fontStyle: "italic",
  marginLeft: 8,
};

export function NoteHeader({
  noteId,
  title,
  body,
  onForget,
  onUnforget,
}: NoteHeaderProps) {
  const ulid = useMemo(() => extractFrontmatterUlid(body), [body]);
  const forgotten = useMemo(() => extractFrontmatterForgotten(body), [body]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  // Clean up any pending toast timeout on unmount / note-switch.
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, []);

  function flashToast(msg: string) {
    setToast(msg);
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 1400);
  }

  async function handleCopyId() {
    if (!ulid) return;
    const ok = await copyToClipboard(ulid);
    flashToast(ok ? "✓ ID kopiert" : "✗ Kopieren fehlgeschlagen");
  }

  async function handleCopyPrompt() {
    if (!ulid) return;
    const prompt = buildAiPrompt(title, ulid, noteId);
    const ok = await copyToClipboard(prompt);
    flashToast(ok ? "✓ AI-Prompt kopiert" : "✗ Kopieren fehlgeschlagen");
  }

  // Notes without a ULID (legacy / hand-written w/o frontmatter) still
  // render the title — they just don't get the copy affordances.
  if (!ulid) {
    return (
      <div style={forgotten ? HEADER_STYLE_FORGOTTEN : HEADER_STYLE}>
        <span
          style={{
            ...TITLE_STYLE,
            opacity: forgotten ? 0.6 : 1,
          }}
          title={title}
        >
          {title || noteId}
        </span>
        {forgotten && (
          <span style={FORGOTTEN_SUBTITLE_STYLE}>
            Forgotten — not visible in search
          </span>
        )}
        <span
          style={{
            fontSize: 10,
            color: C.textFaint,
            fontFamily: FONT.mono,
          }}
          title="Note has no ULID in frontmatter"
        >
          (no ULID)
        </span>
      </div>
    );
  }

  return (
    <div style={forgotten ? HEADER_STYLE_FORGOTTEN : HEADER_STYLE}>
      <span
        style={{
          ...TITLE_STYLE,
          opacity: forgotten ? 0.6 : 1,
        }}
        title={title}
      >
        {title || noteId}
      </span>
      {forgotten && (
        <span style={FORGOTTEN_SUBTITLE_STYLE}>
          Forgotten — not visible in search
        </span>
      )}
      {toast && <span style={TOAST_STYLE}>{toast}</span>}
      <button
        type="button"
        onClick={() => void handleCopyPrompt()}
        style={AI_BUTTON_STYLE}
        title="AI-Prompt mit ID + Pfad + MCP-Tool-Hint kopieren"
        aria-label="Copy AI prompt"
      >
        <span aria-hidden="true">📋</span>
        AI-Prompt
      </button>
      {/* Phase C Wave C3 / Story 2 — Cognee forget()/unforget() toggle. */}
      {forgotten
        ? onUnforget && (
            <button
              type="button"
              onClick={() => onUnforget(noteId)}
              style={UNFORGET_BUTTON_STYLE}
              title="Diese Note wieder in Suchen anzeigen"
              aria-label="Unforget note — re-enable retrieval"
            >
              <span aria-hidden="true">⮌</span>
              Unforget
            </button>
          )
        : onForget && (
            <button
              type="button"
              onClick={() => onForget(noteId)}
              style={FORGET_BUTTON_STYLE}
              title="Diese Note aus Suchen ausblenden (bleibt im Vault)"
              aria-label="Forget note — hide from retrieval, keep in vault"
            >
              <span aria-hidden="true">🗑️</span>
              Forget
            </button>
          )}
      <button
        type="button"
        onClick={() => void handleCopyId()}
        style={ID_BADGE_STYLE}
        title={`Click to copy ULID: ${ulid}`}
        aria-label={`Copy ULID ${ulid}`}
      >
        <span>{truncateUlid(ulid)}</span>
        <span aria-hidden="true">📎</span>
      </button>
    </div>
  );
}
