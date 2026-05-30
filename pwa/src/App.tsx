import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Note, TreeNode } from "@lokyy/shared";
import { ArrowUpRight, Settings as SettingsIcon, Search as SearchIcon, Network as NetworkIcon, Bot, Menu as MenuIcon, X as XIcon } from "lucide-react";
import { useIsMobile, TOUCH_TARGET_MIN } from "./responsive.js";
import { AgentReviewPanel } from "./AgentReviewPanel.js";
import { Settings } from "./Settings.js";
import { CommandPalette } from "./CommandPalette.js";
import { BacklinksPanel } from "./BacklinksPanel.js";
import { Tabs, type TabRef } from "./Tabs.js";
import { Outline } from "./Outline.js";
import { DragHandle, useResizableWidth } from "./Resizable.js";
// GraphView wiegt durch react-force-graph-2d ~470 KB — Lazy-Load, Chunk
// kommt erst, wenn der User den Graph tatsächlich öffnet.
const GraphView = lazy(() =>
  import("./GraphView.js").then((m) => ({ default: m.GraphView })),
);
import { api, ApiError, type MenuItem } from "./api.js";
import { Sidebar } from "./sidebar/Sidebar.js";
import { MenuEditor } from "./sidebar/MenuEditor.js";
import { resolveView } from "./sidebar/views/registry.js";
import { SplitView } from "./SplitView.js";
import type { EditorHandle } from "./editor/Editor.js";
import { prefetchTags } from "./editor/tagAutocomplete.js";
import { FileTree, type FileTreeHandle } from "./FileTree.js";
import { ImportPanel } from "./ImportPanel.js";
import { TagPane } from "./TagPane.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { NoteHeader } from "./NoteHeader.js";
import { QuickSwitcher } from "./QuickSwitcher.js";
import { DailyNoteButton } from "./DailyNoteButton.js";
import { TemplatePicker } from "./TemplatePicker.js";
import { VoiceQuickButton } from "./VoiceQuickButton.js";
import { BottomNav } from "./BottomNav.js";
import { VoiceReviewSheet } from "./VoiceReviewSheet.js";
import { SessionUserContext } from "./AuthGate.js";
import { C, FONT } from "./theme.js";

/**
 * App-Shell. Drei Bereiche: Datei-Baum (Vault-Struktur), Editor (Inhalt
 * einer Notiz), Import-Panel als Slide-over.
 *
 * Der Server kümmert sich um Git — der Client lädt, ändert, speichert.
 * Beim Wiederfokussieren des Fensters wird die offene Notiz neu geladen
 * (Server pullt dabei). Forgejo bleibt die Wahrheit.
 *
 * Noch offen (siehe README): Graph-Ansicht (react-force-graph),
 * IndexedDB-Offline-Layer, Whisper-Handler für Sprachnachrichten.
 */

/**
 * SyncState — lifecycle the save badge cycles through.
 *
 *   idle      — nothing in flight, nothing dirty, no recent activity
 *   dirty     — local changes not yet sent (debounce timer running or paused)
 *   saving    — PUT in flight to /api/notes/:id
 *   saved     — server returned 2xx within the last 30s
 *   synced    — git push confirmed (we treat any 2xx PUT as synced, since the
 *               server runs add→commit→pull→push synchronously inside putNote)
 *   conflict  — server returned 409 (rebase failed)
 *   error     — last save threw (network / 5xx / etc.)
 */
type SyncState =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "synced"
  | "conflict"
  | "error";

const SYNC_LABEL: Record<SyncState, { text: string; color: string }> = {
  idle: { text: "synchron", color: C.ok },
  dirty: { text: "ungespeichert", color: C.gold },
  saving: { text: "speichert…", color: C.gold },
  saved: { text: "gespeichert", color: C.ok },
  synced: { text: "synct ✓", color: C.ok },
  conflict: { text: "konflikt — bitte neu laden", color: C.err },
  error: { text: "fehler beim speichern", color: C.err },
};

/**
 * Save debounce. The old value was 1200ms which committed a git revision
 * almost every typing pause — too granular for diff history and visibly
 * sluggish on slow disks. 5s is the sweet spot: any natural pause beyond
 * a sentence flushes, but mid-paragraph editing stays as a single revision.
 * `beforeunload` + `visibilitychange` + tab-switch are the safety nets that
 * make this debounce window safe.
 */
const SAVE_DEBOUNCE_MS = 5000;

/**
 * Property-edit debounce — kept shorter than typing debounce because each
 * PropertiesPanel edit is intentional (clicked a button / typed a field).
 */
const PROPS_DEBOUNCE_MS = 1500;

/**
 * "Saved" sticks visible for this long, then collapses back to idle so the
 * badge stops shouting after the user moved on.
 */
const SAVED_FADE_MS = 30_000;

/**
 * isTyping window — any keystroke marks the editor as typing for this long.
 * Used to gate focus-pull refetches so we don't clobber the cursor mid-flow.
 */
const TYPING_QUIET_MS = 2000;

/** Pfad-unsichere Zeichen raus, Leerzeichen bleiben (Obsidian-treu). */
function safeName(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, "").trim();
}

/** "pai/sub/hermes" -> "pai/sub" ; "hermes" -> "" */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/**
 * Collect every folder PATH from the tree, recursively, in pre-order. Used to
 * populate the VoiceReviewSheet folder picker so a new voice note can land
 * anywhere in the vault, not just `30_captures/voice`.
 */
function collectFolderPaths(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "folder") {
      out.push(n.path);
      out.push(...collectFolderPaths(n.children));
    }
  }
  return out;
}

/** Notiz-Titel (H1/Dateiname) flach aus dem Baum — für Wikilink-Auflösung. */
function flattenNotes(nodes: TreeNode[]): { name: string; id: string }[] {
  const out: { name: string; id: string }[] = [];
  for (const n of nodes) {
    if (n.type === "note") out.push({ name: n.name, id: n.path });
    else out.push(...flattenNotes(n.children));
  }
  return out;
}

/**
 * Polish-undo helper — rewrites a polished note's body back to its
 * pre-polish form.
 *
 * Input contract (set by `POST /api/notes/:id/ai-polish`):
 *   - `raw_transcript:` is a top-level frontmatter field holding the
 *     pre-polish markdown body. Multi-line bodies are emitted as YAML
 *     block scalars (`|`, `|-`, `|+`, `>`, `>-`, `>+`) by js-yaml; single-
 *     line bodies may appear inline.
 *   - `ai_polished_at:` and `ai_polished_model:` are top-level scalars.
 *
 * Output:
 *   - new body string with the three polish-marker fields removed and
 *     the markdown body replaced by the parsed `raw_transcript` value
 *   - `null` when no `raw_transcript` field is present (caller treats
 *     this as "nothing to undo")
 *
 * Why a hand-rolled parser:
 *   The PWA currently ships only `gray-matter` on the server side; the
 *   frontend's existing frontmatter parser (PropertiesPanel.tsx) is
 *   flat-only and doesn't speak block scalars. Adding a YAML lib to the
 *   PWA bundle for one feature is overkill — the polish endpoint always
 *   writes the same three fields with predictable shapes, so a focused
 *   parser covers the use case at ~50 lines.
 *
 * Block-scalar styles handled:
 *   - `|`  (literal, keep final newline)
 *   - `|-` (literal, strip final newline)
 *   - `|+` (literal, keep all trailing newlines)
 *   - `>`  (folded, keep final newline)
 *   - `>-` (folded, strip final newline)
 *   - `>+` (folded, keep all trailing newlines)
 *   We treat folded and literal identically for restoration — js-yaml's
 *   default for multi-line strings is literal (`|-`), and even when the
 *   user typed with linebreaks the folded variant round-trips the same
 *   text minus one newline either way. Good enough for the recovery path.
 */
