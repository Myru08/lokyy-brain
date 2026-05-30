import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ChevronRight,
  Folder,
  Loader2,
  Save,
  RefreshCw,
  Sparkles,
  Undo2,
  Volume2,
  VolumeX,
  MoreVertical,
  Trash2,
} from "lucide-react";
import { C, FONT } from "./theme.js";
import { useIsMobile, TOUCH_TARGET_MIN } from "./responsive.js";
import { NoteActionsSheet } from "./NoteActionsSheet.js";

/**
 * Save-lifecycle states. Mirrors `App.tsx#SyncState` — kept loosely
 * coupled (the badge is purely presentational; it never decides the next
 * state, only renders the one App.tsx hands it).
 */
export type SaveStatus =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "synced"
  | "conflict"
  | "error";

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
  /**
   * Story: Real "Notiz löschen" — hard-delete the currently-open note.
   * DISTINCT from Forget (which only hides the note from search). App.tsx
   * owns the actual `api.remove(id, "note")` + editor/tab cleanup; the
   * control here owns ONLY the deliberate two-step affirmative confirm
   * ("Notiz löschen" → "Wirklich löschen? [Endgültig löschen] [Abbrechen]")
   * and surfacing the rejection inline. Resolves on success, rejects with an
   * Error whose `.message` is shown to the user. Optional — when omitted the
   * delete affordance is hidden.
   */
  onDeleteNote?: (noteId: string) => Promise<void>;
  /**
   * Save-lifecycle props (Story: editor save-lifecycle overhaul).
   * If omitted, the badge + manual-save button are hidden — keeps the
   * header backwards-compatible with any caller that hasn't wired the
   * new state yet.
   */
  syncState?: SaveStatus;
  /** Epoch-ms of the last successful save — drives the "vor Xs" label. */
  lastSavedAt?: number | null;
  /** Last error message (any state, surfaced under the badge). */
  errorMsg?: string | null;
  /** Manual save handler — fires from the disk-icon button. */
  onManualSave?: () => void;
  /**
   * Story: separate Save & Sync buttons.
   *
   * Whether the editor has unsaved local changes (the body differs from what
   * the server last returned). Drives the SAVE button's disabled state — Save
   * is a no-op when nothing is dirty, so we grey it out. App.tsx is the single
   * source of truth for dirtiness (it owns `dirtyBody`/`savedBodyRef`); the
   * header is a dumb view of the boolean it's handed.
   */
  isDirty?: boolean;
  /**
   * Reconcile handler — fires `api.sync()` (git pull --rebase + push unpushed,
   * server-side, inside the git lock). App.tsx owns the request, badge update,
   * and error banner; the button only reflects in-flight state + disabled-ness.
   * The Sync button is hidden when this prop is omitted (back-compat).
   */
  onSync?: () => void;
  /** True while an `api.sync()` request is in flight — drives the Sync spinner. */
  syncing?: boolean;
  /**
   * Called when the user clicks "Erneut versuchen" on an error state.
   * App.tsx clears errorMsg and (optionally) re-queues a save.
   */
  onDismissError?: () => void;
  /**
   * AI-Polish handler — fires `POST /api/notes/:id/ai-polish` and refetches
   * the note when done. App.tsx owns the request/refetch so the editor
   * picks up the polished body via its standard reload path. The button
   * is hidden when this prop is omitted.
   *
   * Contract:
   *   - resolves on success (UI flashes a "✓ poliert" confirmation)
   *   - rejects with an Error whose `.message` is surfaced to the user
   *     inline for ~6s before clearing
   */
  onPolish?: (noteId: string) => Promise<void>;
  /**
   * Polish-undo handler — restores the pre-polish body from the
   * `raw_transcript` frontmatter field. App.tsx rebuilds the note body
   * (strips `raw_transcript`, `ai_polished_at`, `ai_polished_model`,
   * substitutes `raw_transcript`'s contents for the markdown body) and
   * persists it via the existing save flow. The button is hidden when
   * this prop is omitted OR when the active note has no `raw_transcript`.
   */
  onPolishUndo?: (noteId: string) => Promise<void>;
  /**
   * Optional click-to-jump handler for the folder-path breadcrumb. When
   * provided, each breadcrumb segment becomes a button that calls this
   * with the cumulative folder path (e.g. `30_captures` or
   * `30_captures/voice`). App.tsx is expected to expand the FileTree to
   * that folder and scroll it into view. When omitted, the breadcrumb
   * renders as plain text (still visible — just non-interactive).
   */
  onFolderJump?: (folderPath: string) => void;
  /**
   * Mobile-only nav callbacks for the "⋮" NoteActionsSheet. On phones the
   * inline action row is unreachable, so all actions move into a bottom sheet
   * opened by a single "⋮" button. Properties/Backlinks/Outline live in App.tsx
   * panels (not the header), so App passes these toggles down; the header owns
   * the sheet itself + its own TTS/Polish/copy handlers. Optional — when
   * omitted (desktop), the sheet is never rendered and the inline row shows.
   */
  onShowProperties?: () => void;
  onShowBacklinks?: () => void;
  onShowOutline?: () => void;
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

/**
 * Detect whether the note's frontmatter carries a `raw_transcript:` key.
 *
 * The polish endpoint stores the pre-polish body under this field (YAML
 * block scalar `|-`, so the line looks like `raw_transcript: |-` on its
 * own with indented children). For the undo affordance we only need to
 * know IF the field exists — App.tsx parses the actual contents when
 * the user actually clicks Undo.
 *
 * Returns true when the frontmatter contains a top-level line that
 * starts with `raw_transcript:` (with optional inline scalar, block-
 * scalar marker, or empty). Returns false when the field is absent or
 * when there's no frontmatter block at all.
 */
function hasRawTranscript(body: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!m) return false;
  const block = m[1] ?? "";
  for (const line of block.split(/\r?\n/)) {
    if (/^raw_transcript\s*:/.test(line)) return true;
  }
  return false;
}

