import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/**
 * Mermaid Preview — rendert ```mermaid Code-Fence-Blöcke zu inline-SVG.
 *
 * Wir scannen das Dokument zeilenweise nach `` ```mermaid `` / `` ``` ``
 * Fence-Paaren, statt eine Multiline-Regex zu nutzen — Range-Mapping
 * bleibt so trivial und mehrere Diagramme pro Doc funktionieren ohne
 * Sonderfall. Cursor / Selection IM Fence → roher Block bleibt sichtbar,
 * damit der Code normal editierbar ist (gleiche Toggle-Mechanik wie
 * `embedPreview.ts`).
 *
 * `mermaid.render` ist async und liefert das SVG als String; wir injizieren
 * es per `innerHTML` ins Widget. Fehler aus Mermaid landen in einer roten
 * Fehlerbox unter dem Block — keine stillen Crashes.
 *
 * Lazy-Load: Mermaid wiegt ~600 KB. Wir ziehen es erst beim ersten
 * tatsächlich gerenderten Diagramm per dynamischem `import()` — schlanke
 * Initial-Bundle, Mermaid landet im eigenen Vite-Chunk.
 */

/** Mermaid-API-Subset, das wir hier benutzen — kein `any`-Import nötig. */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;

/**
 * Lazy-Loader. Wird einmal initialisiert, der Import-Chunk landet im
 * Modul-Cache, weitere Calls bekommen dieselbe Instanz.
 */
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      // `startOnLoad: false` ist Pflicht — wir rendern manuell, Mermaid
      // soll nicht selbst durchs DOM laufen.
      const api = m.default as MermaidApi;
      api.initialize({
        startOnLoad: false,
        theme: "dark",
        themeVariables: {
          background: "#1A1F26",
          primaryColor: "#F97316",
          primaryTextColor: "#FFFFFF",
          lineColor: "#5A6270",
        },
      });
      return api;
    });
  }
  return mermaidPromise;
}

// Stable unique id pro Widget-Render — Mermaid braucht das für interne
// `<defs>`-IDs, sonst kollidieren mehrere Diagramme im selben DOM.
let counter = 0;

class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof MermaidWidget && other.source === this.source;
  }

  toDOM(_view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-mermaid-block";
    container.textContent = "Loading mermaid…";

    const id = `mermaid-${counter++}`;
    // mermaid.render ist Promise-based. Widget-DOM lebt unabhängig vom
    // CM-Update-Zyklus — async hier ist sicher.
    loadMermaid()
      .then((mermaid) => mermaid.render(id, this.source))
      .then(({ svg }) => {
        container.innerHTML = svg;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const errBox = document.createElement("div");
        errBox.className = "cm-mermaid-error";
        errBox.textContent = `⚠ Mermaid: ${message}`;
        container.replaceChildren(errBox);
      });

    return container;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

interface MermaidBlock {
  from: number; // Start des `` ```mermaid ``-Markers
  to: number; // Ende des schließenden `` ``` ``-Markers
  source: string; // Reiner Diagramm-Source ohne Fences
}

/**
 * Walks the document line-by-line to find ```mermaid…``` fence blocks.
 * Eine Multiline-Regex würde Off-by-One-Probleme beim Range-Mapping geben;
 * der Line-Walk ist trivial und O(n).
 */
function findMermaidBlocks(view: EditorView): MermaidBlock[] {
  const { state } = view;
  const blocks: MermaidBlock[] = [];
  const lineCount = state.doc.lines;

  let i = 1;
  while (i <= lineCount) {
    const line = state.doc.line(i);
    if (/^```mermaid\s*$/.test(line.text)) {
      const fenceFrom = line.from;
      // Suche das schließende ```
      let j = i + 1;
      const sourceLines: string[] = [];
      let closed = false;
      while (j <= lineCount) {
        const inner = state.doc.line(j);
        if (/^```\s*$/.test(inner.text)) {
          closed = true;
          blocks.push({
            from: fenceFrom,
            to: inner.to,
            source: sourceLines.join("\n"),
          });
          i = j + 1;
          break;
        }
        sourceLines.push(inner.text);
        j++;
      }
      if (!closed) {
        // Unbeendeter Fence — ignorieren, weiter hinter dem Start-Fence.
        i = i + 1;
      }
    } else {
      i++;
    }
  }
  return blocks;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const sel = state.selection.main;

  const blocks = findMermaidBlocks(view);
  for (const block of blocks) {
    const cursorInside = sel.from <= block.to && sel.to >= block.from;
    if (cursorInside) continue;
    if (!block.source.trim()) continue;
    builder.add(
      block.from,
      block.to,
      Decoration.replace({
        widget: new MermaidWidget(block.source),
        block: true,
      }),
    );
  }

  return builder.finish();
}

/**
 * Mermaid-Preview-Extension. Im `extensions`-Array des Editors zusammen
 * mit `mermaidTheme` einhängen.
 */
export const mermaidPreviewExtension = ViewPlugin.fromClass(
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
 * Theme für die Mermaid-Box. Warmer Dunkel-Hintergrund passend zum
 * `lokyyTheme` — die Mermaid-Theme-Variables greifen IM SVG, hier
 * stylen wir nur den Container.
 */
export const mermaidTheme = EditorView.theme({
  ".cm-mermaid-block": {
    display: "block",
    padding: "16px",
    background: "#1A1F26",
    border: "1px solid #2A323D",
    borderRadius: "6px",
    margin: "8px 0",
    textAlign: "center",
  },
  ".cm-mermaid-block svg": {
    maxWidth: "100%",
    height: "auto",
  },
  ".cm-mermaid-error": {
    color: "#c84a32",
    padding: "12px",
    fontFamily: "monospace",
    fontSize: "0.85em",
  },
});