function restorePrePolishBody(body: string): string | null {
  const fmMatch = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/.exec(body);
  if (!fmMatch) return null;
  const fmOpen = fmMatch[1] ?? "";
  const fmBlock = fmMatch[2] ?? "";
  const fmClose = fmMatch[3] ?? "";
  // Intentional: the polished body (everything after the closing `---`)
  // is discarded — that's the entire point of "undo polish". We rebuild
  // the body from the captured `raw_transcript` value instead.

  const lines = fmBlock.split(/\r?\n/);
  let rawTranscript: string | null = null;
  const keptLines: string[] = [];

  const STRIP_KEYS = new Set([
    "raw_transcript",
    "ai_polished_at",
    "ai_polished_model",
  ]);

  // Single pass: top-level keys live at column 0 (no leading whitespace).
  // When we hit a stripped key we either consume its inline value (single
  // line) or consume its indented block-scalar children (multi-line).
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const km = /^([A-Za-z_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/.exec(line);
    if (!km) {
      // Continuation / comment / blank — keep verbatim (it belongs to the
      // previous key, which we either kept or stripped along with its
      // children below).
      keptLines.push(line);
      i++;
      continue;
    }
    const key = km[1] ?? "";
    const rest = (km[2] ?? "").trim();
    if (!STRIP_KEYS.has(key)) {
      keptLines.push(line);
      i++;
      continue;
    }
    // Stripped key. If it's a block scalar, capture its body for
    // raw_transcript and advance past the indented children.
    const blockMatch = /^([|>])([+-]?)\s*$/.exec(rest);
    if (blockMatch && key === "raw_transcript") {
      const chomp = blockMatch[2] ?? "";
      // Collect indented child lines.
      const children: string[] = [];
      let baseIndent: number | null = null;
      let j = i + 1;
      while (j < lines.length) {
        const ln = lines[j] ?? "";
        if (ln.trim() === "") {
          children.push("");
          j++;
          continue;
        }
        const indentMatch = /^(\s+)/.exec(ln);
        if (!indentMatch) break; // next top-level key
        const indent = (indentMatch[1] ?? "").length;
        if (baseIndent === null) baseIndent = indent;
        if (indent < baseIndent) break;
        children.push(ln.slice(baseIndent));
        j++;
      }
      // Apply chomp: `-` strips trailing blank lines; `+` keeps everything;
      // default keeps exactly one trailing newline. We always rejoin with
      // `\n` and let the body-write below re-add a single trailing newline.
      let txt = children.join("\n");
      if (chomp === "-") {
        txt = txt.replace(/\n+$/, "");
      } else if (chomp === "+") {
        // keep as-is
      } else {
        txt = txt.replace(/\n+$/, "") + "\n";
      }
      rawTranscript = txt;
      i = j;
      continue;
    }
    if (blockMatch) {
      // Block-scalar for a non-raw stripped key (e.g. multi-line model
      // string — unlikely but defensive). Just skip the children.
      let j = i + 1;
      let baseIndent: number | null = null;
      while (j < lines.length) {
        const ln = lines[j] ?? "";
        if (ln.trim() === "") {
          j++;
          continue;
        }
        const indentMatch = /^(\s+)/.exec(ln);
        if (!indentMatch) break;
        const indent = (indentMatch[1] ?? "").length;
        if (baseIndent === null) baseIndent = indent;
        if (indent < baseIndent) break;
        j++;
      }
      i = j;
      continue;
    }
    // Inline scalar — drop the line for stripped keys. For raw_transcript
    // specifically, capture the inline value (stripping optional quotes).
    if (key === "raw_transcript") {
      let t = rest;
      if (
        (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
        (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
      ) {
        t = t.slice(1, -1);
      }
      rawTranscript = t;
    }
    i++;
  }

  if (rawTranscript === null) return null;

  // Rebuild the frontmatter block, preserving the original open/close
  // marker bytes (CRLF vs LF) so we don't introduce diff noise.
  const newFmBlock = keptLines.join("\n").replace(/\n+$/, "");
  // Body separator: js-yaml + gray-matter emit a single newline after the
  // closing `---`. The polish endpoint preserves whatever the original had
  // around the body, so we re-emit raw_transcript's contents with one
  // trailing newline (matches what most editors expect).
  const newBody = rawTranscript.endsWith("\n")
    ? rawTranscript
    : rawTranscript + "\n";
  return `${fmOpen}${newFmBlock}${fmClose}${newBody}`;
}

export function App() {
  const [tree, setTree] = useState<TreeNode[]>([]);
  // All folder paths, derived recursively from the tree — feeds the
  // VoiceReviewSheet folder picker for new voice notes.
  const folderPaths = useMemo(() => collectFolderPaths(tree), [tree]);
  const [active, setActive] = useState<Note | null>(null);
  const [sync, setSync] = useState<SyncState>("idle");
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Mobile Voice Review-Sheet (opened from the BottomNav Voice tab). Replaces
  // the old live-into-editor flow — record → editable transcript → insert.
  const [voiceReviewOpen, setVoiceReviewOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  // Epic 11 / Story 11.3+11.4 wireup — Sidebar-Menü-System.
  // `activeMenuItem` ist die im Workspace-Menü gewählte Ansicht (Ordner +
  // View-Typ); App ist die Quelle der Wahrheit, die Sidebar spiegelt sie nur.
  // Der erste System-Punkt wird beim Mount als Default gesetzt.
  const [activeMenuItem, setActiveMenuItem] = useState<MenuItem | null>(null);
  // Lokaler Open-State des Zahnrad-Editors (Story 11.2). Beim Schließen wird
  // das Menü neu geladen (Sidebar fetcht selbst; wir bumpen einen Key, damit
  // auch der Default-Punkt nach Edits frisch aufgelöst wird).
  const [menuEditorOpen, setMenuEditorOpen] = useState(false);
  const [menuReloadKey, setMenuReloadKey] = useState(0);
  const [backlinksRefresh, setBacklinksRefresh] = useState(0);
  const [openTabs, setOpenTabs] = useState<TabRef[]>([]);
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tagFilteredNoteIds, setTagFilteredNoteIds] = useState<Set<string> | null>(null);
  const [propsExpanded, setPropsExpanded] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [defaultImportFolder, setDefaultImportFolder] = useState<string>("");
  // Phase C Wave C3 / Story 1 — Agent-Review aggregated queue.
  // `pendingCount` mirrors the server's `totalPending` so the toolbar badge
  // updates without keeping the panel mounted. We refresh on mount + every
  // 5 minutes (idle poll) and AgentReviewPanel pushes the latest count back
  // via `onCountChange` after every accept/reject/dismiss action.
  const [agentReviewOpen, setAgentReviewOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const sessionUser = useContext(SessionUserContext);
  // SessionUserContext is non-null at App-render time (AuthGate gates this
  // tree) but the type allows null — fall back gracefully without crashing.
  const currentUser = sessionUser?.name?.trim() || sessionUser?.userId || "oliver";
  // Split-View: Sekundär-Pane. Cmd/Ctrl+Klick auf einen Wikilink öffnet das
  // Ziel hier — gewählter Pfad: wikilinkExtension reicht Modifier-State per
  // optionaler `onOpenLinkSplit`-Callback durch (klein, getestet, ein Caller).
  const [secondaryNoteId, setSecondaryNoteId] = useState<string | null>(null);
  const [filetreeWidth, setFiletreeWidth] = useResizableWidth({
    storageKey: "filetree",
    defaultWidth: 248,
    min: 160,
    max: 480,
  });
  const [outlineWidth, setOutlineWidth] = useResizableWidth({
    storageKey: "outline",
    defaultWidth: 220,
    min: 140,
    max: 420,
  });

  // Phase D Wave D1 — Mobile drawer state. On viewports < 640px the sidebar
  // (FileTree + TagPane) collapses behind a hamburger to give the editor the
  // full screen width. Desktop keeps the always-visible aside.
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Mobile bottom-nav Voice tab → editable Voice Review-Sheet (replaces the
  // old live-into-editor flow that black-screened on Android).
  const [voiceSheetOpen, setVoiceSheetOpen] = useState(false);
  // Mobile-only Outline overlay (desktop shows the Outline pane inline; on a
  // phone it's reachable via the "⋮" note-actions sheet → "Gliederung").
  const [mobileOutlineOpen, setMobileOutlineOpen] = useState(false);
  // Mobile top-bar "⋮" app-menu — holds the secondary app actions
  // (Settings / Import / Graph / Daily / Vorlagen / Review) so the slim top
  // bar stays at ☰ + logo + ⋮. Desktop shows these inline (menu never opens).
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  // Auto-close the drawer when navigating into a note (mobile UX: tap a note
  // → drawer slides out, full-screen editor remains).
  function openAndCloseDrawer(id: string) {
    void open(id);
    if (isMobile) setSidebarOpen(false);
  }

  const saveTimer = useRef<number | null>(null);
  const dirtyBody = useRef<string>("");
  const activeRef = useRef<Note | null>(null);
  activeRef.current = active;
  // Opt-in "generate voice-note title via AI" flag, read live by
  // handleVoiceInsert. A ref (not state) so the callback always sees the
  // latest persisted value without re-binding. Server default is false; we
  // stay false until /api/voice/settings answers.
  const voiceAiTitleRef = useRef<boolean>(false);
  // Imperative handle on FileTree — used by the NoteHeader breadcrumb to
  // jump to a folder (expand ancestors + scroll into view) without
  // lifting all of FileTree's UI state into App.tsx.
  const fileTreeRef = useRef<FileTreeHandle | null>(null);

  // Save-lifecycle tracking — surfaced to NoteHeader for the badge UI.
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Story: separate Save & Sync buttons.
  //
  // `syncing` is true while an explicit `api.sync()` reconcile is in flight —
  // drives the Sync button's spinner + disabled state in NoteHeader. Distinct
  // from `sync === "saving"` (the per-note PUT lifecycle).
  const [syncing, setSyncing] = useState(false);
  // `dirty` mirrors `dirtyBody !== savedBodyRef` as React state so NoteHeader
  // can disable the Save button when there's nothing to flush. The refs are
  // the source of truth for the save pipeline; we set this flag everywhere we
  // flip the sync badge so the two never drift (idle/synced ⇒ clean,
  // dirty ⇒ dirty). Kept as state (not derived from refs) because ref reads
  // don't trigger re-renders — the button must re-enable the instant the user
  // types and re-disable the instant a save lands.
  const [dirty, setDirty] = useState(false);

  /* ── Live-voice-in-editor target tracking ─────────────────────────
   * VoiceQuickButton's Live-mode "Live in neuen Editor schreiben"
   * option streams finalized speech segments into the *currently open*
   * note's body. We remember which note was the recording target so
   * (a) we can keep appending to that note even if the user switches
   * tabs, and (b) we can surface a warning chip in the recorder if
   * they did. The id is set when the recorder asks us to open the
   * note, cleared when it tells us recording stopped.
   * ─────────────────────────────────────────────────────────────── */
  const liveTargetNoteIdRef = useRef<string | null>(null);
  const [liveTargetNoteId, setLiveTargetNoteId] = useState<string | null>(null);
  liveTargetNoteIdRef.current = liveTargetNoteId;

  /* ── Live-voice insertion-at-cursor anchor ───────────────────────
   * The recorder used to append finals + interims to the end-of-doc
   * regardless of where the user's cursor was. Now we anchor to the
   * cursor at the START of the recording session and grow the insertion
   * zone from there.
   *
   * `liveInsertAnchorRef` — char-offset into `active.body` where the
   *   session's first segment lands. Captured lazily on the first
   *   handleLiveVoiceAppend / handleLiveVoiceReplaceTail call
   *   (recorder may fire either first). null = no active session.
   *
   * `liveInsertLengthRef` — total chars inserted at this anchor
   *   (finals + current interim). Inserts go to
   *   `anchor + liveInsertLength`, and after each successful insertion
   *   we bump this so the next one lands directly after.
   *
   * Both reset on session stop (handleLiveVoiceStopped via the
   * onLiveEditorStopped callback). If the user clicks elsewhere
   * mid-session the anchor stays fixed — re-capturing on every cursor
   * move would race with the recognizer's own dispatches and produce
   * scrambled output. This is the documented v1 trade-off.
   *
   * Off-target case (user tab-switched mid-recording) doesn't apply:
   * the anchor only governs the on-target setActive path; off-target
   * still uses the API-PUT append-to-end flow unchanged.
   * ─────────────────────────────────────────────────────────────── */
  const editorRef = useRef<EditorHandle | null>(null);
  const liveInsertAnchorRef = useRef<number | null>(null);
  const liveInsertLengthRef = useRef<number>(0);
  // Conflict-banner payload: when a focus-pull discovers the server body
  // differs and the local copy is dirty, we surface a non-modal banner with
  // the fresh body cached here. Clobber is opt-in via "Server-Version laden".
  const [pendingServerBody, setPendingServerBody] = useState<{
    body: string;
    note: Note;
  } | null>(null);
  // isTyping is held in a ref so the focus-pull listener can read it without
  // re-binding the event every keystroke. A debounced timer flips it back.
  const isTypingRef = useRef<boolean>(false);
  const typingTimer = useRef<number | null>(null);
  // syncRef mirrors the latest sync state for handlers that can't easily
  // close over the rendered value (visibilitychange, beforeunload).
  const syncRef = useRef<SyncState>("idle");
  syncRef.current = sync;
  // Track the active note's body at the time the save badge last said "saved"
  // so we can detect dirty status by simple body !== savedBody comparison.
  const savedBodyRef = useRef<string>("");

  /**
   * Tell the lifecycle that the editor body just changed locally. Sets the
   * isTyping flag for TYPING_QUIET_MS and updates the dirty body cache.
   * Splitting this from the save-debounce makes the two concerns testable
   * in isolation.
   */
  function markTyping() {
    isTypingRef.current = true;
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      isTypingRef.current = false;
      typingTimer.current = null;
    }, TYPING_QUIET_MS);
  }

  /**
   * Auto-collapse the "saved" badge to "idle" after SAVED_FADE_MS so the
   * UI doesn't permanently show a noisy state.
   */
  useEffect(() => {
    if (sync !== "saved" && sync !== "synced") return;
    const t = window.setTimeout(() => {
      // Only collapse if nothing newer happened — guard via the same ref.
      if (syncRef.current === "saved" || syncRef.current === "synced") {
        setSync("idle");
      }
    }, SAVED_FADE_MS);
    return () => window.clearTimeout(t);
  }, [sync, lastSavedAt]);

  const refreshTree = () =>
    api.tree().then(setTree).catch(console.error);

  useEffect(() => {
    refreshTree();
  }, []);

  // Default folder for template-created notes. Same endpoint the
  // ImportPanel already uses — we just read the same default.
  useEffect(() => {
    api
      .getImportDefaults()
      .then((d) => setDefaultImportFolder(d.defaultImportFolder))
      .catch(() => {});
  }, []);

  // Voice settings — we only need the `aiTitle` opt-in flag here, used by
  // handleVoiceInsert when creating a fresh voice note. Fire-and-forget;
  // any failure leaves the flag at its safe `false` default.
  useEffect(() => {
    api
      .getVoiceSettings()
      .then((v) => {
        voiceAiTitleRef.current = v.aiTitle === true;
      })
      .catch(() => {});
  }, []);

  // Phase C Wave C3 / Story 1 — Pending-count poll for the agent-review
  // badge. Fire-and-forget; never surface errors (the badge is informational
  // and a failed poll just means the count is briefly stale).
  useEffect(() => {
    let alive = true;
    const tick = () => {
      api
        .getAgentReviewQueue(30)
        .then((q) => alive && setPendingCount(q.totalPending))
        .catch(() => {});
    };
    tick();
    const iv = window.setInterval(tick, 5 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, []);

  // Epic 11 — Default-Menüauswahl. App lädt das gemergte Menü (System-zuerst)
  // selbst, um beim Boot den ersten Punkt aktiv zu setzen; die Sidebar fetcht
  // dieselbe Liste eigenständig für ihr Rendering. Wir bevorzugen die zuletzt
  // aktive Auswahl aus localStorage (Muster lokyy:*), fallen sonst auf den
  // ersten System-Punkt (bzw. das erste Item) zurück. Re-läuft nach jedem
  // Editor-Close (menuReloadKey), damit umbenannte/gelöschte Punkte den
  // Default nicht ins Leere zeigen lassen. Fire-and-forget; ein Fehler lässt
  // die Main-Fläche einfach beim Editor/Leerzustand.
  useEffect(() => {
    let alive = true;
    api
      .getMenu()
      .then((cfg) => {
        if (!alive) return;
        const items = cfg.items;
        if (items.length === 0) return;
        let last: string | null = null;
        try {
          last = localStorage.getItem("lokyy:sidebar:active");
        } catch {
          /* localStorage blocked — fall through to default */
        }
        setActiveMenuItem((prev) => {
          // Re-resolve the current selection against the fresh list so a
          // renamed/edited item keeps its folder/viewType in sync; if it
          // vanished (deleted), fall back to last-active → first system →
          // first item.
          if (prev) {
            const stillThere = items.find((i) => i.id === prev.id);
            if (stillThere) return stillThere;
          }
          const remembered = last && items.find((i) => i.id === last);
          if (remembered) return remembered;
          const firstSystem = items.find((i) => i.kind === "system");
          return firstSystem ?? items[0] ?? null;
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [menuReloadKey]);

  // Global Cmd/Ctrl+K opens Command Palette
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((p) => !p);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Global Cmd/Ctrl+O opens Quick Switcher
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setQuickSwitcherOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Prefetch tag list for `#` autocomplete (mirrors prefetchWikilinkTargets).
  useEffect(() => {
    prefetchTags();
  }, [backlinksRefresh]);

  // Resolve tagFilter → set of noteIds (used to prune FileTree).
  useEffect(() => {
    if (!tagFilter) {
      setTagFilteredNoteIds(null);
      return;
    }
    let cancelled = false;
    api
      .listTags()
      .then((tags) => {
        if (cancelled) return;
        const hit = tags.find((t) => t.tag === tagFilter);
        setTagFilteredNoteIds(new Set(hit?.noteIds ?? []));
      })
      .catch(() => {
        if (!cancelled) setTagFilteredNoteIds(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [tagFilter, backlinksRefresh]);

  async function openNoteById(id: string) {
    // Flush any pending edit on the *current* active note before swapping.
    // Without this, hopping notes via Tabs / Quick Switcher would silently
    // drop in-flight typing for the previous note.
    await flushNow();
    try {
      const note = await api.getNote(id);
      if (note) {
        dirtyBody.current = note.body;
        savedBodyRef.current = note.body;
        setActive(note);
        setSync("idle");
        setDirty(false);
        setErrorMsg(null);
        setPendingServerBody(null);
        setOpenTabs((prev) => {
          if (prev.some((t) => t.id === note.id)) return prev;
          return [...prev, { id: note.id, title: note.title || note.id }];
        });
      }
    } catch {
      /* ignore */
    }
  }

  function closeTab(id: string) {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      // If we closed the active tab, activate the last remaining one
      if (active?.id === id) {
        const fallback = next[next.length - 1];
        if (fallback) {
          void openNoteById(fallback.id);
        } else {
          setActive(null);
        }
      }
      return next;
    });
  }

  // Any active-note change auto-syncs into the tab list (dedup'd)
  useEffect(() => {
    if (!active) return;
    setOpenTabs((prev) => {
      if (prev.some((t) => t.id === active.id)) {
        // refresh title if it changed via save
        return prev.map((t) => (t.id === active.id ? { id: t.id, title: active.title || t.id } : t));
      }
      return [...prev, { id: active.id, title: active.title || active.id }];
    });
  }, [active?.id, active?.title]);

  // Cmd/Ctrl+W closes the active tab
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w" && active) {
        e.preventDefault();
        closeTab(active.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, openTabs]);

  /* ---------- Notiz laden / speichern ---------- */

  /**
   * Push the in-memory dirty body to the server. No-op if the body matches
   * what the server last returned (avoids zero-diff git commits). Surfaces
   * the lifecycle: dirty → saving → synced → (idle after SAVED_FADE_MS).
   *
   * Returns the saved Note on success, null on no-op. Errors are surfaced
   * via syncState + errorMsg; the function does NOT re-throw to keep the
   * fire-and-forget call sites simple.
   */
  async function flush(): Promise<Note | null> {
    const note = activeRef.current;
    if (!note) return null;
    // Strip any live-voice interim zone before persisting. The U+200E
    // LRM anchor + italic wrap is purely a display artifact for the
    // live-voice ghost-text preview — it must never reach disk.
    // SPEC contract (CLAUDE.md "Vault Contract") requires clean body
    // bytes; a stale marker zone could also confuse the pre-commit
    // frontmatter hook on the vault side.
    // This is the canonical strip site — `handleLiveVoiceAppend` and
    // `handleLiveVoiceReplaceTail` also strip on their write paths so
    // the marker doesn't accumulate, but THIS strip is the only one
    // that guarantees no marker ever reaches `api.putNote`.
    const cleanedDirty = dirtyBody.current.replace(/‎[\s\S]*$/, "").replace(/[ \t]+$/m, "");
    if (cleanedDirty !== dirtyBody.current) {
      dirtyBody.current = cleanedDirty;
    }
    const body = dirtyBody.current;
    if (!body || body === savedBodyRef.current) {
      if (syncRef.current === "dirty" || syncRef.current === "saving") {
        setSync("idle");
      }
      return null;
    }
    setSync("saving");
    setErrorMsg(null);
    try {
      const saved = await api.putNote(note.id, body);
      // Adopt the SERVER-canonical body as the new diff baseline. The server
      // normalises trailing newlines, reorders frontmatter keys (gray-matter
      // round-trip), and stamps `updated`. Storing what we SENT here would
      // leave `savedBodyRef` mismatched against any subsequent GET (focus-pull,
      // 30s tab poll) → ServerConflictBanner fires falsely on a no-op save.
      // Defensive fallback: if `saved.body` came back missing (e.g. an
      // alternate endpoint that just returns ok), keep the sent body as the
      // baseline — still better than leaving the previous baseline stale.
      const serverBody =
        typeof saved.body === "string" ? saved.body : body;
      savedBodyRef.current = serverBody;
      // Reconcile the local dirty cache to the server-normalised body ONLY if
      // the user did not keep typing during the in-flight PUT. If `dirtyBody`
      // still equals what we just sent, no new local edits arrived — we can
      // safely advance it to match the server canonical form. If it advanced
      // (user kept typing), leave `dirtyBody` alone; the next debounce fire
      // will save the newer text and that response then updates the baseline
      // again. Net invariant: `savedBodyRef` = last-known-server-canonical,
      // `dirtyBody` = local-unsent-changes. This is the "don't clobber while
      // typing" protection from the save-lifecycle overhaul; it must stay
      // intact.
      if (dirtyBody.current === body) {
        dirtyBody.current = serverBody;
      }
      // Do NOT call setActive({...saved}) here — that would change the body
      // reference and trigger the Editor's initialBody-watcher effect, which
      // could disrupt the cursor if the user kept typing during the request.
      // Only patch the title if the server normalised it (filename change).
      if (saved.title !== note.title) {
        setActive((prev) =>
          prev && prev.id === saved.id ? { ...prev, title: saved.title } : prev,
        );
      }
      setLastSavedAt(Date.now());
      // The server runs add → commit → pull --rebase → push synchronously
      // inside putNote, so a 2xx response means the change is in Forgejo.
      // Surface that as "synced" directly — the intermediate "saved"
      // sub-state is reserved for the future case where push becomes async.
      setSync("synced");
      // Clean iff the user didn't keep typing during the PUT. `dirtyBody` was
      // advanced to the server-canonical body above only when it still equalled
      // what we sent; if it advanced (user typed on), the note is still dirty.
      setDirty(dirtyBody.current !== savedBodyRef.current);
      setBacklinksRefresh((n) => n + 1);
      return saved;
    } catch (e) {
      if (e instanceof ApiError && e.isConflict) {
        setSync("conflict");
        setErrorMsg("Server hat eine neuere Version. Bitte neu laden.");
      } else {
        setSync("error");
        setErrorMsg(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
      }
      return null;
    }
  }

  /**
   * Cancel a pending debounced save and flush immediately. Used by every
   * navigation-away path (note switch, tab close, visibility change).
   */
  async function flushNow(): Promise<Note | null> {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    return flush();
  }

  async function open(id: string) {
    await flushNow();
    setPendingServerBody(null);
    try {
      const note = await api.getNote(id);
      dirtyBody.current = note.body;
      savedBodyRef.current = note.body;
      setActive(note);
      setSync("idle");
      setDirty(false);
      setErrorMsg(null);
    } catch (e) {
      console.error(e);
      setSync("error");
      setErrorMsg(e instanceof Error ? e.message : "Notiz konnte nicht geladen werden");
    }
  }

  function onChange(body: string) {
    dirtyBody.current = body;
    markTyping();
    // Body may equal the saved baseline again (user typed then undid). Reflect
    // the real dirtiness so the Save button enables/disables precisely.
    setDirty(body !== savedBodyRef.current);
    // Skip "dirty" flip if a save is already in flight — that PUT will
    // resolve to "synced" and the new debounce timer below will pick up
    // any further edits.
    if (syncRef.current !== "saving") {
      setSync("dirty");
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Manual save — fired by the NoteHeader button and Cmd/Ctrl+S. Bypasses
   * the debounce window entirely.
   */
  async function manualSave() {
    await flushNow();
  }

  /**
   * Manual Sync — fired by the NoteHeader Sync button (Story: separate Save &
   * Sync buttons). Reconciles the working copy with Forgejo via
   * `api.sync()` → `POST /api/vault/sync`, which runs `git pull --rebase` +
   * pushes any unpushed commits INSIDE the server-side git promise-lock. No
   * note content is written here.
   *
   * We flush any pending local edit first so a debounced save doesn't race the
   * reconcile (the server lock would serialize them anyway, but flushing keeps
   * the user's intent — "save then reconcile" — explicit). On success we mark
   * the badge "synced"; a conflict/backend error surfaces through the same
   * banner pattern as a save failure. Guarded against double-submit via
   * `syncing`.
   */
  async function handleSync() {
    if (syncing) return;
    await flushNow();
    setSyncing(true);
    setErrorMsg(null);
    try {
      await api.sync();
      // Reconcile done — anything the pull brought in for the ACTIVE note is
      // picked up by the focus-pull / 30s tree poll; here we only need to
      // confirm the badge. Treat a clean reconcile as "synced ✓".
      setSync("synced");
      setLastSavedAt(Date.now());
      setDirty(dirtyBody.current !== savedBodyRef.current);
    } catch (e) {
      if (e instanceof ApiError && e.isConflict) {
        setSync("conflict");
        setErrorMsg(
          "Abgleich-Konflikt — Server hat divergierende Änderungen. Bitte neu laden.",
        );
      } else {
        setSync("error");
        setErrorMsg(e instanceof Error ? e.message : "Abgleich fehlgeschlagen");
      }
    } finally {
      setSyncing(false);
    }
  }

  /**
   * Wird vom PropertiesPanel aufgerufen, wenn Frontmatter-Felder editiert
   * wurden. Der Panel liefert den vollen neuen Markdown-Body inkl.
   * Frontmatter. Wir aktualisieren active.body (Editor re-syncen seine Doc
   * via dem initialBody-Effect) und triggern ein eigenes, kürzeres Debounce
   * — Property-Edits sind absichtlich (kein Tippen), also schneller speichern.
   */
  function handleUpdateBody(newBody: string) {
    const cur = activeRef.current;
    if (!cur) return;
    dirtyBody.current = newBody;
    setActive({ ...cur, body: newBody });
    setDirty(newBody !== savedBodyRef.current);
    if (syncRef.current !== "saving") setSync("dirty");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void flush();
    }, PROPS_DEBOUNCE_MS);
  }

  /**
   * Lazily capture the cursor position from the Editor's imperative handle.
   * Called by both live-voice handlers on first dispatch of a session so the
   * insertion anchor reflects where the user actually had focus when they
   * pressed record (mostly — see jsdoc above).
   *
   * Returns the anchor (or null if no editor mounted) and stores it in the
   * ref for the rest of the session. Idempotent: subsequent calls within
   * the same session are no-ops and return the captured anchor.
   *
   * Clamping: we clamp the reported caret to the current body length
   * defensively. The recorder might fire after a focus-pull rewrote the
   * body (rare race) and CM6 would have already clamped the selection too,
   * but reading the clamped value via getCursorPos is still cheaper than
   * trusting the user to never have switched docs.
   */
  function ensureLiveInsertAnchor(body: string): number | null {
    if (liveInsertAnchorRef.current !== null) return liveInsertAnchorRef.current;
    const handle = editorRef.current;
    if (!handle) return null;
    const pos = handle.getCursorPos();
    if (pos === null) return null;
    const clamped = Math.min(Math.max(0, pos), body.length);
    liveInsertAnchorRef.current = clamped;
    liveInsertLengthRef.current = 0;
    return clamped;
  }

  /**
   * Find the LRM marker inside the insertion zone `[anchor, anchor+length)`
   * and return its offset, or `-1` if no interim is currently present. We
   * deliberately search only within the zone — a stale LRM outside the zone
   * (left over from a previous bug or a polish operation) must NOT be
   * touched by the live-voice flow.
   */
  function findInterimMarker(
    body: string,
    anchor: number,
    length: number,
  ): number {
    const zoneEnd = Math.min(body.length, anchor + length);
    const idx = body.indexOf("‎", anchor);
    if (idx === -1 || idx >= zoneEnd) return -1;
    return idx;
  }

  /**
   * Live-voice append. The VoiceQuickButton's "Live in neuen Editor
   * schreiben" mode pushes each finalized speech segment here. We insert
   * the segment at the SESSION ANCHOR (cursor position captured on the
   * first dispatch) of the LIVE-TARGET note — not at end-of-doc.
   *
   * Two paths:
   *   1. Target IS active — capture/use the anchor and splice the final
   *      into `cur.body` at `anchor + liveInsertLength`. The Editor's
   *      initialBody-watcher effect picks up the new body and CM6's
   *      built-in selection mapping shifts the user's cursor past the
   *      inserted text automatically. The 5s auto-save debounce persists
   *      it normally.
   *   2. Target is NOT active — anchor doesn't apply (user wandered off,
   *      we have no live editor handle for that note). Fall back to the
   *      original API-PUT append-to-end behavior.
   *
   * If the editor handle isn't available for the on-target case (e.g. the
   * editor unmounted between record-start and the first dispatch), we
   * degrade to end-of-doc append rather than dropping the segment.
   *
   * Marker hygiene: any tail-interim zone inside `[anchor, anchor+length)`
   * is stripped BEFORE the final segment lands. We do NOT touch LRM
   * markers outside the insertion zone — they belong to someone else.
   */
  function handleLiveVoiceAppend(segment: string) {
    const trimmed = segment.trim();
    if (!trimmed) return;
    const targetId = liveTargetNoteIdRef.current;
    if (!targetId) return;

    const cur = activeRef.current;
    if (cur && cur.id === targetId) {
      const anchor = ensureLiveInsertAnchor(cur.body);
      if (anchor === null) {
        // Anchor capture failed (editor not mounted yet). Degrade to the
        // legacy end-of-doc append so the segment isn't lost. This path
        // is intentionally rare — recorder UX gates record-start on an
        // open editor for live-target mode.
        const stripped = cur.body
          .replace(/‎[\s\S]*$/, "")
          .replace(/[ \t]+$/m, "");
        const sep = stripped.endsWith("\n") || stripped === "" ? "" : "\n";
        const newBody = stripped + sep + trimmed + "\n";
        dirtyBody.current = newBody;
        setActive({ ...cur, body: newBody });
        if (syncRef.current !== "saving") setSync("dirty");
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = null;
          void flush();
        }, SAVE_DEBOUNCE_MS);
        return;
      }

      // Strip any interim within the insertion zone before splicing the
      // final. `zoneEndAfterStrip` is where the cleaned insertion zone
      // ends — the next final lands directly there.
      let body = cur.body;
      let length = liveInsertLengthRef.current;
      const lrmIdx = findInterimMarker(body, anchor, length);
      if (lrmIdx !== -1) {
        // Cut from LRM to either the end of the zone or the next newline
        // (whichever comes first). The recorder writes interims as
        // ` ‎ *text* ` without a trailing newline, so "end of zone" is
        // usually right. If a stray newline crept in we still respect it.
        const zoneEnd = anchor + length;
        const nl = body.indexOf("\n", lrmIdx);
        const cutTo =
          nl !== -1 && nl < zoneEnd ? nl : zoneEnd;
        body = body.slice(0, lrmIdx) + body.slice(cutTo);
        length -= cutTo - lrmIdx;
      }

      // Strip trailing spaces from the cleaned zone — interim writes
      // typically leave a separating space that would now sit between
      // two finals.
      const zoneText = body.slice(anchor, anchor + length);
      const trimmedZone = zoneText.replace(/[ \t]+$/, "");
      if (trimmedZone.length !== zoneText.length) {
        body = body.slice(0, anchor) + trimmedZone + body.slice(anchor + length);
        length = trimmedZone.length;
      }

      // Same paragraph-separator policy as before: a single newline keeps
      // sentences readable without ballooning the doc. The separator only
      // applies when there's preceding text in the zone (or before the
      // anchor on the same line) that doesn't already end in newline.
      const zoneEndAfterStrip = anchor + length;
      const charBefore = zoneEndAfterStrip > 0 ? body[zoneEndAfterStrip - 1] : "";
      const needsLeadingNl =
        zoneEndAfterStrip > 0 && charBefore !== "\n" && charBefore !== undefined;
      const insertion = (needsLeadingNl ? "\n" : "") + trimmed + "\n";
      const newBody =
        body.slice(0, zoneEndAfterStrip) +
        insertion +
        body.slice(zoneEndAfterStrip);

      liveInsertLengthRef.current = length + insertion.length;
      dirtyBody.current = newBody;
      setActive({ ...cur, body: newBody });
      if (syncRef.current !== "saving") setSync("dirty");
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        void flush();
      }, SAVE_DEBOUNCE_MS);
      return;
    }

    // Off-target: append directly via API. Fire-and-forget; errors are
    // swallowed because the recorder is already showing the off-target
    // warning chip and a per-segment alert would be noise. Anchor doesn't
    // apply here — user wandered off and we have no cursor to honor.
    void (async () => {
      try {
        const note = await api.getNote(targetId);
        // Same marker-strip defense as the on-target path. The off-target
        // note may still carry a stale interim zone from the last
        // replaceTail before the user switched tabs.
        const stripped = note.body
          .replace(/‎[\s\S]*$/, "")
          .replace(/[ \t]+$/m, "");
        const sep =
          stripped.endsWith("\n") || stripped === "" ? "" : "\n";
        await api.putNote(targetId, stripped + sep + trimmed + "\n");
      } catch {
        /* see comment above */
      }
    })();
  }

  /**
   * Live-voice tail-replace. The VoiceQuickButton's live-editor mode pushes
   * not-yet-final (interim) speech text here. Unlike `handleLiveVoiceAppend`
   * (which appends permanent segments), this REPLACES the trailing interim
   * zone with new interim text — giving the user a Google-Docs-style
   * word-by-word preview that updates as the recognizer revises its guess.
   *
   * Protocol: the caller wraps interim text in a `U+200E` LEFT-TO-RIGHT MARK
   * anchor (`‎`) + markdown italics, e.g. ` ‎ *hello world* `. The
   * LRM is the search needle — invisible to the user, distinctive enough
   * that it's safe to nuke "from LRM to end of doc" on every call.
   *
   * The save-debounce is intentionally NOT extended/reset here. Interim
   * text changes locally; the 5s timer fires whenever it last fired against
   * the final-append flow. If the user stops mid-interim, the recorder
   * calls replaceTail("") to strip the marker zone, then appends the
   * trailing interim as a final segment, which DOES touch the debounce.
   *
   * `text` of "" means "just strip the interim zone" (used by the recorder
   * on stop, and as a no-op cleanup). Off-target writes are skipped — the
   * user has wandered off, surfacing interim ghost-text in a note they're
   * no longer looking at would be confusing. The final flush via
   * `handleLiveVoiceAppend` still lands when the user stops.
   */
  function handleLiveVoiceReplaceTail(text: string) {
    const targetId = liveTargetNoteIdRef.current;
    if (!targetId) return;
    const cur = activeRef.current;
    // Off-target interim is intentionally a no-op (see jsdoc above).
    if (!cur || cur.id !== targetId) return;

    const anchor = ensureLiveInsertAnchor(cur.body);
    if (anchor === null) {
      // No editor handle yet — degrade to legacy end-of-doc replace so
      // the live preview still works in the edge case where the editor
      // hasn't fully mounted. See `handleLiveVoiceAppend` for the same
      // fallback rationale.
      const stripped = cur.body
        .replace(/‎[\s\S]*$/, "")
        .replace(/[ \t]+$/m, "");
      const sep =
        text === ""
          ? ""
          : stripped === "" || stripped.endsWith("\n") || stripped.endsWith(" ")
            ? ""
            : " ";
      const displayBody = stripped + sep + text;
      if (displayBody === cur.body) return;
      dirtyBody.current = displayBody;
      setActive({ ...cur, body: displayBody });
      return;
    }

    // Strip any existing interim within the insertion zone. The interim
    // lives at the very end of the zone; we cut from the LRM to whichever
    // comes first: a newline or the end of the zone.
    let body = cur.body;
    let length = liveInsertLengthRef.current;
    const lrmIdx = findInterimMarker(body, anchor, length);
    if (lrmIdx !== -1) {
      const zoneEnd = anchor + length;
      const nl = body.indexOf("\n", lrmIdx);
      const cutTo = nl !== -1 && nl < zoneEnd ? nl : zoneEnd;
      body = body.slice(0, lrmIdx) + body.slice(cutTo);
      length -= cutTo - lrmIdx;
    }

    // Insertion point is the end of the cleaned zone — interims always
    // live at the tail so the user sees the "growing word" effect there.
    const insertPos = anchor + length;
    // Separator policy mirrors the legacy implementation: when the
    // preceding char inside the doc is whitespace/newline, no sep;
    // otherwise insert a single space so the LRM marker doesn't fuse
    // to the previous word. Empty `text` means "strip-only" — no sep.
    const charBefore = insertPos > 0 ? body[insertPos - 1] : "";
    const sep =
      text === ""
        ? ""
        : charBefore === "" ||
            charBefore === "\n" ||
            charBefore === " " ||
            charBefore === undefined
          ? ""
          : " ";
    const insertion = sep + text;
    const displayBody =
      body.slice(0, insertPos) + insertion + body.slice(insertPos);

    // No-op short-circuit — avoids a CM6 doc-swap on identical interim
    // text. Costs one string compare, saves one full-doc dispatch +
    // reparse cycle.
    if (displayBody === cur.body) {
      // Even if the visible body is unchanged, our length bookkeeping
      // may have changed (we just stripped & re-inserted the same text).
      // Persist the recomputed length so the next call agrees with us.
      liveInsertLengthRef.current = length + insertion.length;
      return;
    }
    liveInsertLengthRef.current = length + insertion.length;
    dirtyBody.current = displayBody;
    setActive({ ...cur, body: displayBody });
    // INTENTIONALLY NOT touching `syncRef`/`saveTimer` directly here.
    // The Editor's updateListener fires `onChange(displayBody)` in
    // reaction to our doc swap above, which is what actually
    // (re)arms the 5s debounce. The eventual `flush()` call strips
    // the LRM zone before PUT (canonical safety net in `flush()`),
    // so even if the debounce fires mid-interim the saved bytes are
    // clean. Marker-survives-to-disk is impossible.
  }

  // Cmd/Ctrl+S → manual save. Registered after manualSave is defined so the
  // closure captures the right reference. We don't preventDefault when no
  // note is open so the browser's default save behavior is unaffected.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (!activeRef.current) return;
        e.preventDefault();
        void manualSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Safety auto-save on tab close / visibility change / page hide. Together
  // these cover: closing the tab (beforeunload), switching to another tab
  // or app (visibilitychange), iOS Safari freeze (pagehide). The fetch is
  // fire-and-forget — the browser typically holds the document alive long
  // enough for the PUT to complete, and the beforeunload prompt gives the
  // user a chance to cancel and wait if needed.
  useEffect(() => {
    function isDirty(): boolean {
      const cur = activeRef.current;
      if (!cur) return false;
      return (
        dirtyBody.current !== "" &&
        dirtyBody.current !== savedBodyRef.current
      );
    }

    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirty()) return;
      void flushNow();
      e.preventDefault();
      e.returnValue = "";
    }

    function onVisibility() {
      if (document.visibilityState === "hidden" && isDirty()) {
        void flushNow();
      }
    }

    function onPageHide() {
      if (isDirty()) void flushNow();
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onOpenLink(target: string) {
    const hit = flattenNotes(tree).find(
      (n) => n.name.toLowerCase() === target.toLowerCase() || n.id === target,
    );
    if (hit) void open(hit.id);
  }

  /**
   * Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
   *
   * Both handlers flush any pending edit first (the server writes new
   * frontmatter, so a debounced edit in flight would race), then call
   * the API and reload the active note so the editor and PropertiesPanel
   * pick up the toggled frontmatter. The reload is needed even though
   * the API returns the saved note — passing it directly via setActive
   * would skip the body-diff path the editor relies on.
   */
  async function handleForget(targetNoteId: string) {
    await flushNow();
    try {
      const updated = await api.forgetNote(targetNoteId);
      dirtyBody.current = updated.body;
      savedBodyRef.current = updated.body;
      setActive(updated);
      setDirty(false);
      setBacklinksRefresh((n) => n + 1);
    } catch (err) {
      console.error("forgetNote failed", err);
    }
  }

  async function handleUnforget(targetNoteId: string) {
    await flushNow();
    try {
      const updated = await api.unforgetNote(targetNoteId);
      dirtyBody.current = updated.body;
      savedBodyRef.current = updated.body;
      setActive(updated);
      setDirty(false);
      setBacklinksRefresh((n) => n + 1);
    } catch (err) {
      console.error("unforgetNote failed", err);
    }
  }

  /**
   * AI-Polish handler — fires `POST /api/notes/:id/ai-polish` and refetches
   * the note so the editor picks up the polished body.
   *
   * Why this lives in App.tsx (not in NoteHeader): the polish endpoint
   * rewrites the note's body on disk. The editor needs the same refetch
   * path that forget/unforget use so cursor + sync state stay coherent.
   * NoteHeader owns the button + confirmation + spinner; we own the HTTP
   * call and the body-replacement.
   *
   * Throws (rejects) on failure so NoteHeader can surface the message
   * inline next to the button. App.tsx flushes any pending save first so
   * the polish endpoint reads the current body, not the stale committed one.
   */
  async function handlePolish(targetNoteId: string) {
    await flushNow();
    const res = await fetch(
      `/api/notes/${encodeURIComponent(targetNoteId)}/ai-polish`,
      { method: "POST", credentials: "include" },
    );
    // Backend contract: { ok: true, ... } | { ok: false, error, message }.
    // Parse-error fallthrough still surfaces something meaningful.
    const body = (await res
      .json()
      .catch(() => ({
        ok: false,
        error: "parse-error",
        message: "Antwort konnte nicht gelesen werden.",
      }))) as { ok?: boolean; error?: string; message?: string };
    if (!res.ok || body.ok !== true) {
      const msg =
        body.message ?? body.error ?? `HTTP ${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    // Refetch through the standard `api.getNote` path so the editor's
    // initialBody-watcher in Editor.tsx sees the new body and resyncs the
    // doc without losing scroll. Mirrors what handleForget does.
    try {
      const fresh = await api.getNote(targetNoteId);
      dirtyBody.current = fresh.body;
      savedBodyRef.current = fresh.body;
      setActive(fresh);
      setSync("synced");
      setDirty(false);
      setLastSavedAt(Date.now());
      setErrorMsg(null);
      setBacklinksRefresh((n) => n + 1);
    } catch (err) {
      // Polish succeeded but reload failed — note IS polished on disk,
      // the user will see it on the next focus-pull. Surface a soft error
      // so they understand why the editor still shows the un-polished body.
      throw new Error(
        `Polish OK, aber Notiz konnte nicht neu geladen werden: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Polish-undo handler — restores the pre-polish body from the
   * `raw_transcript` frontmatter field, strips `raw_transcript`,
   * `ai_polished_at`, `ai_polished_model`, and persists the rewritten
   * note via the standard save flow.
   *
   * The whole rewrite happens client-side because the polish endpoint
   * doesn't have an inverse — we already have everything we need in the
   * active note's body. We use a small inline frontmatter parser that
   * handles the YAML block-scalar `|`/`|-`/`>` shapes the polish
   * endpoint emits via gray-matter+js-yaml.
   */
  async function handlePolishUndo(targetNoteId: string) {
    const cur = activeRef.current;
    if (!cur || cur.id !== targetNoteId) {
      throw new Error("Aktive Notiz passt nicht zur Undo-Anfrage.");
    }
    await flushNow();
    const restored = restorePrePolishBody(cur.body);
    if (!restored) {
      throw new Error(
        "Kein raw_transcript im Frontmatter gefunden — nichts wiederherzustellen.",
      );
    }
    // Update local state immediately so the editor re-syncs to the
    // restored body, then persist via the existing PUT pipeline. We don't
    // use the debounce — undo is an explicit action and should land asap.
    dirtyBody.current = restored;
    setActive({ ...cur, body: restored });
    setSync("dirty");
    setDirty(restored !== savedBodyRef.current);
    try {
      const saved = await api.putNote(targetNoteId, restored);
      savedBodyRef.current = restored;
      // Match the standard save-success branch: surface "synced" + timestamp.
      setSync("synced");
      setDirty(false);
      setLastSavedAt(Date.now());
      setErrorMsg(null);
      // Reload from server so any backend-side frontmatter touches (e.g.
      // bumped `updated`) reach the editor without manual reload.
      try {
        const fresh = await api.getNote(targetNoteId);
        dirtyBody.current = fresh.body;
        savedBodyRef.current = fresh.body;
        setActive(fresh);
      } catch {
        // Best-effort — the local body is already correct.
      }
      setBacklinksRefresh((n) => n + 1);
      // Discard `saved` — the refetch above (when it succeeds) supersedes it.
      void saved;
    } catch (err) {
      setSync("error");
      setErrorMsg(err instanceof Error ? err.message : "Undo fehlgeschlagen");
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Wikilink mit Cmd/Ctrl+Klick → ins Sekundär-Pane. Auflösung mirrort
   * `onOpenLink`, aber landet bei `setSecondaryNoteId` statt `open`.
   * Falls bereits eine Secondary-Pane offen ist und die selbst einen
   * Cmd+Klick liefert (id-direkt), nehmen wir den Wert direkt.
   */
  function onOpenLinkSplit(target: string) {
    const hit = flattenNotes(tree).find(
      (n) => n.name.toLowerCase() === target.toLowerCase() || n.id === target,
    );
    setSecondaryNoteId(hit ? hit.id : target);
  }

  // Fenster wieder aktiv -> offene Notiz neu laden (Server pullt) UND
  // Datei-Baum aktualisieren. Zusätzlich pollt der Baum alle 30s solange
  // der Tab sichtbar ist — so erscheinen Notizen, die externe MCP-Clients
  // (claude.ai, Claude Code via create_note) nach Forgejo geschrieben
  // haben, ohne dass der User die Seite manuell neu lädt.
  //
  // Three guards prevent the old "refetch clobbers the editor" bug:
  //   (a) skip entirely if a debounced save is pending — let it commit first
  //   (b) skip if the user typed within the last 2s (isTypingRef) — focus
  //       events sometimes fire mid-flow on some OSes and we don't want a
  //       harmless app-switch to nuke the cursor
  //   (c) if the editor has unsaved local changes AND the server body
  //       differs, surface a non-modal banner instead of clobbering; the
  //       user can compare and decide. Without this, accidental dual-tab
  //       editing would silently lose data.
  //
  // The periodic poll ONLY hits `refreshTree()` — it never touches the
  // active-note body. Re-fetching the active note on a timer would race
  // with `isDirty`/typing protection, so that path stays bound to the
  // explicit window-focus event where the guards above are in scope.
  useEffect(() => {
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    function refreshActiveNoteIfSafe() {
      const note = activeRef.current;
      if (!note || saveTimer.current) return;
      if (isTypingRef.current) return;
      api
        .getNote(note.id)
        .then((fresh) => {
          if (fresh.body === dirtyBody.current) return;
          const localDirty =
            dirtyBody.current !== "" &&
            dirtyBody.current !== savedBodyRef.current;
          if (localDirty) {
            // Stash for the banner — let the user choose. Don't touch
            // dirtyBody / setActive.
            setPendingServerBody({ body: fresh.body, note: fresh });
            return;
          }
          // Clean local state — safe to adopt the server version directly.
          // Editor's body-watcher effect will reconcile while preserving the
          // current selection/scroll (see Editor.tsx).
          dirtyBody.current = fresh.body;
          savedBodyRef.current = fresh.body;
          setActive(fresh);
          setDirty(false);
        })
        .catch(() => {});
    }

    function refreshTreeIfVisible() {
      if (document.visibilityState === "visible") {
        void refreshTree();
      }
    }

    function startPoll() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(refreshTreeIfVisible, 30_000);
    }

    function stopPoll() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function onFocus() {
      refreshActiveNoteIfSafe();
      refreshTreeIfVisible();
    }

    function onVisibility() {
      if (document.visibilityState === "visible") {
        // Immediate tree refresh on un-hide, then resume the periodic poll.
        void refreshTree();
        startPoll();
      } else {
        stopPoll();
      }
    }

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") startPoll();

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      stopPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Apply the server's version stashed in `pendingServerBody` — only fired
   * from the conflict banner's "Server-Version laden" button. The local
   * dirty body is discarded.
   */
  function acceptServerVersion() {
    if (!pendingServerBody) return;
    const { note: fresh } = pendingServerBody;
    dirtyBody.current = fresh.body;
    savedBodyRef.current = fresh.body;
    setActive(fresh);
    setSync("idle");
    setDirty(false);
    setErrorMsg(null);
    setPendingServerBody(null);
  }

  /** Dismiss the banner and keep editing the local version. */
  function keepLocalVersion() {
    setPendingServerBody(null);
  }

  /* ---------- Struktur-Operationen (Datei-Baum) ---------- */

  /** Open-Note-id nach einem Move/Rename mitziehen. */
  function remapActive(from: string, to: string, kind: "note" | "folder") {
    const cur = activeRef.current;
    if (!cur) return;
    if (kind === "note" && cur.id === from) {
      void open(to);
    } else if (
      kind === "folder" &&
      (cur.id === from || cur.id.startsWith(from + "/"))
    ) {
      void open(to + cur.id.slice(from.length));
    }
  }

  /**
   * Create a note, auto-incrementing the title/path on a name collision.
   *
   * The server returns HTTP 409 (`ApiError.isConflict`) with the message
   * `Notiz "…" existiert bereits.` when the derived path is already taken.
   * We catch that, append ` 2`, ` 3`, … to BOTH the visible title and the
   * derived filename so they stay consistent, and retry — capped at `cap`
   * attempts to avoid an unbounded loop. The body heading (`# {title}`)
   * tracks the suffixed title too.
   *
   * Used by the quick "Neue Notiz" button and the voice "no note open" path,
   * which both start from a fixed default name and must NEVER block on a
   * second create. Any non-conflict error (or exhausting the cap) is rethrown
   * to the caller, which surfaces it exactly as before.
   *
   * @param baseTitle  Desired title (e.g. "Neue Notiz") — drives filename + heading.
   * @param parentPath Folder to create under ("" = vault root).
   * @param makeBody   Builds the note body from the (possibly suffixed) title.
   * @param cap        Max attempts including the first (default 50).
   * @returns The path that was successfully created.
   */
  async function createNoteUnique(
    baseTitle: string,
    parentPath: string,
    makeBody: (title: string) => string,
    cap = 50,
  ): Promise<string> {
    let lastErr: unknown;
    for (let n = 1; n <= cap; n++) {
      const title = n === 1 ? baseTitle : `${baseTitle} ${n}`;
      const clean = safeName(title);
      if (!clean) throw new Error("Ungültiger Notiz-Name.");
      const path = parentPath ? `${parentPath}/${clean}` : clean;
      try {
        await api.createNote(path, makeBody(title));
        return path;
      } catch (e) {
        // Only a name collision is retryable. Detect it via the 409
        // `isConflict` flag, with a message-substring fallback in case the
        // status ever changes but the German error text stays.
        const isCollision =
          (e instanceof ApiError && e.isConflict) ||
          (e instanceof Error && e.message.includes("existiert bereits"));
        if (!isCollision) throw e;
        lastErr = e;
      }
    }
    // Exhausted the suffix range — surface the last collision error.
    throw lastErr instanceof Error
      ? lastErr
      : new Error("Konnte keinen freien Notiz-Namen finden.");
  }

  async function handleCreate(
    parentPath: string,
    name: string,
    kind: "note" | "folder",
  ) {
    if (kind === "note") {
      // Quick/default note creation auto-increments on collision so tapping
      // "Neu" repeatedly yields "Neue Notiz", "Neue Notiz 2", … without error.
      try {
        const path = await createNoteUnique(
          name,
          parentPath,
          (title) => `# ${title}\n\n`,
        );
        await refreshTree();
        void open(path);
      } catch (e) {
        alert(e instanceof Error ? e.message : "Anlegen fehlgeschlagen");
      }
      return;
    }

    const clean = safeName(name);
    if (!clean) return;
    const path = parentPath ? `${parentPath}/${clean}` : clean;
    try {
      await api.createFolder(path);
      await refreshTree();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Anlegen fehlgeschlagen");
    }
  }

  /**
   * Insert a reviewed voice transcript (from VoiceReviewSheet) into a note.
   *
   * This REPLACES the old live-into-editor flow. There is no streaming, no
   * `setActive({...null})` race: we read the current active note off the ref
   * (null-guarded), splice the finished text at the end of its body, and route
   * it through the SAME dirty/debounce save pipeline every other edit uses.
   *
   * Two cases:
   *   1. A note is open → append the transcript (separated by a blank line)
   *      and arm the standard save debounce. The editor's body-watcher picks
   *      up the new body like any other programmatic edit.
   *   2. No note is open → create a fresh note under 30_captures/voice/ with
   *      the transcript as its body (createNote generates SPEC-valid
   *      frontmatter), then open it.
   *
   * Throws on failure so the sheet can surface the message inline.
   */
  async function handleVoiceInsert(
    transcript: string,
    opts?: { folderPath?: string; title?: string },
  ): Promise<void> {
    const text = transcript.trim();
    if (!text) throw new Error("Transkript ist leer.");

    const cur = activeRef.current;
    if (cur) {
      // Null-guarded splice into the open note. NEVER spread a null `active`.
      const sep = cur.body.endsWith("\n\n")
        ? ""
        : cur.body.endsWith("\n")
          ? "\n"
          : cur.body === ""
            ? ""
            : "\n\n";
      const newBody = cur.body + sep + text + "\n";
      dirtyBody.current = newBody;
      setActive({ ...cur, body: newBody });
      setDirty(newBody !== savedBodyRef.current);
      if (syncRef.current !== "saving") setSync("dirty");
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        void flush();
      }, SAVE_DEBOUNCE_MS);
      // Flush immediately so the captured text reaches Forgejo without the
      // 5s wait — voice capture is a "commit it now" intent.
      await flushNow();
      return;
    }

    // No note open — create a fresh capture-style note and open it.
    // The folder + title come from the VoiceReviewSheet picker; both fall back
    // to the historical defaults when omitted. A user-typed title drives the
    // filename + `# heading`; an empty title uses the timestamped voice name.
    // Two voice captures inside the same minute derive the same filename;
    // route through `createNoteUnique` so the second one becomes
    // "…-voice-1830 2" instead of erroring out. The body is the transcript,
    // prefixed with an H1 only when the user supplied an explicit title.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
    const fallbackName = `${date}-voice-${time}`;

    const folderPath = opts?.folderPath?.trim() || "30_captures/voice";
    const userTitle = opts?.title?.trim();

    // A manual title ALWAYS wins. Only when the user typed none AND the
    // opt-in `aiTitle` setting is on do we ask the configured LLM for a
    // concise title from the transcript. Any failure (no provider, network,
    // empty result) is swallowed and we fall back to the timestamped name —
    // title generation must NEVER block note creation.
    let aiTitle: string | undefined;
    if (!userTitle && voiceAiTitleRef.current) {
      try {
        const suggested = await api.suggestVoiceTitle(text);
        if (suggested) aiTitle = suggested;
      } catch {
        // graceful fallback to the timestamped name below
      }
    }

    // A generated title is treated like a user title for body/heading
    // purposes (leads with an H1). The timestamped fallback keeps the
    // historical body-only capture shape.
    const explicitTitle = userTitle || aiTitle;
    const baseName = explicitTitle || fallbackName;

    const createdPath = await createNoteUnique(
      baseName,
      folderPath,
      // When there's an explicit title (manual or AI), lead the body with
      // the (possibly collision-suffixed) title as an H1 so the heading
      // matches the file. Without one, keep the body-only capture shape.
      (title) => (explicitTitle ? `# ${title}\n\n${text}\n` : `${text}\n`),
    );
    await refreshTree();
    await open(createdPath);
  }

  async function handleRename(node: TreeNode, newName: string) {
    const clean = safeName(newName);
    if (!clean) return;
    const parent = parentOf(node.path);
    const to = parent ? `${parent}/${clean}` : clean;
    if (to === node.path) return;
    try {
      await api.move(node.path, to, node.type);
      remapActive(node.path, to, node.type);
      await refreshTree();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Umbenennen fehlgeschlagen");
    }
  }

  async function handleMove(node: TreeNode, targetFolderPath: string) {
    const base = node.path.split("/").pop()!;
    const to = targetFolderPath ? `${targetFolderPath}/${base}` : base;
    if (to === node.path) return;
    try {
      await api.move(node.path, to, node.type);
      remapActive(node.path, to, node.type);
      await refreshTree();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Verschieben fehlgeschlagen");
    }
  }

  async function handleDelete(node: TreeNode) {
    try {
      await api.remove(node.path, node.type);
      const cur = activeRef.current;
      if (
        cur &&
        (cur.id === node.path || cur.id.startsWith(node.path + "/"))
      ) {
        setActive(null);
      }
      // Tabs der gelöschten Notiz / aller Kinder-Notizen eines Ordners
      // ebenfalls schließen — sonst zeigt der Tab eine 404-Phantomakte.
      setOpenTabs((prev) =>
        prev.filter(
          (t) => t.id !== node.path && !t.id.startsWith(node.path + "/"),
        ),
      );
      await refreshTree();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Löschen fehlgeschlagen");
    }
  }

  /**
   * Story: Real "Notiz löschen" from the note view (mobile sheet + desktop
   * header), distinct from Forget. Hard-deletes the CURRENTLY OPEN note via
   * the SAME path as the FileTree delete — `api.remove(id, "note")` followed
   * by the identical active-note + tab cleanup `handleDelete` performs (close
   * the editor, drop any open tab, refresh the tree).
   *
   * The open note's `id` IS its path without `.md` — exactly the value
   * FileTree passes as `node.path` — so the cleanup conditions below mirror
   * `handleDelete` one-to-one (including closing child-note tabs, harmless
   * for a single note but kept identical for a single source of truth).
   *
   * Unlike `handleDelete` (which `alert()`s for the FileTree flow), this
   * REJECTS on failure so the calling control (NoteHeader / NoteActionsSheet)
   * can surface the git / pre-commit error message INLINE rather than in a
   * blocking browser dialog. Mirrors the `onPolish` Promise contract.
   */
  async function handleDeleteOpenNote(targetNoteId: string): Promise<void> {
    await api.remove(targetNoteId, "note");
    const cur = activeRef.current;
    if (
      cur &&
      (cur.id === targetNoteId || cur.id.startsWith(targetNoteId + "/"))
    ) {
      setActive(null);
    }
    setOpenTabs((prev) =>
      prev.filter(
        (t) => t.id !== targetNoteId && !t.id.startsWith(targetNoteId + "/"),
      ),
    );
    await refreshTree();
  }

  const status = SYNC_LABEL[sync];

  if (settingsOpen) {
    return (
      <Settings
        onClose={() => setSettingsOpen(false)}
        onOpenNote={(id) => void openNoteById(id)}
      />
    );
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: C.bg,
        color: C.text,
        fontFamily: FONT.ui,
      }}
    >
      {/* Topbar */}
      <header
        style={{
          // Phase D Wave D1 — taller header on mobile so each tap target
          // can hit the 44px Apple-HIG / WCAG 2.5.5 minimum without the
          // chevrons being clipped.
          height: isMobile ? 52 : 44,
          display: "flex",
          alignItems: "center",
          gap: isMobile ? 6 : 10,
          // Allow header to scroll horizontally on tablets if a user has
          // enough buttons that they'd overflow — no clipping mid-button.
          padding: isMobile ? "0 8px" : "0 14px",
          background: C.panel,
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {/* Mobile: hamburger opens the sidebar drawer. Desktop: not needed
            because the aside is always visible. */}
        {isMobile && (
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label={sidebarOpen ? "Sidebar schließen" : "Sidebar öffnen"}
            title="Vault"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: TOUCH_TARGET_MIN,
              height: TOUCH_TARGET_MIN,
              background: C.elevated,
              border: `1px solid ${C.border}`,
              borderRadius: 7,
              cursor: "pointer",
              color: C.text,
              flexShrink: 0,
            }}
          >
            <MenuIcon size={22} style={{ color: C.accent }} />
          </button>
        )}
        <img
          src="/logo-header.png"
          alt="Lokyy Brain"
          style={{
            height: isMobile ? 36 : 44,
            width: "auto",
            verticalAlign: "middle",
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1 }} />
        {/* Daily-note + the full Voice-Quick-Capture recorder stay on desktop.
            On mobile the BottomNav "Voice" tab opens the new editable Voice
            Review-Sheet instead, and Daily-note moves into the "⋮" app-menu.

            CRASH FIX (story C): the old live-into-editor wiring
            (onLiveEditorRequested → setLiveTargetNoteId + handleLiveVoiceAppend
            → setActive({...}) race) is REMOVED. VoiceQuickButton no longer
            receives any onLiveEditor* callbacks, so VoiceRecorder hides its
            editor/open-note live targets entirely and only offers the safe
            capture-note path. Nothing streams into the open CM6 doc anymore;
            the review-sheet is the sole voice→note path. */}
        {!isMobile && (
          <>
            <DailyNoteButton onOpenNote={(id) => void openNoteById(id)} />
            <VoiceQuickButton
              onImported={(id) => {
                void refreshTree().then(() => open(id));
              }}
              isMobile={isMobile}
            />
          </>
        )}
        {/* Phase D Wave D1 — non-essential text buttons (Vorlagen, Review,
            Import) are dropped on mobile to keep the toolbar from
            horizontal-scrolling. They remain reachable via Settings + the
            slide-over panels are unchanged; the future mobile FAB story
            promotes the most-used "Capture" affordance. */}
        {!isMobile && (
          <>
            <button
              onClick={() => setTemplatePickerOpen(true)}
              title="Aus Vorlage anlegen"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: C.elevated,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                padding: "5px 10px",
                cursor: "pointer",
                color: C.text,
                fontSize: 13,
                fontFamily: FONT.ui,
                minHeight: 36,
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 20, lineHeight: 1 }}>📄</span>
              Vorlagen
            </button>
            <button
              onClick={() => setAgentReviewOpen(true)}
              title="Agent-Review"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: C.elevated,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                padding: "5px 10px",
                cursor: "pointer",
                color: C.text,
                fontSize: 13,
                fontFamily: FONT.ui,
                position: "relative",
                minHeight: 36,
              }}
            >
              <Bot size={18} style={{ color: C.accent }} />
              Review
              {pendingCount > 0 && (
                <span
                  style={{
                    background: C.accent,
                    color: "#1a1110",
                    borderRadius: 10,
                    padding: "0 6px",
                    fontSize: 10.5,
                    fontWeight: 700,
                    fontFamily: FONT.mono,
                    minWidth: 16,
                    textAlign: "center",
                    lineHeight: 1.6,
                  }}
                >
                  {pendingCount > 99 ? "99+" : pendingCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setImportOpen(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: C.elevated,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                padding: "5px 10px",
                cursor: "pointer",
                color: C.text,
                fontSize: 13,
                fontFamily: FONT.ui,
                minHeight: 36,
              }}
            >
              <ArrowUpRight size={20} style={{ color: C.accent }} />
              Import
            </button>
          </>
        )}
        <button
          onClick={() => setPaletteOpen(true)}
          title="Suche · Cmd/Ctrl+K"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 7,
            padding: isMobile ? "0" : "5px 10px",
            width: isMobile ? TOUCH_TARGET_MIN : undefined,
            height: isMobile ? TOUCH_TARGET_MIN : undefined,
            justifyContent: isMobile ? "center" : undefined,
            cursor: "pointer",
            color: C.text,
            fontSize: 13,
            fontFamily: FONT.ui,
            minHeight: 36,
            flexShrink: 0,
          }}
        >
          <SearchIcon size={20} style={{ color: C.accent }} />
          {!isMobile && (
            <>
              Suche
              <kbd style={{ fontSize: 10, color: C.textDim, marginLeft: 4, padding: "1px 4px", background: C.bg, borderRadius: 3, fontFamily: FONT.mono }}>
                ⌘K
              </kbd>
            </>
          )}
        </button>
        {!isMobile && (
          <button
            onClick={() => setGraphOpen(true)}
            title="Wissensgraph"
            style={{
              display: "flex",
              alignItems: "center",
              background: C.elevated,
              border: `1px solid ${C.border}`,
              borderRadius: 7,
              padding: "6px 9px",
              cursor: "pointer",
              color: C.text,
              minHeight: 36,
            }}
          >
            <NetworkIcon size={20} style={{ color: C.accent }} />
          </button>
        )}
        <button
          onClick={() => setSettingsOpen(true)}
          title="Einstellungen"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 7,
            padding: isMobile ? "0" : "6px 9px",
            width: isMobile ? TOUCH_TARGET_MIN : undefined,
            height: isMobile ? TOUCH_TARGET_MIN : undefined,
            cursor: "pointer",
            color: C.text,
            minHeight: 36,
            flexShrink: 0,
          }}
        >
          <SettingsIcon size={20} style={{ color: C.accent }} />
        </button>
        {/* Phase D Wave D1 — sync status text is informational and hidden
            on narrow viewports. The status colour-dot is still represented
            through the saving/conflict notifications elsewhere. */}
        {!isMobile && (
          <span
            style={{
              fontSize: 11,
              fontFamily: FONT.mono,
              color: status.color,
            }}
          >
            ● forgejo · {status.text}
          </span>
        )}
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        {/* Mobile drawer backdrop. Sits behind the aside, tap-to-close. */}
        {isMobile && sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
            style={{
              position: "fixed",
              inset: 0,
              top: 52, // below the mobile header
              background: "rgba(0,0,0,0.55)",
              zIndex: 38,
            }}
          />
        )}
        {/* Epic 11 — Workspace-Sidebar-Rail (Story 11.3), desktop-only. Schmale
            navigierbare Menüleiste (System- + Custom-Punkte). Auswahl setzt den
            aktiven Menüpunkt (App = Quelle der Wahrheit), das Zahnrad öffnet den
            MenuEditor (Story 11.2). Auf Mobile bleibt der bestehende
            Hamburger-Drawer (FileTree) die Navigation. */}
        {!isMobile && (
          <Sidebar
            // Remount nach Editor-Close, damit die Rail ihr Menü neu fetcht
            // (sie lädt nur beim Mount; menuReloadKey forciert den Refetch).
            key={menuReloadKey}
            activeItemId={activeMenuItem?.id ?? null}
            onSelectItem={(item) => setActiveMenuItem(item)}
            onOpenEditor={() => setMenuEditorOpen(true)}
          />
        )}
        {/* Datei-Baum + Tag-Pane.
            On desktop: always-visible static aside.
            On mobile: fixed slide-over drawer behind a hamburger button.
            The drawer state is controlled by `sidebarOpen`; opening a note
            auto-closes it (see `openAndCloseDrawer`). */}
        <aside
          style={
            isMobile
              ? {
                  position: "fixed",
                  top: 52,
                  bottom: 0,
                  left: 0,
                  width: "min(320px, 85vw)",
                  background: C.panel,
                  borderRight: `1px solid ${C.border}`,
                  transform: sidebarOpen ? "translateX(0)" : "translateX(-105%)",
                  transition: "transform 0.22s ease",
                  zIndex: 39,
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  boxShadow: sidebarOpen ? "0 10px 30px rgba(0,0,0,0.5)" : "none",
                }
              : {
                  width: filetreeWidth,
                  background: C.panel,
                  flexShrink: 0,
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                }
          }
        >
          {/* Mobile drawer header — close affordance + label. */}
          {isMobile && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "6px 10px",
                borderBottom: `1px solid ${C.border}`,
                minHeight: TOUCH_TARGET_MIN,
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: C.gold,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                Vault
              </span>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                aria-label="Sidebar schließen"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: TOUCH_TARGET_MIN,
                  height: TOUCH_TARGET_MIN,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: C.textDim,
                }}
              >
                <XIcon size={22} />
              </button>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 8px" }}>
            {/* Epic 11: Auf Desktop rendert das Navigations-Panel die per
                Workspace-Menü gewählte View (resolveView(item.viewType)) — für
                den Default-/Tree-Punkt ist das die bestehende FileTree-Logik
                (TreeView umhüllt FileTree). Auf Mobile bleibt der direkte
                FileTree-Drawer unverändert (die Sidebar-Rail ist desktop-only).
                Beim Notiz-Öffnen aus der View läuft alles über open() — die
                bestehende Editor-/Tab-/Graph-Funktionalität bleibt intakt. */}
            {!isMobile && activeMenuItem ? (
              <Suspense fallback={null}>
                {(() => {
                  const View = resolveView(activeMenuItem.viewType);
                  return (
                    <View
                      item={activeMenuItem}
                      onOpenNote={(id) => void open(id)}
                    />
                  );
                })()}
              </Suspense>
            ) : (
              <FileTree
                ref={fileTreeRef}
                tree={tree}
                activeId={active?.id ?? null}
                onOpen={openAndCloseDrawer}
                onCreate={handleCreate}
                onRename={handleRename}
                onMove={handleMove}
                onDelete={handleDelete}
                tagFilteredNoteIds={tagFilteredNoteIds}
              />
            )}
          </div>
          <div
            style={{
              flexShrink: 0,
              maxHeight: "40%",
              overflowY: "auto",
              borderTop: `1px solid ${C.border}`,
              padding: "8px",
            }}
          >
            <TagPane
              activeTag={tagFilter}
              onSelectTag={setTagFilter}
              refreshKey={backlinksRefresh}
              compact={isMobile}
            />
          </div>
        </aside>
        {/* Resizable drag handle: desktop only — touch dragging a thin
            handle on mobile is hostile UX. */}
        {!isMobile && (
          <DragHandle
            side="left"
            getWidth={() => filetreeWidth}
            setWidth={setFiletreeWidth}
            onReset={() => setFiletreeWidth(248)}
          />
        )}

        {/* Editor + Tabs + Backlinks */}
        <main
          style={{
            flex: 1,
            minWidth: 0,
            background: C.bg,
            display: "flex",
            flexDirection: "column",
            // Mobile: clear the fixed BottomNav (≈56px tab + home-indicator
            // safe-area) so it never overlaps the editor / backlinks footer.
            paddingBottom: isMobile
              ? "calc(56px + env(safe-area-inset-bottom, 0px))"
              : undefined,
          }}
        >
          <Tabs
            tabs={openTabs}
            activeId={active?.id ?? null}
            onActivate={(id) => void openNoteById(id)}
            onClose={closeTab}
          />
          {active ? (
            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <NoteHeader
                  noteId={active.id}
                  title={active.title || active.id}
                  body={active.body}
                  onForget={(id) => void handleForget(id)}
                  onUnforget={(id) => void handleUnforget(id)}
                  onDeleteNote={handleDeleteOpenNote}
                  syncState={sync}
                  lastSavedAt={lastSavedAt}
                  errorMsg={errorMsg}
                  onManualSave={() => void manualSave()}
                  isDirty={dirty}
                  onSync={() => void handleSync()}
                  syncing={syncing}
                  onDismissError={() => {
                    setErrorMsg(null);
                    if (sync === "error") setSync("dirty");
                  }}
                  onPolish={handlePolish}
                  onPolishUndo={handlePolishUndo}
                  onFolderJump={(p) => fileTreeRef.current?.jumpToFolder(p)}
                />
                {pendingServerBody && (
                  <ServerConflictBanner
                    onAcceptServer={acceptServerVersion}
                    onKeepLocal={keepLocalVersion}
                  />
                )}
                <PropertiesPanel
                  body={active.body}
                  onUpdateBody={handleUpdateBody}
                  expanded={propsExpanded}
                  onToggle={() => setPropsExpanded((v) => !v)}
                />
                <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                  <SplitView
                    primaryNoteId={active.id}
                    primaryBody={active.body}
                    onPrimaryChange={onChange}
                    onOpenLink={onOpenLink}
                    secondaryNoteId={secondaryNoteId}
                    onClosePane={() => setSecondaryNoteId(null)}
                    onSecondaryOpen={onOpenLinkSplit}
                    primaryScrollToLine={scrollToLine}
                    primaryEditorRef={editorRef}
                  />
                </div>
                <BacklinksPanel
                  noteId={active.id}
                  onOpenNote={openNoteById}
                  refreshSignal={backlinksRefresh}
                />
              </div>
              {/* Outline + drag handle — desktop only. The outline is a
                  navigation aid that's redundant with full-screen scroll on
                  mobile and would otherwise eat ~200px of editor width. */}
              {!isMobile && (
                <>
                  <DragHandle
                    side="right"
                    getWidth={() => outlineWidth}
                    setWidth={setOutlineWidth}
                    onReset={() => setOutlineWidth(220)}
                  />
                  <div style={{ width: outlineWidth, flexShrink: 0, display: "flex" }}>
                    <Outline body={active.body} onJump={(line) => setScrollToLine(line)} />
                  </div>
                </>
              )}
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 32,
                pointerEvents: "none",
              }}
            >
              <img
                src="/logo-large.png"
                alt=""
                style={{
                  maxWidth: "45%",
                  maxHeight: "55%",
                  opacity: 0.08,
                  userSelect: "none",
                }}
              />
              <span
                style={{
                  color: C.textFaint,
                  fontFamily: FONT.mono,
                  fontSize: 12,
                  opacity: 0.6,
                }}
              >
                notiz aus dem datei-baum wählen — oder Cmd/Ctrl+K für Such-Palette
              </span>
            </div>
          )}
        </main>
      </div>

      {/* Command Palette (Cmd/Ctrl+K) */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenNote={(id) => void openNoteById(id)}
        onNewNote={() => {
          // FileTree handles UI; just close palette and focus root
          refreshTree();
        }}
      />

      {/* Quick Switcher (Cmd/Ctrl+O) */}
      <QuickSwitcher
        open={quickSwitcherOpen}
        onClose={() => setQuickSwitcherOpen(false)}
        onOpenNote={(id) => {
          setQuickSwitcherOpen(false);
          void openNoteById(id);
        }}
      />

      {/* Template Picker (📄 Vorlagen Toolbar-Button) */}
      <TemplatePicker
        open={templatePickerOpen}
        onClose={() => setTemplatePickerOpen(false)}
        currentUser={currentUser}
        defaultFolder={defaultImportFolder || undefined}
        onCreate={async (path, body) => {
          const r = await api.createNote(path, body);
          await refreshTree();
          await open(r.id);
          setBacklinksRefresh((n) => n + 1);
        }}
      />

      {/* Wissensgraph (Vollbild-Overlay, Esc oder Close-Button) */}
      {graphOpen && (
        <Suspense fallback={null}>
          <GraphView
            onClose={() => setGraphOpen(false)}
            onOpenNote={(id) => {
              setGraphOpen(false);
              void openNoteById(id);
            }}
          />
        </Suspense>
      )}


      {/* Import-Panel (Slide-over) */}
      <ImportPanel
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(id) => {
          void refreshTree().then(() => open(id));
        }}
      />

      {/* Agent-Review Panel (🤖 Review Toolbar-Button, Phase C Wave C3) */}
      <AgentReviewPanel
        open={agentReviewOpen}
        onClose={() => setAgentReviewOpen(false)}
        onOpenNote={(id) => {
          setAgentReviewOpen(false);
          void openNoteById(id);
        }}
        onCountChange={setPendingCount}
      />

      {/* Workspace-Menü-Editor (Zahnrad in der Sidebar-Rail, Story 11.2).
          Lädt Menü + Vault-Baum selbst und speichert über api.putMenu. Beim
          Schließen bumpen wir menuReloadKey, damit die Default-Auflösung in
          App neu läuft (umbenannte/gelöschte Punkte synchron halten); die
          Sidebar-Rail fetcht ihr Menü beim nächsten Mount/Re-render selbst. */}
      {menuEditorOpen && (
        <MenuEditor
          onClose={() => {
            setMenuEditorOpen(false);
            setMenuReloadKey((n) => n + 1);
          }}
        />
      )}

      {/* Mobile bottom tab bar — Story: Mobile Shell. Gated to mobile so the
          desktop layout is untouched. Each tab is a thin callback into the
          existing App handlers; Sync mirrors the live save/sync lifecycle. */}
      {isMobile && (
        <BottomNav
          onDrawer={() => setSidebarOpen((o) => !o)}
          onSearch={() => setPaletteOpen(true)}
          onNew={() => void handleCreate("", "Neue Notiz", "note")}
          onVoice={() => setVoiceReviewOpen(true)}
          onSync={() => void handleSync()}
          syncState={sync}
          syncing={syncing}
          drawerOpen={sidebarOpen}
        />
      )}

      {/* Voice Review-Sheet — record → editable transcript → insert. Routes
          through handleVoiceInsert (null-guarded; no live-editor crash path). */}
      <VoiceReviewSheet
        open={voiceReviewOpen}
        onClose={() => setVoiceReviewOpen(false)}
        onInsert={handleVoiceInsert}
        targetTitle={active ? active.title || active.id : null}
        folders={folderPaths}
      />
    </div>
  );
}

