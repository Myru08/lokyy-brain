import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { autocompletion } from "@codemirror/autocomplete";
import { lokyyTheme, lokyyHighlight } from "./theme.js";
import { livePreview } from "./livePreview.js";
import { wikilinkExtension } from "./wikilink.js";
import { slashSource } from "./slashCommands.js";
import {
  wikilinkSource,
  prefetchWikilinkTargets,
} from "./wikilinkAutocomplete.js";
import { tagSource } from "./tagAutocomplete.js";
import { embedPreviewExtension } from "./embedPreview.js";
import { embedTheme } from "./embedPreview.css.js";
import { mathPreviewExtension, mathTheme } from "./mathPreview.js";
import { mermaidPreviewExtension, mermaidTheme } from "./mermaidPreview.js";
import { dataviewExtension, dataviewTheme } from "./dataviewWidget.js";
import { imagePasteExtension } from "./imagePaste.js";
import { wikilinkHoverExtension, hoverPreviewTheme } from "./hoverPreview.js";

/**
 * Per-note cursor persistence (Story: editor save-lifecycle overhaul).
 *
 * Keyed by ULID (NOT path) so a note rename keeps its cursor history. We
 * store `head` (caret position) + `anchor` (selection start) + `scrollTop`
 * in localStorage and restore on note open. 7-day TTL guards against
 * unbounded growth (~30 bytes/entry, ~30 entries/day → still fine for years,
 * but the TTL is a courtesy for users who use lokyy on a shared device).
 */
const CURSOR_STORAGE_PREFIX = "lokyy:cursor:";
const CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CursorSnapshot {
  anchor: number;
  head: number;
  scrollTop: number;
  /** Epoch-ms — used for TTL pruning. */
  t: number;
}

