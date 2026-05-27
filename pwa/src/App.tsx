import { lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
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
import { api, ApiError } from "./api.js";
import { SplitView } from "./SplitView.js";
import { prefetchTags } from "./editor/tagAutocomplete.js";
import { FileTree } from "./FileTree.js";
import { ImportPanel } from "./ImportPanel.js";
import { TagPane } from "./TagPane.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { NoteHeader } from "./NoteHeader.js";
import { QuickSwitcher } from "./QuickSwitcher.js";
import { DailyNoteButton } from "./DailyNoteButton.js";
import { TemplatePicker } from "./TemplatePicker.js";
import { VoiceQuickButton } from "./VoiceQuickButton.js";
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

/** Notiz-Titel (H1/Dateiname) flach aus dem Baum — für Wikilink-Auflösung. */
function flattenNotes(nodes: TreeNode[]): { name: string; id: string }[] {
  const out: { name: string; id: string }[] = [];
  for (const n of nodes) {
    if (n.type === "note") out.push({ name: n.name, id: n.path });
    else out.push(...flattenNotes(n.children));
  }
  return out;
}

export function App() {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [active, setActive] = useState<Note | null>(null);
  const [sync, setSync] = useState<SyncState>("idle");
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
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

  // Save-lifecycle tracking — surfaced to NoteHeader for the badge UI.
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
      savedBodyRef.current = saved.body;
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
    if (syncRef.current !== "saving") setSync("dirty");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void flush();
    }, PROPS_DEBOUNCE_MS);
  }

  /**
   * Live-voice append. The VoiceQuickButton's "Live in neuen Editor
   * schreiben" mode pushes each finalized speech segment here. We append
   * to the LIVE-TARGET note (not necessarily the currently-active note)
   * so a tab switch mid-recording doesn't accidentally inject speech into
   * an unrelated note.
   *
   * Two append paths:
   *   1. Target IS active — use the existing setActive + dirty flow. The
   *      Editor's initialBody-watcher effect picks up the new body and
   *      preserves cursor/scroll (see Editor.tsx case 2). The 5s
   *      auto-save debounce persists it normally.
   *   2. Target is NOT active — silently mutate the in-memory tab cache
   *      we don't have, so we fall back to a direct PUT. That's an
   *      acceptable cost: the user already wandered off, and the warning
   *      chip in the recorder tells them what's happening.
   *
   * Marker hygiene: any tail-interim zone (U+200E LRM anchor + italic
   * wrap) is stripped BEFORE the final segment lands, so leftover ghost
   * text never persists into the saved note body. This is the second
   * strip site (the first lives in `handleLiveVoiceReplaceTail`); both
   * exist as defense-in-depth — a missed interim cleanup elsewhere still
   * gets wiped here.
   */
  function handleLiveVoiceAppend(segment: string) {
    const trimmed = segment.trim();
    if (!trimmed) return;
    const targetId = liveTargetNoteIdRef.current;
    if (!targetId) return;

    const cur = activeRef.current;
    if (cur && cur.id === targetId) {
      // Strip any U+200E LRM interim zone before appending the final.
      // Pattern: LRM and everything after it through end-of-doc.
      const stripped = cur.body.replace(/‎[\s\S]*$/, "").replace(/[ \t]+$/m, "");
      // Same paragraph separator policy as the recorder's capture mode:
      // segments are individual sentences, so a single newline keeps them
      // readable without ballooning the doc. End-of-doc anchor matches
      // the spec ("intentional — user can clean up after").
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

    // Off-target: append directly via API. Fire-and-forget; errors are
    // swallowed because the recorder is already showing the off-target
    // warning chip and a per-segment alert would be noise.
    void (async () => {
      try {
        const note = await api.getNote(targetId);
        // Same marker-strip defense as the on-target path. The off-target
        // note may still carry a stale interim zone from the last
        // replaceTail before the user switched tabs.
        const stripped = note.body.replace(/‎[\s\S]*$/, "").replace(/[ \t]+$/m, "");
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

    // Strip from LRM marker to end-of-doc. If no marker present this is
    // a no-op on the strip side, so the function also covers "first
    // interim of a session" — just appends text at end of doc.
    const stripped = cur.body
      .replace(/‎[\s\S]*$/, "")
      .replace(/[ \t]+$/m, "");
    // For non-empty text: keep one separating space so the marker doesn't
    // bleed into the last word of the permanent text. For empty text
    // (caller wants strip-only), no separator.
    const sep =
      text === ""
        ? ""
        : stripped === "" || stripped.endsWith("\n") || stripped.endsWith(" ")
          ? ""
          : " ";
    const displayBody = stripped + sep + text;
    // No-op short-circuit — avoids a CM6 doc-swap on identical interim
    // text (the recognizer occasionally re-emits the same string while
    // it waits for the confidence window to close). Costs one string
    // compare, saves one full-doc dispatch + reparse cycle.
    if (displayBody === cur.body) return;
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
      setBacklinksRefresh((n) => n + 1);
    } catch (err) {
      console.error("unforgetNote failed", err);
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

  async function handleCreate(
    parentPath: string,
    name: string,
    kind: "note" | "folder",
  ) {
    const clean = safeName(name);
    if (!clean) return;
    const path = parentPath ? `${parentPath}/${clean}` : clean;
    try {
      if (kind === "note") {
        await api.createNote(path, `# ${name}\n\n`);
        await refreshTree();
        void open(path);
      } else {
        await api.createFolder(path);
        await refreshTree();
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Anlegen fehlgeschlagen");
    }
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

  const status = SYNC_LABEL[sync];

  if (settingsOpen) {
    return <Settings onClose={() => setSettingsOpen(false)} />;
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
        <DailyNoteButton onOpenNote={(id) => void openNoteById(id)} />
        {/* Voice-Quick-Capture — first-class one-click recording. Visible on
            mobile too: voice is the most mobile-friendly capture mode and
            the spec wants this prominent. The full recorder with mode-
            switch + audio preview still lives in the ImportPanel for power
            users. */}
        <VoiceQuickButton
          onImported={(id) => {
            void refreshTree().then(() => open(id));
          }}
          onLiveEditorRequested={(noteId) => {
            // Track the recording target so subsequent appends find the
            // right note even if the user switches tabs.
            setLiveTargetNoteId(noteId);
            void refreshTree().then(() => open(noteId));
          }}
          onLiveEditorAppend={handleLiveVoiceAppend}
          onLiveEditorReplaceTail={handleLiveVoiceReplaceTail}
          onLiveEditorStopped={() => {
            // Flush any pending debounced save right away so the final
            // segment lands in Forgejo without waiting 5s. Clear the
            // target so future live recordings don't inherit it.
            void flushNow();
            setLiveTargetNoteId(null);
          }}
          liveEditorOffTarget={
            liveTargetNoteId !== null && active?.id !== liveTargetNoteId
          }
          isMobile={isMobile}
        />
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
            <FileTree
              tree={tree}
              activeId={active?.id ?? null}
              onOpen={openAndCloseDrawer}
              onCreate={handleCreate}
              onRename={handleRename}
              onMove={handleMove}
              onDelete={handleDelete}
              tagFilteredNoteIds={tagFilteredNoteIds}
            />
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
        <main style={{ flex: 1, minWidth: 0, background: C.bg, display: "flex", flexDirection: "column" }}>
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
                  syncState={sync}
                  lastSavedAt={lastSavedAt}
                  errorMsg={errorMsg}
                  onManualSave={() => void manualSave()}
                  onDismissError={() => {
                    setErrorMsg(null);
                    if (sync === "error") setSync("dirty");
                  }}
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
