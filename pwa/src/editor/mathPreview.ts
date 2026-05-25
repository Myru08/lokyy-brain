import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * Math Preview — KaTeX-Rendering für Inline- (`$…$`) und Display-Math
 * (`$$\n…\n$$`).
 *
 * Architektur-Spiegel von `wikilink.ts` und `embedPreview.ts`:
 *   - `ViewPlugin.fromClass` rebuildet bei docChanged/viewportChanged/selectionSet
 *   - `Decoration.replace` mit `WidgetType` rendert die KaTeX-Ausgabe
 *   - Cursor / Selection im Range → roh anzeigen (gleiches Toggle wie der Embed)
 *
 * KaTeX rendert per `renderToString` zu einem HTML-String, das per
 * `innerHTML` in die Widget-Hülle wandert. Bei Parse-Fehlern (`throwOnError:
 * false` reicht nicht für jeden Edge-Case → defensiv try/catch) fällt das
 * Widget auf die rohe Quelle in einer rot getönten Fehlerbox zurück.
 */

// Inline: `$…$` ohne Zeilenumbruch, ohne führendes `\` oder weiteres `$`.
// Lookbehind: kein vorheriges `\` (Escape) und kein direktes `$` (das wäre
// der Anfang eines `$$`-Blocks).
const INLINE_MATH = /(?<![\\$])\$([^$\n]+?)\$(?!\$)/g;

// Display: `$$` auf eigener Zeile, beliebig viele Zeilen Inhalt, dann `$$`
// wieder auf eigener Zeile. `\n` davor und danach sind Teil des Matches,
// damit die Replace-Range die kompletten Marker-Zeilen abdeckt.
const DISPLAY_MATH = /(^|\n)\$\$\n([\s\S]+?)\n\$\$(?=\n|$)/g;

class MathInlineWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof MathInlineWidget && other.src === this.src;
  }

  toDOM(_view: EditorView): HTMLElement {
    const span = document.createElement("span");
    try {
      const html = katex.renderToString(this.src, {
        throwOnError: false,
        displayMode: false,
      });
      span.className = "cm-math-inline";
      span.innerHTML = html;
    } catch (err) {
      span.className = "cm-math-error";
      span.textContent = `$${this.src}$`;
      span.title = err instanceof Error ? err.message : String(err);
    }
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class MathBlockWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof MathBlockWidget && other.src === this.src;
  }

  toDOM(_view: EditorView): HTMLElement {
    const div = document.createElement("div");
    try {
      const html = katex.renderToString(this.src, {
        throwOnError: false,
        displayMode: true,
      });
      div.className = "cm-math-block";
      div.innerHTML = html;
    } catch (err) {
      div.className = "cm-math-error";
      div.textContent = `$$\n${this.src}\n$$`;
      div.title = err instanceof Error ? err.message : String(err);
    }
    return div;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const sel = state.selection.main;
  // Decoration.set verlangt sortierte Ranges — wir sammeln und sortieren
  // selbst, weil Display- und Inline-Hits aus zwei Pässen kommen.
  const hits: { from: number; to: number; deco: Decoration }[] = [];

  // --- Display-Math: einmal über das ganze Dokument scannen ---
  // Block-Math ist selten genug, dass ein Full-Doc-Scan kein Problem ist;
  // wir würden sonst Blöcke verlieren, die nur teilweise im Viewport liegen.
  const fullText = state.doc.toString();
  for (const m of fullText.matchAll(DISPLAY_MATH)) {
    const leadingNewline = m[1].length; // 0 oder 1
    const matchStart = (m.index ?? 0) + leadingNewline;
    const matchEnd = matchStart + m[0].length - leadingNewline;
    const cursorInside = sel.from <= matchEnd && sel.to >= matchStart;
    if (cursorInside) continue;
    hits.push({
      from: matchStart,
      to: matchEnd,
      deco: Decoration.replace({
        widget: new MathBlockWidget(m[2]),
        block: true,
      }),
    });
  }

  // --- Inline-Math: über sichtbare Ranges scannen ---
  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to);
    for (const m of text.matchAll(INLINE_MATH)) {
      const start = from + (m.index ?? 0);
      const end = start + m[0].length;
      // Falls dieser Inline-Hit innerhalb eines schon erfassten Display-
      // Math-Blocks liegt: überspringen, sonst überlappen sich Ranges.
      const insideBlock = hits.some(
        (h) => h.from <= start && h.to >= end && h.deco !== undefined,
      );
      if (insideBlock) continue;
      const cursorInside = sel.from <= end && sel.to >= start;
      if (cursorInside) continue;
      hits.push({
        from: start,
        to: end,
        deco: Decoration.replace({
          widget: new MathInlineWidget(m[1]),
          block: false,
        }),
      });
    }
  }

  hits.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let lastTo = -1;
  for (const h of hits) {
    // Defensiv: Überlappungen verwerfen — RangeSetBuilder wirft sonst.
    if (h.from < lastTo) continue;
    builder.add(h.from, h.to, h.deco);
    lastTo = h.to;
  }
  return builder.finish();
}

/**
 * KaTeX-Math-Extension. Im `extensions`-Array des Editors zusammen mit
 * `mathTheme` einhängen.
 */
export const mathPreviewExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * Theme für die Math-Widgets. Hält die KaTeX-Renderbox dezent — KaTeX
 * bringt sein eigenes CSS mit (oben importiert), wir setzen nur Layout.
 */
export const mathTheme = EditorView.theme({
  ".cm-math-inline": {
    padding: "0 2px",
  },
  ".cm-math-block": {
    display: "block",
    padding: "8px 0",
    textAlign: "center",
  },
  ".cm-math-error": {
    color: "#c84a32",
    background: "rgba(200,74,50,0.1)",
    padding: "0 4px",
    borderRadius: "3px",
  },
});
