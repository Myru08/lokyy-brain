import { lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import type { Note, TreeNode } from "@lokyy/shared";
import { ArrowUpRight, Settings as SettingsIcon, Search as SearchIcon, Network as NetworkIcon } from "lucide-react";
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

type SyncState = "idle" | "saving" | "saved" | "conflict" | "error";

const SYNC_LABEL: Record<SyncState, { text: string; color: string }> = {
  idle: { text: "synchron", color: C.ok },
  saving: { text: "speichert…", color: C.gold },
  saved: { text: "gespeichert · gepusht", color: C.ok },
  conflict: { text: "konflikt — bitte neu laden", color: C.err },
  error: { text: "fehler beim speichern", color: C.err },
};

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

  const saveTimer = useRef<number | null>(null);
  const dirtyBody = useRef<string>("");
  const activeRef = useRef<Note | null>(null);
  activeRef.current = active;

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
    try {
      const note = await api.getNote(id);
      if (note) {
        setActive(note);
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

  async function flush() {
    const note = activeRef.current;
    if (!note) return;
    const body = dirtyBody.current;
    if (!body || body === note.body) {
      setSync("idle");
      return;
    }
    setSync("saving");
    try {
      const saved = await api.putNote(note.id, body);
      setActive(saved);
      setSync("saved");
      setBacklinksRefresh((n) => n + 1);
    } catch (e) {
      setSync(e instanceof ApiError && e.isConflict ? "conflict" : "error");
    }
  }

  async function open(id: string) {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      await flush();
    }
    try {
      const note = await api.getNote(id);
      dirtyBody.current = note.body;
      setActive(note);
      setSync("idle");
    } catch (e) {
      console.error(e);
      setSync("error");
    }
  }

  function onChange(body: string) {
    dirtyBody.current = body;
    setSync("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void flush();
    }, 1200);
  }

  /**
   * Wird vom PropertiesPanel aufgerufen, wenn Frontmatter-Felder editiert
   * wurden. Der Panel liefert den vollen neuen Markdown-Body inkl.
   * Frontmatter. Wir aktualisieren active.body (Editor re-syncen seine Doc
   * via dem initialBody-Effect) und triggern das normale Save-Debounce.
   */
  function handleUpdateBody(newBody: string) {
    const cur = activeRef.current;
    if (!cur) return;
    dirtyBody.current = newBody;
    setActive({ ...cur, body: newBody });
    setSync("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void flush();
    }, 600);
  }

  function onOpenLink(target: string) {
    const hit = flattenNotes(tree).find(
      (n) => n.name.toLowerCase() === target.toLowerCase() || n.id === target,
    );
    if (hit) void open(hit.id);
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

  // Fenster wieder aktiv -> offene Notiz neu laden (Server pullt)
  useEffect(() => {
    function onFocus() {
      const note = activeRef.current;
      if (!note || saveTimer.current) return;
      api
        .getNote(note.id)
        .then((fresh) => {
          if (fresh.body !== dirtyBody.current) {
            dirtyBody.current = fresh.body;
            setActive(fresh);
          }
        })
        .catch(() => {});
      void refreshTree();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

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
          height: 44,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          background: C.panel,
          borderBottom: `1px solid ${C.border}`,
          flexShrink: 0,
        }}
      >
        <img
          src="/logo-header.png"
          alt="Lokyy Brain"
          style={{ height: 44, width: "auto", verticalAlign: "middle" }}
        />
        <span style={{ flex: 1 }} />
        <DailyNoteButton onOpenNote={(id) => void openNoteById(id)} />
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
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 20, lineHeight: 1 }}>📄</span>
          Vorlagen
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
          }}
        >
          <ArrowUpRight size={20} style={{ color: C.accent }} />
          Import
        </button>
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
            padding: "5px 10px",
            cursor: "pointer",
            color: C.text,
            fontSize: 13,
            fontFamily: FONT.ui,
          }}
        >
          <SearchIcon size={20} style={{ color: C.accent }} />
          Suche
          <kbd style={{ fontSize: 10, color: C.textDim, marginLeft: 4, padding: "1px 4px", background: C.bg, borderRadius: 3, fontFamily: FONT.mono }}>
            ⌘K
          </kbd>
        </button>
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
          }}
        >
          <NetworkIcon size={20} style={{ color: C.accent }} />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          title="Einstellungen"
          style={{
            display: "flex",
            alignItems: "center",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 7,
            padding: "6px 9px",
            cursor: "pointer",
            color: C.text,
          }}
        >
          <SettingsIcon size={20} style={{ color: C.accent }} />
        </button>
        <span
          style={{
            fontSize: 11,
            fontFamily: FONT.mono,
            color: status.color,
          }}
        >
          ● forgejo · {status.text}
        </span>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Datei-Baum + Tag-Pane */}
        <aside
          style={{
            width: filetreeWidth,
            background: C.panel,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 8px" }}>
            <FileTree
              tree={tree}
              activeId={active?.id ?? null}
              onOpen={(id) => void open(id)}
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
        <DragHandle
          side="left"
          getWidth={() => filetreeWidth}
          setWidth={setFiletreeWidth}
          onReset={() => setFiletreeWidth(248)}
        />

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
                />
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
              <DragHandle
                side="right"
                getWidth={() => outlineWidth}
                setWidth={setOutlineWidth}
                onReset={() => setOutlineWidth(220)}
              />
              <div style={{ width: outlineWidth, flexShrink: 0, display: "flex" }}>
                <Outline body={active.body} onJump={(line) => setScrollToLine(line)} />
              </div>
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
    </div>
  );
}
