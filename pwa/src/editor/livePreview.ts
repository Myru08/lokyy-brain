import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

/**
 * Live Preview — der Kern des "fühlt sich an wie Obsidian".
 *
 * CodeMirror 6 ist nur die Engine; das Live-Preview-Verhalten muss man als
 * Extension selbst bauen. Prinzip:
 *
 *   - Cursor steht NICHT in der Zeile  → Markdown-Marker (`#`, `**`, `` ` ``)
 *     ausblenden, Inhalt formatiert darstellen.
 *   - Cursor steht IN der Zeile        → rohes Markdown zeigen, damit man
 *     normal editieren kann.
 *
 * Umgesetzt über den Markdown-Syntaxtree: wir iterieren die sichtbaren
 * Knoten und erzeugen pro Knotentyp eine Decoration (Mark zum Stylen,
 * Replace zum Ausblenden der Marker).
 *
 * Erster lauffähiger Stand: Überschriften, Fett, Kursiv, Inline-Code.
 * Listen-Bullets und Blockquote-Styling sind als nächste Ausbaustufe notiert.
 */

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: "cm-h1",
  ATXHeading2: "cm-h2",
  ATXHeading3: "cm-h3",
  ATXHeading4: "cm-h3",
  ATXHeading5: "cm-h3",
  ATXHeading6: "cm-h3",
};

const hide = Decoration.replace({});

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const ranges: { from: number; to: number; deco: Decoration }[] = [];

  // Zeilen, in denen gerade eine Cursor-/Auswahl liegt → roh anzeigen
  const activeLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let l = first; l <= last; l++) activeLines.add(l);
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const line = state.doc.lineAt(node.from);
        const active = activeLines.has(line.number);

        // --- Überschriften: ganze Zeile bekommt die Größenklasse ---
        const hClass = HEADING_CLASS[node.name];
        if (hClass) {
          ranges.push({
            from: line.from,
            to: line.from,
            deco: Decoration.line({ class: hClass }),
          });
          return;
        }

        // --- "# " Marker ausblenden, wenn die Zeile nicht aktiv ist ---
        if (node.name === "HeaderMark") {
          if (!active) {
            const hasSpace =
              state.doc.sliceString(node.to, node.to + 1) === " ";
            ranges.push({
              from: node.from,
              to: hasSpace ? node.to + 1 : node.to,
              deco: hide,
            });
          }
          return;
        }

        // --- Inline-Formatierung stylen ---
        if (node.name === "StrongEmphasis") {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: "cm-strong" }),
          });
          return;
        }
        if (node.name === "Emphasis") {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: "cm-em" }),
          });
          return;
        }
        if (node.name === "InlineCode") {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.mark({ class: "cm-inline-code" }),
          });
          return;
        }

        // --- Marker der Inline-Formatierung ausblenden (`**`, `*`, `` ` ``) ---
        if (node.name === "EmphasisMark" || node.name === "CodeMark") {
          if (!active) {
            ranges.push({ from: node.from, to: node.to, deco: hide });
          }
          return;
        }
      },
    });
  }

  // Decoration.set verlangt sortierte Ranges; `true` = selbst sortieren.
  // Zero-Length Line-Decorations vor Mark/Replace an gleicher Position
  // werden dabei korrekt einsortiert.
  return Decoration.set(
    ranges.map((r) => r.deco.range(r.from, r.to)),
    true,
  );
}

/** Die Live-Preview-Extension. In den Editor-Extensions-Array einhängen. */
export const livePreview = ViewPlugin.fromClass(
  class {
    decos: DecorationSet;
    constructor(view: EditorView) {
      this.decos = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      // Auch bei reiner Cursor-Bewegung neu bauen — sonst bleibt der
      // Marker der gerade verlassenen Zeile sichtbar.
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decos = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decos },
);
