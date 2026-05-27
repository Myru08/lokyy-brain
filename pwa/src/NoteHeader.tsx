import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Loader2, Save, RefreshCw } from "lucide-react";
import { C, FONT } from "./theme.js";
import { useIsMobile } from "./responsive.js";

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
   * Called when the user clicks "Erneut versuchen" on an error state.
   * App.tsx clears errorMsg and (optionally) re-queues a save.
   */
  onDismissError?: () => void;
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
  syncState,
  lastSavedAt,
  errorMsg,
  onManualSave,
  onDismissError,
}: NoteHeaderProps) {
  const ulid = useMemo(() => extractFrontmatterUlid(body), [body]);
  const forgotten = useMemo(() => extractFrontmatterForgotten(body), [body]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  // Phase D Wave D1 — collapse the ID-badge on mobile (it dominates a
  // 375px header and the AI-Prompt button already encodes the ULID in the
  // copy payload) and grow the remaining buttons to 40px tall.
  const isMobile = useIsMobile();
  const aiButtonStyle = isMobile ? AI_BUTTON_STYLE_MOBILE : AI_BUTTON_STYLE;

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
  // Manual-save button + badge. Rendered as a small group in both the
  // no-ULID and full branches so legacy notes also get save feedback.
  const saveControls =
    syncState || onManualSave ? (
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
            disabled={syncState === "saving"}
            style={{
              ...(isMobile ? SAVE_BUTTON_STYLE_MOBILE : SAVE_BUTTON_STYLE),
              opacity: syncState === "saving" ? 0.45 : 1,
              cursor: syncState === "saving" ? "default" : "pointer",
            }}
            title="Jetzt speichern (Cmd/Ctrl+S)"
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
      </>
    ) : null;

  if (!ulid) {
    return (
      <>
        <BadgeAnimationStyles />
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
          {saveControls}
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
