import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/**
 * Frontmatter Hide — blendet den führenden YAML-Frontmatter-Block im
 * Editor-Body VISUELL aus.
 *
 * Warum: Notizen tragen ihre Metadaten als `--- … ---`-YAML am Dokument-
 * Anfang (SPEC-Pflicht — `id`, `type`, `title`, `created`, `updated`). Das
 * Properties-Panel ist die einzige Metadaten-Oberfläche; den rohen YAML-Block
 * im Body daneben zu zeigen ist redundant und verwirrend.
 *
 * Wichtig: Der Text bleibt im EditorState erhalten. Wir blenden nur die
 * Darstellung aus (Decoration.replace mit Block-Widget über die Range). So
 * geht das Frontmatter beim Speichern NICHT verloren — `onChange` liest
 * weiterhin `state.doc.toString()` inklusive Frontmatter.
 *
 * Wir blenden nur aus, wenn das Dokument tatsächlich mit einem gültigen
 * Frontmatter-Block beginnt: erste Zeile exakt `---`, gefolgt von einer
 * weiteren `---`-Zeile. Andernfalls greift die Extension nicht (z.B. eine
 * Notiz, die zufällig mit einem horizontalen Trenner anfängt — der hat eine
 * schließende `---` nicht direkt als Block-Abschluss am Doc-Anfang).
 */

/**
 * Zero-Height-Widget. Es ersetzt den gesamten Frontmatter-Range. Wir rendern
 * ein leeres Block-Element ohne Höhe/Margin, damit oben im Editor KEINE
 * Leerzeile / kein Abstand zurückbleibt — der Body beginnt optisch direkt
 * mit dem ersten echten Inhalt.
 */
class FrontmatterWidget extends WidgetType {
  // Alle Instanzen sind austauschbar — das Widget hat keinen sichtbaren
  // Inhalt, der vom Frontmatter-Text abhängt. Konstante eq() verhindert
  // unnötige DOM-Rebuilds beim Tippen im Body.
  eq(other: WidgetType): boolean {
    return other instanceof FrontmatterWidget;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-frontmatter-hidden";
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const frontmatterWidget = new FrontmatterWidget();

/**
 * Findet den führenden Frontmatter-Block. Liefert das End-Offset (exklusive
 * Position bis zu der ersetzt wird) oder `null`, wenn das Doc nicht mit einem
 * gültigen Frontmatter beginnt.
 *
 * Range-Logik: Wir ersetzen von Offset 0 bis zum ENDE der Zeile mit dem
 * schließenden `---` (inkl. des darauffolgenden Newline, falls vorhanden), so
 * dass der Body direkt mit der ersten echten Inhaltszeile losgeht.
 */
function findFrontmatterEnd(view: EditorView): number | null {
  const { state } = view;
  if (state.doc.lines < 2) return null;

  const first = state.doc.line(1);
  if (first.text !== "---") return null;

  // Suche die nächste reine `---`-Zeile als Block-Abschluss.
  for (let i = 2; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (line.text === "---") {
      // Schließende Marker-Zeile gefunden. Inklusive folgendem Newline
      // ausblenden (falls die nächste Zeile existiert), damit kein
      // führender Leer-Absatz im Body übrigbleibt.
      const hasNextLine = i < state.doc.lines;
      return hasNextLine ? line.to + 1 : line.to;
    }
  }
  // Kein schließender Marker → kein gültiger Frontmatter-Block.
  return null;
}

function buildDecorations(view: EditorView): DecorationSet {
  const end = findFrontmatterEnd(view);
  if (end == null) return Decoration.none;

  return Decoration.set([
    Decoration.replace({
      widget: frontmatterWidget,
      block: true,
    }).range(0, end),
  ]);
}

/**
 * Frontmatter-Hide-Extension. Im `extensions`-Array des Editors zusammen mit
 * `frontmatterHideTheme` einhängen — möglichst früh, damit sie unabhängig von
 * den Inhalts-Previews (livePreview, mermaid, …) greift. Block-Decorations
 * kollidieren nicht mit den Inline-Mark-Decorations der anderen Extensions,
 * weil der Frontmatter-Range vor dem Body liegt.
 */
export const frontmatterHideExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      // Bei Doc-Änderung neu bauen (Frontmatter könnte sich verschieben oder
      // entstehen/verschwinden). viewportChanged ist irrelevant — der Block
      // sitzt immer am Doc-Anfang. selectionSet ebenfalls irrelevant: wir
      // blenden IMMER aus, unabhängig von der Cursor-Position.
      if (u.docChanged) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // Atomic-Range: der Cursor kann nicht IN den ausgeblendeten Block
    // navigieren — Pfeiltasten / Klick überspringen ihn. Verhindert, dass
    // man "blind" im versteckten YAML landet.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => {
        return view.plugin(plugin)?.decorations ?? Decoration.none;
      }),
  },
);

/**
 * Theme für das Frontmatter-Widget. Höhe 0, keine Margins — der ausgeblendete
 * Block hinterlässt keinen sichtbaren Abstand am Editor-Anfang.
 */
export const frontmatterHideTheme = EditorView.theme({
  ".cm-frontmatter-hidden": {
    display: "block",
    height: "0",
    margin: "0",
    padding: "0",
    overflow: "hidden",
  },
});