/**
 * Extract the `lang:` value from the YAML frontmatter so the TTS button
 * can pick the right voice. Returns the raw string (e.g. `de-DE`,
 * `en-US`) or null when absent. We do not validate format here — the
 * Speech Synthesis API accepts BCP-47 tags and silently falls back when
 * unknown, so a malformed value just degrades to default.
 */
function extractFrontmatterLang(body: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!m) return null;
  const block = m[1] ?? "";
  for (const line of block.split(/\r?\n/)) {
    const km = /^lang\s*:\s*(.+?)\s*$/.exec(line);
    if (!km) continue;
    const raw = (km[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    return raw || null;
  }
  return null;
}

/**
 * Strip frontmatter + rough markdown formatting so the TTS engine reads
 * the prose, not the markup. We intentionally do NOT pull in a real
 * markdown parser (remark, marked) — for read-aloud, a few `regex` passes
 * cover the 95% case (headings, lists, bold/italic, code fences, inline
 * code, links) and any leftover punctuation just lands in the speech
 * which is harmless. Heavy markdown will still read OK, just with the
 * occasional "asterisk asterisk" if a bold marker survives.
 *
 * Passes (in order):
 *   1. drop frontmatter block (`---\n…\n---`)
 *   2. drop fenced code blocks (```lang\n…\n```) — the recognizer would
 *      try to read each character of code which is unbearable
 *   3. drop inline code spans (`foo`)
 *   4. drop heading hashes at line-start (`# `, `## `, etc.)
 *   5. drop list bullet markers at line-start (`- `, `* `, `+ `, `1. `)
 *   6. drop blockquote markers at line-start (`> `)
 *   7. unwrap bold/italic markers (`**`, `__`, `*`, `_`)
 *   8. replace `[text](url)` with `text`
 *   9. drop bare wikilink brackets `[[…]]` → `…`
 *   10. collapse 3+ newlines to 2 so the speech engine pauses naturally
 */
function stripMarkdownForSpeech(body: string): string {
  let text = body;
  // 1. frontmatter
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  // 2. fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, "");
  // 3. inline code
  text = text.replace(/`[^`\n]*`/g, "");
  // 4. heading hashes
  text = text.replace(/^#{1,6}\s+/gm, "");
  // 5. list bullets
  text = text.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "");
  // 6. blockquote markers
  text = text.replace(/^\s*>\s?/gm, "");
  // 7. bold/italic — non-greedy, word-bound to avoid eating `_foo_bar_`
  text = text.replace(/\*\*([^*]+?)\*\*/g, "$1");
  text = text.replace(/__([^_]+?)__/g, "$1");
  text = text.replace(/\*([^*\n]+?)\*/g, "$1");
  text = text.replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s).,!?;:])/g, "$1$2");
  // 8. markdown links — keep label, drop URL
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // 9. wikilinks — keep the visible portion (after `|` if aliased)
  text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) =>
    alias ?? target,
  );
  // 10. trim runs of blank lines
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
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

/**
 * Compute breadcrumb segments from a note path-id. The note's `id` is
 * the path WITHOUT the `.md` extension (e.g.
 * `30_captures/voice/2026-05-27-voice-notiz`); the last segment is the
 * filename, which the title row already shows — we drop it. Each entry
 * carries both the visible label (`name`) and the cumulative path
 * (`path`) so click-to-jump can target intermediate folders without
 * re-splitting on the consumer side.
 *
 * Notes at vault root (no `/`) return [].
 */
function buildBreadcrumbSegments(
  noteId: string,
): { name: string; path: string }[] {
  if (!noteId) return [];
  const parts = noteId.split("/").filter(Boolean);
  if (parts.length <= 1) return [];
  const folders = parts.slice(0, -1);
  const out: { name: string; path: string }[] = [];
  let acc = "";
  for (const seg of folders) {
    acc = acc ? `${acc}/${seg}` : seg;
    out.push({ name: seg, path: acc });
  }
  return out;
}

/**
 * Folder-path breadcrumb. Renders a clearly-visible single-line strip
 * above the title row so the user can see WHERE the active note lives and
 * — crucially — JUMP to that folder in the FileTree (high-value for
 * auto-opened voice captures that drop into deep folders). A leading
 * folder icon labels the strip as "here is where this note lives"; each
 * segment is a tappable pill-style button when `onFolderJump` is wired
 * (hover lifts the background + accent-tints the text + underlines, so the
 * click affordance is unmistakable). When `onFolderJump` is omitted the
 * segments render as plain — still clearly legible — text. Hidden entirely
 * for vault-root notes.
 */
function Breadcrumb({
  segments,
  onFolderJump,
}: {
  segments: { name: string; path: string }[];
  onFolderJump?: (folderPath: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (segments.length === 0) return null;

  const clickable = typeof onFolderJump === "function";

  return (
    <div
      style={{
        flexBasis: "100%",
        width: "100%",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 4,
        fontSize: 12,
        fontFamily: FONT.ui,
        fontWeight: 500,
        color: C.text,
        marginBottom: 6,
        lineHeight: 1.3,
      }}
      aria-label="Folder path — click a segment to jump there in the tree"
    >
      <Folder
        size={13}
        aria-hidden="true"
        style={{ color: C.accent, flexShrink: 0, marginRight: 2 }}
      />
      {segments.map((seg, idx) => {
        const isHover = hover === idx;
        const isLast = idx === segments.length - 1;
        const content = clickable ? (
          <button
            type="button"
            onClick={() => onFolderJump?.(seg.path)}
            onMouseEnter={() => setHover(idx)}
            onMouseLeave={() => setHover((h) => (h === idx ? null : h))}
            style={{
              display: "inline-flex",
              alignItems: "center",
              background: isHover ? C.elevated : "transparent",
              border: `1px solid ${isHover ? C.accent : "transparent"}`,
              borderRadius: 4,
              padding: "2px 7px",
              margin: 0,
              cursor: "pointer",
              color: isHover ? C.accent : isLast ? C.text : C.textDim,
              fontSize: 12,
              fontWeight: isLast ? 600 : 500,
              fontFamily: FONT.ui,
              textDecoration: isHover ? "underline" : "none",
              transition: "background 0.12s ease, color 0.12s ease",
            }}
            title={`Im Tree zu „${seg.path}" springen`}
          >
            {seg.name}
          </button>
        ) : (
          <span
            style={{
              padding: "2px 7px",
              color: isLast ? C.text : C.textDim,
              fontWeight: isLast ? 600 : 500,
            }}
          >
            {seg.name}
          </span>
        );
        return (
          <span
            key={seg.path}
            style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
          >
            {content}
            {!isLast && (
              <ChevronRight
                size={12}
                aria-hidden="true"
                style={{ color: C.textFaint }}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  background: C.panel,
  borderBottom: `1px solid ${C.border}`,
  flexShrink: 0,
  minHeight: 36,
  fontFamily: FONT.ui,
  // Phase D Wave D1 — narrow header would otherwise force overflow on
  // mobile; allow the row to wrap so AI-Prompt + Forget stay on one line
  // and the title can ellipsize without pushing buttons off-screen.
  flexWrap: "wrap",
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
  minHeight: 32,
};

/**
 * Phase D Wave D1 — mobile-bigger variant. The default pill (32px tall)
 * stays for desktop; on phones we bump to 40px tall and pad to give the
 * thumb a real target. The button label stays the same so users don't
 * lose orientation switching between viewports.
 */
const AI_BUTTON_STYLE_MOBILE: CSSProperties = {
  ...AI_BUTTON_STYLE,
  fontSize: 13,
  padding: "8px 14px",
  minHeight: 40,
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

/**
 * Story: Real "Notiz löschen" — desktop trigger pill. Distinct from Forget:
 * Forget is a soft (200,74,50) wash; delete uses a hard, fully-saturated red
 * border + filled icon so a destructive permanent action reads as the most
 * dangerous control in the row. Same pill footprint as the other header
 * buttons for visual rhythm.
 */
const DELETE_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "rgba(239, 68, 68, 0.10)",
  border: "1px solid rgba(239, 68, 68, 0.55)",
  borderRadius: 5,
  padding: "3px 10px",
  cursor: "pointer",
  color: "#EF4444",
  fontSize: 12,
  fontWeight: 600,
  fontFamily: FONT.ui,
  letterSpacing: "0.02em",
  minHeight: 32,
};

/** Second-step "Endgültig löschen" — solid red, unmistakably the commit. */
const DELETE_CONFIRM_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "#EF4444",
  border: "1px solid #EF4444",
  borderRadius: 5,
  padding: "3px 10px",
  cursor: "pointer",
  color: "#fff",
  fontSize: 12,
  fontWeight: 700,
  fontFamily: FONT.ui,
  letterSpacing: "0.02em",
  minHeight: 32,
};

/** Second-step "Abbrechen" — neutral escape hatch alongside the commit. */
const DELETE_CANCEL_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  padding: "3px 10px",
  cursor: "pointer",
  color: C.textDim,
  fontSize: 12,
  fontWeight: 500,
  fontFamily: FONT.ui,
  minHeight: 32,
};

const DELETE_PROMPT_STYLE: CSSProperties = {
  fontSize: 12,
  color: "#EF4444",
  fontFamily: FONT.ui,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const DELETE_ERR_STYLE: CSSProperties = {
  fontSize: 11,
  color: C.err,
  fontFamily: FONT.ui,
  whiteSpace: "nowrap",
  maxWidth: 320,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const FORGOTTEN_SUBTITLE_STYLE: CSSProperties = {
  fontSize: 11,
  color: "rgba(239, 68, 68, 0.65)",
  fontFamily: FONT.ui,
  fontStyle: "italic",
  marginLeft: 8,
};

/**
 * Manual-save button — disk icon. Distinct from the AI-Prompt pill so
 * users don't confuse "copy prompt for AI" with "persist my edits NOW".
 * Disabled in "saving" state to avoid double-submit; otherwise always
 * clickable (even in "synced" state it harmlessly no-ops in App.tsx).
 */
const SAVE_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  cursor: "pointer",
  color: C.textDim,
  padding: 0,
};

const SAVE_BUTTON_STYLE_MOBILE: CSSProperties = {
  ...SAVE_BUTTON_STYLE,
  width: 40,
  height: 40,
};

/**
 * Story: separate Save & Sync buttons — Sync (reconcile) control. Same
 * icon-square footprint as Save so the two sit as one visual group, but a
 * distinct affordance: Save flushes local edits, Sync reconciles with Forgejo
 * (pull --rebase + push unpushed). Kept visually separate per AC#4.
 */
const SYNC_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  cursor: "pointer",
  color: C.textDim,
  padding: 0,
};

const SYNC_BUTTON_STYLE_MOBILE: CSSProperties = {
  ...SYNC_BUTTON_STYLE,
  width: 40,
  height: 40,
};

/**
 * TTS read-aloud button — same icon-square shape as Save so the two
 * single-icon affordances look like one visual group. Color shifts when
 * actively reading so the user can find the stop button without reading
 * the tooltip.
 */
const TTS_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  cursor: "pointer",
  color: C.textDim,
  padding: 0,
};