/** Extract ULID from a YAML frontmatter block. Mirrors NoteHeader's regex. */
function extractUlid(body: string): string | null {
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

function loadCursor(ulid: string): CursorSnapshot | null {
  try {
    const raw = localStorage.getItem(CURSOR_STORAGE_PREFIX + ulid);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CursorSnapshot;
    if (!parsed || typeof parsed.head !== "number") return null;
    if (Date.now() - (parsed.t ?? 0) > CURSOR_TTL_MS) {
      localStorage.removeItem(CURSOR_STORAGE_PREFIX + ulid);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveCursor(ulid: string, snap: Omit<CursorSnapshot, "t">): void {
  try {
    const payload: CursorSnapshot = { ...snap, t: Date.now() };
    localStorage.setItem(CURSOR_STORAGE_PREFIX + ulid, JSON.stringify(payload));
  } catch {
    // localStorage quota / private mode — silently skip; cursor restore is
    // a UX nicety, not a correctness invariant.
  }
}

/**
 * Combined autocomplete — Slash commands + Wikilink targets + Tags in one CM6
 * extension. Sources are tried in order; first non-null wins.
 */
const combinedAutocomplete = autocompletion({
  override: [slashSource, wikilinkSource, tagSource],
  activateOnTyping: true,
  closeOnBlur: true,
  defaultKeymap: true,
  icons: false,
  maxRenderedOptions: 20,
});

/**
 * React-Hülle um die CodeMirror-6-EditorView.
 *
 * Die View wird genau einmal erzeugt. Wechselt die Notiz, wird nur das
 * Dokument ausgetauscht (kein Remount) — so bleiben Scrollposition-Handling
 * und Extensions stabil.
 */

interface EditorProps {
  /** id der aktuell offenen Notiz — Wechsel löst Doc-Austausch aus */
  noteId: string;
  /** Markdown-Inhalt beim Öffnen / nach dem Speichern */
  initialBody: string;
  /** bei jeder Änderung mit dem vollen Doc-Text */
  onChange: (body: string) => void;
  /** Klick auf einen [[Wikilink]] */
  onOpenLink: (target: string) => void;
  /** Cmd/Ctrl+Klick auf einen [[Wikilink]] — Split-View-Open. Optional. */
  onOpenLinkSplit?: (target: string) => void;
  /** Sprung zur Zeile (Outline-Klick). Wird via Custom-Event ans Editor-DOM-Element gesendet. */
  scrollToLine?: number | null;
}

/**
 * Imperative handle exposed to parents via `ref` — used by App.tsx's live-voice
 * pipeline to capture the cursor position at the start of a recording session
 * so transcribed text gets inserted at the user's current cursor instead of
 * being appended to the end of the document.
 *
 * Keep this surface tiny. Adding more methods makes the parent → editor
 * coupling sticky and tempts callers to drive CM6 directly, bypassing the
 * setActive → initialBody-watcher path that owns cursor/scroll preservation.
 */
export interface EditorHandle {
  /**
   * Current caret position (`selection.main.head`) as an offset into the doc.
   * Returns `null` if the view hasn't mounted yet. Callers should clamp to
   * the post-mutation doc length themselves — we don't snapshot anything.
   */
  getCursorPos: () => number | null;
}

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  {
    noteId,
    initialBody,
    onChange,
    onOpenLink,
    onOpenLinkSplit,
    scrollToLine,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      getCursorPos: () => {
        const v = view.current;
        if (!v) return null;
        return v.state.selection.main.head;
      },
    }),
    [],
  );

  // Callbacks in Refs halten, damit die View nicht neu erzeugt werden muss
  const onChangeRef = useRef(onChange);
  const onOpenRef = useRef(onOpenLink);
  const onOpenSplitRef = useRef(onOpenLinkSplit);
  onChangeRef.current = onChange;
  onOpenRef.current = onOpenLink;
  onOpenSplitRef.current = onOpenLinkSplit;

  // Track the ULID of the currently-loaded doc so the body-swap effect
  // knows when the *note identity* changed (vs an external body refresh
  // for the same note). Ref because it's a derived value the effect reads,
  // not state the UI renders.
  const currentUlidRef = useRef<string | null>(null);

  // Note-Liste für Wikilink-Autocomplete prefetchen
  useEffect(() => {
    prefetchWikilinkTargets();
  }, [noteId]);

  // View einmalig aufbauen
  useEffect(() => {
    if (!host.current) return;

    const initialUlid = extractUlid(initialBody);
    currentUlidRef.current = initialUlid;
    const restored = initialUlid ? loadCursor(initialUlid) : null;

    const state = EditorState.create({
      doc: initialBody,
      // Seed the selection from localStorage on mount so the very first
      // render lands the cursor in the right spot — no flash of position 0.
      // We clamp to doc length defensively (file could have shrunk while
      // the user was away).
      selection: restored
        ? EditorSelection.single(
            Math.min(Math.max(0, restored.anchor), initialBody.length),
            Math.min(Math.max(0, restored.head), initialBody.length),
          )
        : undefined,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        lokyyTheme,
        lokyyHighlight,
        combinedAutocomplete,
        livePreview,
        wikilinkExtension(
          (target) => onOpenRef.current(target),
          (target) => {
            const fn = onOpenSplitRef.current;
            if (fn) fn(target);
            else onOpenRef.current(target);
          },
        ),
        // Decoration-Priorität: embed > math > mermaid > dataview > wikilink
        // (most specific first). CM6 layers by extension order — later ones
        // win on conflict, so we put broad/least-specific last.
        embedPreviewExtension, embedTheme,
        mathPreviewExtension, mathTheme,
        mermaidPreviewExtension, mermaidTheme,
        dataviewExtension, dataviewTheme,
        imagePasteExtension,
        wikilinkHoverExtension, hoverPreviewTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          // Persist cursor + scroll on every selection change. Cheap: a
          // single localStorage.setItem with a tiny JSON blob. We debounce
          // implicitly because selection events only fire on user action
          // (not on every keystroke — those fire docChanged).
          if (u.selectionSet || u.docChanged) {
            const ulid = currentUlidRef.current;
            if (ulid) {
              const sel = u.state.selection.main;
              saveCursor(ulid, {
                anchor: sel.anchor,
                head: sel.head,
                scrollTop: u.view.scrollDOM.scrollTop,
              });
            }
          }
        }),
      ],
    });

    const v = new EditorView({ state, parent: host.current });
    view.current = v;

    // Apply the saved scrollTop AFTER the view is attached. CM6 lays out
    // synchronously on attach so reading scrollDOM is safe here.
    if (restored) {
      v.scrollDOM.scrollTop = restored.scrollTop;
    }

    return () => v.destroy();
    // bewusst nur beim Mount — Doc-Wechsel siehe unten
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notizwechsel ODER externe Body-Aktualisierung (z.B. PropertiesPanel,
  // PUT-Response, focus-pull). Drei Fälle:
  //
  //   1. Same doc text → no-op (the toString-Guard). Triggered by every
  //      save round-trip where the server echoed the same body.
  //
  //   2. Same note, different body (PropertiesPanel edited frontmatter,
  //      server normalised on save). PRESERVE cursor + scroll so the user
  //      doesn't lose their place — CM6 silently clamps the selection if
  //      the new doc is shorter, which we handle below.
  //
  //   3. Different note (noteId changed). Persist the OLD note's cursor
  //      before swapping (so it survives the tab switch), then load the
  //      NEW note's cursor from localStorage on the way in.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (v.state.doc.toString() === initialBody) return;

    const newUlid = extractUlid(initialBody);
    const oldUlid = currentUlidRef.current;
    const noteChanged = oldUlid !== newUlid;

    // Capture before replacing — we need the OLD scroll/selection for
    // both branches: case 2 restores it after; case 3 persists it.
    const prevSel = v.state.selection.main;
    const prevScroll = v.scrollDOM.scrollTop;

    if (noteChanged && oldUlid) {
      // Persist the old note's cursor on its way out (user might come
      // back to this note later — we want to land them back at the
      // same line).
      saveCursor(oldUlid, {
        anchor: prevSel.anchor,
        head: prevSel.head,
        scrollTop: prevScroll,
      });
    }

    // Compute the post-swap selection BEFORE dispatching so it lands in
    // the same transaction (avoids a one-frame flash of position 0).
    let nextSelection: ReturnType<typeof EditorSelection.single> | undefined;
    if (noteChanged) {
      const restored = newUlid ? loadCursor(newUlid) : null;
      if (restored) {
        nextSelection = EditorSelection.single(
          Math.min(Math.max(0, restored.anchor), initialBody.length),
          Math.min(Math.max(0, restored.head), initialBody.length),
        );
      }
    } else {
      // Same note, body just got externally rewritten (PropertiesPanel,
      // save round-trip, server-version-load). Clamp the existing
      // selection to the new doc length and KEEP it.
      nextSelection = EditorSelection.single(
        Math.min(prevSel.anchor, initialBody.length),
        Math.min(prevSel.head, initialBody.length),
      );
    }

    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: initialBody },
      selection: nextSelection,
      // Don't auto-scroll-into-view on programmatic doc swaps — we'll
      // restore the scroll position manually below. scrollIntoView would
      // jump the viewport to wherever the selection landed, which is
      // exactly the "scroll jumps" pain point we're fixing.
      scrollIntoView: false,
    });

    // Restore the scroll position. For the same-note case, this is the
    // user's previous scroll. For the different-note case, this is the
    // stored scroll for the new note. requestAnimationFrame defers it
    // by one frame so CM6's measure cycle has finished laying out the
    // new doc — without the rAF the scrollTop is sometimes clamped to 0
    // because CM6 hasn't computed the document height yet.
    let targetScroll = prevScroll;
    if (noteChanged) {
      const restored = newUlid ? loadCursor(newUlid) : null;
      targetScroll = restored?.scrollTop ?? 0;
    }
    requestAnimationFrame(() => {
      // Re-check the view in case the component unmounted in the same tick.
      if (view.current === v) v.scrollDOM.scrollTop = targetScroll;
    });

    currentUlidRef.current = newUlid;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, initialBody]);

  // Sprung zur Zeile (Outline-Click) — caret setzen + scroll-in-view
  useEffect(() => {
    const v = view.current;
    if (!v || scrollToLine == null) return;
    const lineNo = Math.max(1, scrollToLine + 1);
    if (lineNo > v.state.doc.lines) return;
    const line = v.state.doc.line(lineNo);
    v.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 24 }),
    });
    v.focus();
  }, [scrollToLine]);

  return <div ref={host} style={{ height: "100%", overflow: "hidden" }} />;
});