/**
 * Non-modal banner that appears between NoteHeader and PropertiesPanel
 * when a focus-pull discovered the server has a newer body but the editor
 * has unsaved local changes. The user must explicitly choose: keep editing
 * the local version (banner dismisses) or discard local and load the
 * server version. We deliberately don't auto-resolve — both branches lose
 * data, and the user is the only one who knows which loss is acceptable.
 */
function ServerConflictBanner({
  onAcceptServer,
  onKeepLocal,
}: {
  onAcceptServer: () => void;
  onKeepLocal: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        background: "rgba(255, 169, 77, 0.12)",
        borderBottom: `1px solid ${C.gold}`,
        fontSize: 12,
        fontFamily: FONT.ui,
        color: C.text,
        flexShrink: 0,
      }}
      role="alert"
    >
      <span style={{ flex: 1 }}>
        ⚠ Server-Version unterscheidet sich von deiner lokalen Bearbeitung.
      </span>
      <button
        type="button"
        onClick={onAcceptServer}
        style={{
          background: C.elevated,
          border: `1px solid ${C.border}`,
          borderRadius: 5,
          padding: "4px 10px",
          color: C.text,
          fontSize: 12,
          cursor: "pointer",
          fontFamily: FONT.ui,
        }}
      >
        Server-Version laden
      </button>
      <button
        type="button"
        onClick={onKeepLocal}
        style={{
          background: "transparent",
          border: `1px solid ${C.border}`,
          borderRadius: 5,
          padding: "4px 10px",
          color: C.textDim,
          fontSize: 12,
          cursor: "pointer",
          fontFamily: FONT.ui,
        }}
      >
        Lokal weiterbearbeiten
      </button>
    </div>
  );
}