const TTS_BUTTON_STYLE_MOBILE: CSSProperties = {
  ...TTS_BUTTON_STYLE,
  width: 40,
  height: 40,
};

const TTS_BUTTON_STYLE_ACTIVE: CSSProperties = {
  ...TTS_BUTTON_STYLE,
  color: C.accent,
  borderColor: C.accent,
};

const TTS_BUTTON_STYLE_ACTIVE_MOBILE: CSSProperties = {
  ...TTS_BUTTON_STYLE_MOBILE,
  color: C.accent,
  borderColor: C.accent,
};

/**
 * Polish (sparkle) button — promotes "AI cleanup" from the recorder's
 * post-stop auto-toggle to a deliberate per-note action available from
 * the editor header. Distinct purple/violet tint so it doesn't compete
 * with the orange AI-Prompt CTA or the save controls. Same pill shape
 * as the other header buttons for visual rhythm.
 */
const POLISH_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "rgba(168, 85, 247, 0.12)",
  border: "1px solid rgba(168, 85, 247, 0.45)",
  borderRadius: 5,
  padding: "3px 10px",
  cursor: "pointer",
  color: "#A855F7",
  fontSize: 12,
  fontWeight: 600,
  fontFamily: FONT.ui,
  letterSpacing: "0.02em",
  minHeight: 32,
};

