import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
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

export function Editor({
  noteId,
  initialBody,
  onChange,
  onOpenLink,
  onOpenLinkSplit,
  scrollToLine,
}: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  // Callbacks in Refs halten, damit die View nicht neu erzeugt werden muss
  const onChangeRef = useRef(onChange);
  const onOpenRef = useRef(onOpenLink);
  const onOpenSplitRef = useRef(onOpenLinkSplit);
  onChangeRef.current = onChange;
  onOpenRef.current = onOpenLink;
  onOpenSplitRef.current = onOpenLinkSplit;

  // Note-Liste für Wikilink-Autocomplete prefetchen
  useEffect(() => {
    prefetchWikilinkTargets();
  }, [noteId]);

  // View einmalig aufbauen
  useEffect(() => {
    if (!host.current) return;

    const state = EditorState.create({
      doc: initialBody,
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
        }),
      ],
    });

    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => v.destroy();
    // bewusst nur beim Mount — Doc-Wechsel siehe unten
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notizwechsel ODER externe Body-Aktualisierung (z.B. PropertiesPanel)
  // → Dokument im Ganzen ersetzen. Der toString-Guard verhindert Resets bei
  // reinen Save-Roundtrips (Doc-Text == initialBody schon).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (v.state.doc.toString() === initialBody) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: initialBody },
    });
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
}
