import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { isKnownWikilinkTarget } from "./wikilinkAutocomplete.js";

/**
 * Wikilink- und Tag-Extension.
 *
 * `[[Ziel]]`, `[[Ziel|Alias]]` und `#tag` sind kein CommonMark — der
 * Markdown-Syntaxtree kennt sie nicht. Also werden sie per Regex über die
 * sichtbaren Zeilen erkannt und als Mark-Decorations gestylt.
 *
 * Derselbe Wikilink-Begriff (`[[...]]`) ist die Quelle, aus der serverseitig
 * der Graph seine Kanten zieht — Parser-Logik bewusst deckungsgleich.
 */

// [[Ziel]] oder [[Ziel|Alias]]
const WIKILINK = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;
// #tag — ohne Lookbehind (breitere Browser-Kompatibilität)
const TAG = /(^|\s)(#[\wÄÖÜäöüß][\wÄÖÜäöüß-]*)/g;

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);

    // Treffer beider Regexes einsammeln, dann sortiert in den Builder geben
    const hits: { from: number; to: number; deco: Decoration }[] = [];

    for (const m of text.matchAll(WIKILINK)) {
      const start = from + (m.index ?? 0);
      const end = start + m[0].length;
      const target = m[1].trim();
      const resolved = isKnownWikilinkTarget(target.toLowerCase());
      hits.push({
        from: start,
        to: end,
        deco: Decoration.mark({
          class: resolved ? "cm-wikilink" : "cm-wikilink-unresolved",
          attributes: { "data-link": target },
        }),
      });
    }

    for (const m of text.matchAll(TAG)) {
      const start = from + (m.index ?? 0) + m[1].length;
      const end = start + m[2].length;
      hits.push({
        from: start,
        to: end,
        deco: Decoration.mark({ class: "cm-tag" }),
      });
    }

    hits.sort((a, b) => a.from - b.from || a.to - b.to);
    for (const h of hits) builder.add(h.from, h.to, h.deco);
  }

  return builder.finish();
}

/**
 * Liefert die Wikilink-/Tag-Extension. `onOpen` wird mit dem Linkziel
 * aufgerufen, wenn der Nutzer auf einen `[[Wikilink]]` klickt.
 *
 * Wenn `onOpenSplit` gesetzt ist und der Klick mit gehaltener Cmd/Ctrl-
 * Taste passiert, wird stattdessen `onOpenSplit` aufgerufen — App.tsx
 * öffnet das Ziel dann in der Secondary-Pane (SplitView).
 */
export function wikilinkExtension(
  onOpen: (target: string) => void,
  onOpenSplit?: (target: string) => void,
) {
  const decorations = ViewPlugin.fromClass(
    class {
      decos: DecorationSet;
      constructor(view: EditorView) {
        this.decos = buildDecorations(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) {
          this.decos = buildDecorations(u.view);
        }
      }
    },
    { decorations: (v) => v.decos },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(event) {
      const el = event.target as HTMLElement | null;
      const link = el?.dataset?.link;
      if (link) {
        if ((event.metaKey || event.ctrlKey) && onOpenSplit) {
          onOpenSplit(link);
        } else {
          onOpen(link);
        }
        return true;
      }
      return false;
    },
  });

  return [decorations, clicks];
}