const POLISH_BUTTON_STYLE_MOBILE: CSSProperties = {
  ...POLISH_BUTTON_STYLE,
  fontSize: 13,
  padding: "8px 14px",
  minHeight: 40,
};

/**
 * Polish-undo button — only rendered when `raw_transcript` is present in
 * the active note's frontmatter. Softer styling than the primary polish
 * button (this is the recovery action, not the primary one).
 */
const POLISH_UNDO_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  padding: "3px 10px",
  cursor: "pointer",
  color: C.textDim,
  fontSize: 12,
  fontWeight: 500,
  fontFamily: FONT.ui,
  letterSpacing: "0.02em",
  minHeight: 32,
};

const POLISH_UNDO_BUTTON_STYLE_MOBILE: CSSProperties = {
  ...POLISH_UNDO_BUTTON_STYLE,
  fontSize: 13,
  padding: "8px 14px",
  minHeight: 40,
};

/** Inline status text next to the polish controls — success flash + error. */
const POLISH_OK_STYLE: CSSProperties = {
  fontSize: 11,
  color: C.ok,
  fontFamily: FONT.mono,
  whiteSpace: "nowrap",
};

const POLISH_ERR_STYLE: CSSProperties = {
  fontSize: 11,
  color: C.err,
  fontFamily: FONT.ui,
  whiteSpace: "nowrap",
  maxWidth: 320,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/**
 * Compact save-status badge. The colour-dot encodes the state; the label
 * spells it out for accessibility. Pulses while dirty (CSS keyframe
 * defined inline because the project doesn't use a CSS-in-JS lib that
 * supports keyframes — a single style tag is the least-intrusive option).
 *
 * The "vor Xs / vor Xm" label is computed from the parent's
 * `lastSavedAt`; it ticks itself via a 5s setInterval while a value is
 * present so the user sees freshness without manually re-rendering App.
 */
function SaveBadge({
  status,
  lastSavedAt,
}: {
  status: SaveStatus;
  lastSavedAt: number | null | undefined;
}) {
  // Tick every 10s to refresh the "vor Xs" label without burdening App.tsx
  // with a render every second. 10s precision matches what the human
  // reads off the badge ("vor 12s", "vor 22s") without being noisy.
  const [, force] = useState(0);
  useEffect(() => {
    if (!lastSavedAt) return;
    const iv = window.setInterval(() => force((n) => n + 1), 10_000);
    return () => window.clearInterval(iv);
  }, [lastSavedAt]);

  const meta = badgeMeta(status, lastSavedAt);
  if (!meta) return null;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontFamily: FONT.mono,
        color: meta.color,
        whiteSpace: "nowrap",
      }}
      title={meta.tooltip}
      aria-live="polite"
    >
      {status === "saving" ? (
        <Loader2
          size={12}
          style={{
            animation: "lokyy-spin 0.9s linear infinite",
            color: meta.color,
          }}
        />
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: meta.color,
            display: "inline-block",
            animation:
              status === "dirty" ? "lokyy-pulse 1.4s ease-in-out infinite" : undefined,
          }}
        />
      )}
      {meta.label}
    </span>
  );
}

/**
 * Map a SaveStatus + timestamp to a visible badge spec. Returns null when
 * the badge should be hidden entirely (e.g. truly idle with no recent
 * save). The "synced" + "saved" cases include the freshness suffix.
 */
function badgeMeta(
  status: SaveStatus,
  lastSavedAt: number | null | undefined,
): { color: string; label: string; tooltip: string } | null {
  switch (status) {
    case "dirty":
      return {
        color: C.gold,
        label: "ungespeichert",
        tooltip: "Lokale Änderungen sind noch nicht gespeichert",
      };
    case "saving":
      return {
        color: C.gold,
        label: "speichert…",
        tooltip: "Server-Save läuft",
      };
    case "saved":
      return {
        color: C.ok,
        label: `gespeichert${formatAgo(lastSavedAt)}`,
        tooltip: "Lokal beim Server gespeichert",
      };
    case "synced":
      return {
        color: C.ok,
        label: `synct ✓${formatAgo(lastSavedAt)}`,
        tooltip: "Auf Forgejo gepusht",
      };
    case "conflict":
      return {
        color: C.err,
        label: "konflikt",
        tooltip: "Server hat eine neuere Version — bitte neu laden",
      };
    case "error":
      return {
        color: C.err,
        label: "fehler",
        tooltip: "Letzter Speicher-Versuch fehlgeschlagen",
      };
    case "idle":
    default:
      // Hide the badge entirely when there's nothing interesting to say.
      // Reduces noise during quiet reading sessions.
      return null;
  }
}

/** "1m23s" → " · vor 1m" or " · vor 23s". Empty string if no timestamp. */
function formatAgo(ts: number | null | undefined): string {
  if (!ts) return "";
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 5) return " · jetzt";
  if (secs < 60) return ` · vor ${secs}s`;
  const mins = Math.floor(secs / 60);
  return ` · vor ${mins}m`;
}

export function NoteHeader({
  noteId,
  title,
  body,
  onForget,
  onUnforget,
  onDeleteNote,
  syncState,
  lastSavedAt,
  errorMsg,
  onManualSave,
  isDirty,
  onSync,
  syncing,
  onDismissError,
  onPolish,
  onPolishUndo,
  onFolderJump,
  onShowProperties,
  onShowBacklinks,
  onShowOutline,
}: NoteHeaderProps) {
  const ulid = useMemo(() => extractFrontmatterUlid(body), [body]);
  const forgotten = useMemo(() => extractFrontmatterForgotten(body), [body]);
  const rawTranscriptPresent = useMemo(() => hasRawTranscript(body), [body]);
  const lang = useMemo(() => extractFrontmatterLang(body), [body]);
  const breadcrumbSegments = useMemo(
    () => buildBreadcrumbSegments(noteId),
    [noteId],
  );
  // TTS — Web Speech Synthesis. Feature-detect at render time so older
  // browsers (no SpeechSynthesis) and embedded webviews that disable it
  // get a greyed-out button with an explanatory tooltip rather than a
  // crash on click.
  const ttsSupported =
    typeof window !== "undefined" && "speechSynthesis" in window;
  const [isReading, setIsReading] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  // Polish lifecycle — independent of save lifecycle: polish triggers a
  // server-side rewrite of the note body that the editor picks up via the
  // standard refetch path. We mirror only the in-flight + result states
  // here so the user sees a spinner while the request is pending and a
  // short success/failure flash after.
  type PolishState =
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "ok" }
    | { kind: "err"; message: string };
  const [polishState, setPolishState] = useState<PolishState>({ kind: "idle" });
  const polishOkTimer = useRef<number | null>(null);
  const polishErrTimer = useRef<number | null>(null);
  const [undoBusy, setUndoBusy] = useState<boolean>(false);
  // Mobile "⋮ more" sheet — collects every note action into touch rows.
  const [actionsSheetOpen, setActionsSheetOpen] = useState<boolean>(false);
  // Story: Real "Notiz löschen" — deliberate two-step affirmative confirm for
  // the DESKTOP inline control (the mobile sheet owns its own two-step state).
  //   idle    → shows the "Notiz löschen" trigger
  //   confirm → shows "Wirklich löschen? [Endgültig löschen] [Abbrechen]"
  //   running → delete in flight (both buttons disabled)
  //   err     → inline error message + back to confirm so the user can retry
  type DeleteState =
    | { kind: "idle" }
    | { kind: "confirm" }
    | { kind: "running" }
    | { kind: "err"; message: string };
  const [deleteState, setDeleteState] = useState<DeleteState>({ kind: "idle" });
  // Reset the confirm affordance whenever the user switches notes so a primed
  // "Wirklich löschen?" from note A never carries over to note B.
  useEffect(() => {
    setDeleteState({ kind: "idle" });
  }, [noteId]);
  // Phase D Wave D1 — collapse the ID-badge on mobile (it dominates a
  // 375px header and the AI-Prompt button already encodes the ULID in the
  // copy payload) and grow the remaining buttons to 40px tall.
  const isMobile = useIsMobile();
  const aiButtonStyle = isMobile ? AI_BUTTON_STYLE_MOBILE : AI_BUTTON_STYLE;
  const polishButtonStyle = isMobile
    ? POLISH_BUTTON_STYLE_MOBILE
    : POLISH_BUTTON_STYLE;
  const polishUndoButtonStyle = isMobile
    ? POLISH_UNDO_BUTTON_STYLE_MOBILE
    : POLISH_UNDO_BUTTON_STYLE;

  // Clean up any pending toast timeout on unmount / note-switch.
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
      if (polishOkTimer.current !== null) {
        window.clearTimeout(polishOkTimer.current);
      }
      if (polishErrTimer.current !== null) {
        window.clearTimeout(polishErrTimer.current);
      }
      // Cancel any in-flight TTS on unmount so a stale utterance doesn't
      // outlive the editor (Chrome will happily keep reading after the
      // tree is gone otherwise).
      if (ttsSupported) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          /* ignore — defensive only */
        }
      }
    };
  }, [ttsSupported]);

  // Switching notes mid-read is jarring — cancel and reset on noteId change
  // so the user gets a clean slate when they navigate.
  useEffect(() => {
    if (!ttsSupported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    setIsReading(false);
    utteranceRef.current = null;
  }, [noteId, ttsSupported]);

  // Reset polish state when the active note changes so a stale "✓ poliert"
  // flash from note A doesn't linger after the user switches to note B.
  useEffect(() => {
    setPolishState({ kind: "idle" });
    setUndoBusy(false);
    if (polishOkTimer.current !== null) {
      window.clearTimeout(polishOkTimer.current);
      polishOkTimer.current = null;
    }
    if (polishErrTimer.current !== null) {
      window.clearTimeout(polishErrTimer.current);
      polishErrTimer.current = null;
    }
  }, [noteId]);

  /**
   * Polish click handler — confirms with the user, fires the parent
   * callback, drives the local idle → running → ok|err state machine.
   *
   * Why parent owns the actual POST: the polish endpoint replaces the
   * note's body on disk. The editor needs to reload that body via the
   * standard `open()` → `setActive` path so its cursor/scroll handling
   * stays consistent with every other body-replacement flow (forget,
   * manual reload, conflict resolution). Keeping the HTTP call in the
   * parent means the header stays a dumb view of polish state.
   */
  async function handlePolish() {
    if (!onPolish) return;
    if (polishState.kind === "running") return;
    const ok = window.confirm(
      "Notiz mit KI aufbereiten? Das überschreibt den aktuellen Inhalt. " +
        "Original wird im Frontmatter unter raw_transcript gesichert (Undo möglich).",
    );
    if (!ok) return;
    setPolishState({ kind: "running" });
    try {
      await onPolish(noteId);
      setPolishState({ kind: "ok" });
      if (polishOkTimer.current !== null) {
        window.clearTimeout(polishOkTimer.current);
      }
      polishOkTimer.current = window.setTimeout(() => {
        polishOkTimer.current = null;
        setPolishState((s) => (s.kind === "ok" ? { kind: "idle" } : s));
      }, 4000);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unbekannter Fehler");
      setPolishState({ kind: "err", message });
      if (polishErrTimer.current !== null) {
        window.clearTimeout(polishErrTimer.current);
      }
      polishErrTimer.current = window.setTimeout(() => {
        polishErrTimer.current = null;
        setPolishState((s) => (s.kind === "err" ? { kind: "idle" } : s));
      }, 6000);
    }
  }

  /**
   * Undo handler — restores the pre-polish body from the `raw_transcript`
   * frontmatter field. Parent does the body-rewrite + save; we just
   * confirm + drive the in-flight spinner. On success we don't flash
   * anything: the editor's body changes and that IS the feedback.
   */
  async function handlePolishUndo() {
    if (!onPolishUndo) return;
    if (undoBusy) return;
    const ok = window.confirm(
      "Polish rückgängig machen? Der polierte Text geht verloren, " +
        "das Original wird wiederhergestellt.",
    );
    if (!ok) return;
    setUndoBusy(true);
    try {
      await onPolishUndo(noteId);
    } catch (err) {
      // Surface failure through the same inline error slot as polish itself.
      const message =
        err instanceof Error ? err.message : String(err ?? "unbekannter Fehler");
      setPolishState({ kind: "err", message });
      if (polishErrTimer.current !== null) {
        window.clearTimeout(polishErrTimer.current);
      }
      polishErrTimer.current = window.setTimeout(() => {
        polishErrTimer.current = null;
        setPolishState((s) => (s.kind === "err" ? { kind: "idle" } : s));
      }, 6000);
    } finally {
      setUndoBusy(false);
    }
  }

  /**
   * Delete handler — fires the parent `onDeleteNote` (real hard-delete of the
   * open note) ONLY from the second affirmative step. The two-step gate lives
   * in the JSX (idle → confirm → this); here we just drive running → err and
   * surface the rejection inline. On success the note is gone and App.tsx
   * clears `active`, so this component unmounts — no need to reset state.
   */
  async function handleDeleteConfirmed() {
    if (!onDeleteNote) return;
    if (deleteState.kind === "running") return;
    setDeleteState({ kind: "running" });
    try {
      await onDeleteNote(noteId);
      // active note cleared by App → this header unmounts; nothing to reset.
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unbekannter Fehler");
      setDeleteState({ kind: "err", message });
    }
  }

  /**
   * TTS toggle. Click → read aloud; click while reading → stop. We track
   * `isReading` locally and also listen for the utterance's own `onend`
   * so the icon flips back when the engine naturally finishes a long
   * note. SpeechSynthesis is global per-tab, so we always `cancel()`
   * before queuing a new utterance to avoid stacking.
   */
  function handleToggleSpeech() {
    if (!ttsSupported) return;
    if (isReading) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
      setIsReading(false);
      utteranceRef.current = null;
      return;
    }
    const plain = stripMarkdownForSpeech(body);
    if (!plain) return;
    try {
      // Belt-and-suspenders: nuke any leftover queue from a previous
      // partial read before queuing the new one.
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(plain);
      u.lang = lang ?? "de-DE";
      u.onend = () => {
        setIsReading(false);
        if (utteranceRef.current === u) utteranceRef.current = null;
      };
      u.onerror = () => {
        setIsReading(false);
        if (utteranceRef.current === u) utteranceRef.current = null;
      };
      utteranceRef.current = u;
      window.speechSynthesis.speak(u);
      setIsReading(true);
    } catch {
      setIsReading(false);
      utteranceRef.current = null;
    }
  }

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

  // Polish + Undo controls. Rendered to the LEFT of the save group so
  // the visual order matches the user's mental model: think (polish) →
  // commit (save). The undo pill only appears when raw_transcript is
  // present, which keeps the header lean for the 99% case (no polish in
  // history) and makes the recovery action obvious for the 1% case (just
  // polished, oh wait).
  const polishControls = onPolish ? (
    <>
      <button
        type="button"
        onClick={() => void handlePolish()}
        disabled={polishState.kind === "running"}
        style={{
          ...polishButtonStyle,
          opacity: polishState.kind === "running" ? 0.6 : 1,
          cursor: polishState.kind === "running" ? "default" : "pointer",
        }}
        title="Notiz mit KI aufbereiten — Markdown-Struktur, Titel + Tags, Füllwörter raus"
        aria-label="Polish note with AI"
      >
        {polishState.kind === "running" ? (
          <Loader2
            size={14}
            style={{ animation: "lokyy-spin 0.9s linear infinite" }}
          />
        ) : (
          <Sparkles size={14} />
        )}
        {polishState.kind === "running" ? "Poliert…" : "Polish"}
      </button>
      {rawTranscriptPresent && onPolishUndo && (
        <button
          type="button"
          onClick={() => void handlePolishUndo()}
          disabled={undoBusy}
          style={{
            ...polishUndoButtonStyle,
            opacity: undoBusy ? 0.6 : 1,
            cursor: undoBusy ? "default" : "pointer",
          }}
          title="Polish rückgängig machen — Originaltext aus raw_transcript wiederherstellen"
          aria-label="Undo polish — restore original from raw_transcript"
        >
          {undoBusy ? (
            <Loader2
              size={14}
              style={{ animation: "lokyy-spin 0.9s linear infinite" }}
            />
          ) : (
            <Undo2 size={14} />
          )}
          Original
        </button>
      )}
      {polishState.kind === "ok" && (
        <span style={POLISH_OK_STYLE} aria-live="polite">
          ✓ poliert
        </span>
      )}
      {polishState.kind === "err" && (
        <span
          style={POLISH_ERR_STYLE}
          title={polishState.message}
          aria-live="polite"
        >
          Polish fehlgeschlagen: {polishState.message}
        </span>
      )}
    </>
  ) : null;

  // TTS button — same icon-square shape as Save. Always rendered (so
  // users can see the affordance) but visually disabled + tooltipped
  // when the browser lacks SpeechSynthesis support. Tooltip changes
  // based on read/stop state for parity with Polish/Save patterns.
  const ttsActiveStyle = isMobile
    ? TTS_BUTTON_STYLE_ACTIVE_MOBILE
    : TTS_BUTTON_STYLE_ACTIVE;
  const ttsIdleStyle = isMobile ? TTS_BUTTON_STYLE_MOBILE : TTS_BUTTON_STYLE;
  const ttsButton = (
    <button
      type="button"
      onClick={handleToggleSpeech}
      disabled={!ttsSupported}
      style={{
        ...(isReading ? ttsActiveStyle : ttsIdleStyle),
        opacity: ttsSupported ? 1 : 0.4,
        cursor: ttsSupported ? "pointer" : "not-allowed",
      }}
      title={
        ttsSupported
          ? isReading
            ? "Vorlesen stoppen"
            : "Notiz vorlesen"
          : "Browser unterstützt keine Sprachausgabe"
      }
      aria-label={
        ttsSupported
          ? isReading
            ? "Stop reading aloud"
            : "Read note aloud"
          : "Text-to-speech not supported by browser"
      }
    >
      {isReading ? <VolumeX size={16} /> : <Volume2 size={16} />}
    </button>
  );

  // Notes without a ULID (legacy / hand-written w/o frontmatter) still
  // render the title — they just don't get the copy affordances.
  // Manual-save button + badge. Rendered as a small group in both the
  // no-ULID and full branches so legacy notes also get save feedback.
  // Story: separate Save & Sync buttons — disabled-state logic.
  //
  // A save/sync is "in flight" whenever the badge says "saving" or an explicit
  // `api.sync()` request is pending. Both buttons disable while in flight to
  // avoid double-submit / racing the git lock.
  const inFlight = syncState === "saving" || syncing === true;
  // SAVE is a no-op when the note isn't dirty → disable it (AC#5). It also
  // disables while in flight. (`isDirty` is optional for back-compat; when the
  // caller doesn't pass it we fall back to the old "only disable while saving"
  // behavior so legacy mounts keep a usable Save button.)
  const saveDisabled = inFlight || (isDirty !== undefined && !isDirty);
  // SYNC disables (a) while anything is in flight, and (b) when the state is
  // already "synced" AND there are no pending local changes — there's nothing
  // to reconcile (AC#5). A dirty note still allows Sync (the user may want to
  // pull remote first); a `synced` + clean note is the genuine no-op.
  const syncDisabled = inFlight || (syncState === "synced" && isDirty !== true);
  const saveControls =
    syncState || onManualSave || onSync ? (
      <>
        {syncState && <SaveBadge status={syncState} lastSavedAt={lastSavedAt} />}
        {errorMsg && (
          <button
            type="button"
            onClick={() => onDismissError?.()}
            title={errorMsg}
            aria-label={`Save error: ${errorMsg}. Click to retry.`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "transparent",
              border: `1px solid ${C.err}`,
              borderRadius: 5,
              padding: "2px 8px",
              color: C.err,
              fontSize: 11,
              fontFamily: FONT.ui,
              cursor: "pointer",
            }}
          >
            <RefreshCw size={12} />
            Erneut versuchen
          </button>
        )}
        {onManualSave && (
          <button
            type="button"
            onClick={onManualSave}
            disabled={saveDisabled}
            style={{
              ...(isMobile ? SAVE_BUTTON_STYLE_MOBILE : SAVE_BUTTON_STYLE),
              opacity: saveDisabled ? 0.45 : 1,
              cursor: saveDisabled ? "default" : "pointer",
            }}
            title={
              isDirty === false
                ? "Nichts zu speichern — alle Änderungen sind sicher"
                : "Jetzt speichern (Cmd/Ctrl+S)"
            }
            aria-label="Save now"
          >
            {syncState === "saving" ? (
              <Loader2
                size={16}
                style={{ animation: "lokyy-spin 0.9s linear infinite" }}
              />
            ) : (
              <Save size={16} />
            )}
          </button>
        )}
        {onSync && (
          <button
            type="button"
            onClick={onSync}
            disabled={syncDisabled}
            style={{
              ...(isMobile ? SYNC_BUTTON_STYLE_MOBILE : SYNC_BUTTON_STYLE),
              opacity: syncDisabled ? 0.45 : 1,
              cursor: syncDisabled ? "default" : "pointer",
            }}
            title={
              syncDisabled
                ? "Bereits synchron — nichts abzugleichen"
                : "Mit Forgejo abgleichen (pull --rebase + push)"
            }
            aria-label="Sync with Forgejo"
          >
            {syncing ? (
              <Loader2
                size={16}
                style={{ animation: "lokyy-spin 0.9s linear infinite" }}
              />
            ) : (
              <RefreshCw size={16} />
            )}
          </button>
        )}
      </>
    ) : null;

  // Story: Real "Notiz löschen" — DESKTOP inline two-step delete control.
  // Renders nothing until App wires `onDeleteNote`. The two-step affirmative
  // gate (NOT a single window.confirm): tapping "Notiz löschen" swaps the pill
  // into "Wirklich löschen? [Endgültig löschen] [Abbrechen]"; only the second
  // deliberate tap calls the parent. Errors surface inline next to the
  // controls. Distinct from Forget (which lives further right and only hides
  // the note from search).
  const deleteControls = onDeleteNote ? (
    deleteState.kind === "idle" ? (
      <button
        type="button"
        onClick={() => setDeleteState({ kind: "confirm" })}
        style={DELETE_BUTTON_STYLE}
        title="Notiz endgültig löschen — entfernt die Datei aus dem Vault (nicht nur aus der Suche)"
        aria-label="Notiz löschen"
      >
        <Trash2 size={14} />
        Notiz löschen
      </button>
    ) : (
      <span
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        role="group"
        aria-label="Löschen bestätigen"
      >
        <span style={DELETE_PROMPT_STYLE}>Wirklich löschen?</span>
        <button
          type="button"
          onClick={() => void handleDeleteConfirmed()}
          disabled={deleteState.kind === "running"}
          style={{
            ...DELETE_CONFIRM_BUTTON_STYLE,
            opacity: deleteState.kind === "running" ? 0.6 : 1,
            cursor: deleteState.kind === "running" ? "default" : "pointer",
          }}
          title="Diese Notiz endgültig löschen"
          aria-label="Endgültig löschen"
        >
          {deleteState.kind === "running" ? (
            <Loader2
              size={14}
              style={{ animation: "lokyy-spin 0.9s linear infinite" }}
            />
          ) : (
            <Trash2 size={14} />
          )}
          Endgültig löschen
        </button>
        <button
          type="button"
          onClick={() => setDeleteState({ kind: "idle" })}
          disabled={deleteState.kind === "running"}
          style={{
            ...DELETE_CANCEL_BUTTON_STYLE,
            opacity: deleteState.kind === "running" ? 0.6 : 1,
            cursor: deleteState.kind === "running" ? "default" : "pointer",
          }}
          aria-label="Abbrechen"
        >
          Abbrechen
        </button>
        {deleteState.kind === "err" && (
          <span
            style={DELETE_ERR_STYLE}
            title={deleteState.message}
            aria-live="polite"
          >
            Löschen fehlgeschlagen: {deleteState.message}
          </span>
        )}
      </span>
    )
  ) : null;

  // ── Mobile: slim top bar + "⋮" actions sheet ──────────────────────────
  // On phones every action button is unreachable in the inline row, so the
  // header collapses to title + save-badge + a single "⋮" button that opens
  // the NoteActionsSheet. The sheet reuses the SAME handlers (handlePolish,
  // handleToggleSpeech, handleCopyId/Prompt, onManualSave, onSync, onForget…)
  // — no behaviour is duplicated. Desktop keeps the inline row unchanged.
  if (isMobile) {
    return (
      <>
        <BadgeAnimationStyles />
        <div
          style={{
            ...(forgotten ? HEADER_STYLE_FORGOTTEN : HEADER_STYLE),
            flexWrap: "nowrap",
          }}
        >
          <Breadcrumb segments={breadcrumbSegments} onFolderJump={onFolderJump} />
          <span
            style={{ ...TITLE_STYLE, opacity: forgotten ? 0.6 : 1 }}
            title={title}
          >
            {title || noteId}
          </span>
          {syncState && <SaveBadge status={syncState} lastSavedAt={lastSavedAt} />}
          {toast && <span style={TOAST_STYLE}>{toast}</span>}
          <button
            type="button"
            onClick={() => setActionsSheetOpen(true)}
            aria-label="Notiz-Aktionen"
            title="Aktionen"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: TOUCH_TARGET_MIN,
              height: TOUCH_TARGET_MIN,
              flexShrink: 0,
              background: C.elevated,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              cursor: "pointer",
              color: C.text,
            }}
          >
            <MoreVertical size={22} style={{ color: C.accent }} />
          </button>
        </div>
        <NoteActionsSheet
          open={actionsSheetOpen}
          onClose={() => setActionsSheetOpen(false)}
          noteId={noteId}
          title={title || noteId}
          isDirty={isDirty}
          saving={syncState === "saving"}
          syncing={syncing}
          isReading={isReading}
          ttsSupported={ttsSupported}
          hasRawTranscript={rawTranscriptPresent}
          forgotten={forgotten}
          onManualSave={() => onManualSave?.()}
          onSync={() => onSync?.()}
          onToggleSpeech={handleToggleSpeech}
          onPolish={() => void handlePolish()}
          onPolishUndo={() => void handlePolishUndo()}
          onProperties={() => onShowProperties?.()}
          onBacklinks={() => onShowBacklinks?.()}
          onOutline={() => onShowOutline?.()}
          onCopyId={() => void handleCopyId()}
          onCopyPrompt={() => void handleCopyPrompt()}
          onForget={() => onForget?.(noteId)}
          onUnforget={() => onUnforget?.(noteId)}
          onDeleteNote={onDeleteNote ? () => onDeleteNote(noteId) : undefined}
        />
      </>
    );
  }

  if (!ulid) {
    return (
      <>
        <BadgeAnimationStyles />
        <div style={forgotten ? HEADER_STYLE_FORGOTTEN : HEADER_STYLE}>
          <Breadcrumb
            segments={breadcrumbSegments}
            onFolderJump={onFolderJump}
          />
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
          {polishControls}
          {ttsButton}
          {saveControls}
          {deleteControls}
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
      </>
    );
  }

  return (
    <>
      <BadgeAnimationStyles />
      <div style={forgotten ? HEADER_STYLE_FORGOTTEN : HEADER_STYLE}>
      <Breadcrumb
        segments={breadcrumbSegments}
        onFolderJump={onFolderJump}
      />
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
      {polishControls}
      {ttsButton}
      {saveControls}
      <button
        type="button"
        onClick={() => void handleCopyPrompt()}
        style={aiButtonStyle}
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
              style={
                isMobile
                  ? { ...UNFORGET_BUTTON_STYLE, padding: "8px 14px", minHeight: 40, fontSize: 13 }
                  : UNFORGET_BUTTON_STYLE
              }
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
              style={
                isMobile
                  ? { ...FORGET_BUTTON_STYLE, padding: "8px 14px", minHeight: 40, fontSize: 13 }
                  : FORGET_BUTTON_STYLE
              }
              title="Diese Note aus Suchen ausblenden (bleibt im Vault)"
              aria-label="Forget note — hide from retrieval, keep in vault"
            >
              <span aria-hidden="true">🗑️</span>
              Forget
            </button>
          )}
      {/* Story: Real "Notiz löschen" — desktop two-step delete, distinct from
          and placed AFTER Forget so the destructive action is clearly its own
          control rather than a variant of forget. */}
      {deleteControls}
      {/* ID badge is desktop-only — the same ULID is embedded in the
          AI-Prompt copy payload, so mobile users still get the data they
          need without losing 90+ px of header chrome. */}
      {!isMobile && (
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
      )}
      </div>
    </>
  );
}

/**
 * Inject the spin + pulse keyframes once. The project doesn't pull in a
 * CSS-in-JS lib that supports `@keyframes`, so we drop them through a
 * single <style> tag. Multiple instances are fine because we use the
 * `data-lokyy-badge-anim` attribute so React de-dupes within the tree;
 * worst-case duplicate tags resolve to the same keyframe definitions.
 */
function BadgeAnimationStyles() {
  return (
    <style data-lokyy-badge-anim>{`
      @keyframes lokyy-spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
      @keyframes lokyy-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.35; }
      }
    `}</style>
  );
}
