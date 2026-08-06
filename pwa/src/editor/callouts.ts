import { type EditorState, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

/**
 * Callout-Rendering — hebt `> [!warning]` / `> [!info]`-Blöcke farbig ab.
 *
 * Der Lint-Warnkasten (`packages/core/src/lint/calloutWriter.ts`) schreibt
 * Widersprüche als Markdown-Callout mitten in die Notiz. Ohne diese Extension
 * sieht der Nutzer im Editor nur graue Blockquote-Zeilen — der Kasten muss
 * aber sofort als Warnung lesbar sein.
 *
 * Zwei Decorations pro Block:
 *   1. Zeilen-Decoration je Callout-Zeile → Rahmen links, getönter
 *      Hintergrund, Farbe nach Typ. Der Text bleibt echter, editierbarer
 *      Markdown — bewusst KEIN Replace-Widget: der Nutzer muss den Kasten
 *      lesen, kopieren und notfalls von Hand entfernen können.
 *   2. Block-Replace über die Anker-Kommentarzeilen
 *      (`<!-- lokyy-lint:<id> -->`) → macht die technische Identität des
 *      Findings unsichtbar, ohne sie aus dem Dokument zu löschen. Der Text
 *      bleibt im State, Speichern verliert den Anker also NICHT.
 *
 * WICHTIG (CM6-Invariante): Block-Decorations (`block: true`) MÜSSEN aus
 * einem `StateField` stammen. Aus einem `ViewPlugin` wirft CodeMirror zur
 * Laufzeit `RangeError: Block decorations may not be specified via plugins` —
 * ein Fehler, den der Build NICHT fängt. Deshalb ist diese Extension ein
 * StateField, exakt wie `frontmatterHide`. Der Regressionstest
 * `callouts.test.ts` mountet dafür einen echten EditorView.
 */

export type CalloutKind = "warning" | "danger" | "info" | "note";

export interface CalloutLineInfo {
  /** 1-basierte Zeilennummer. */
  line: number;
  kind: CalloutKind;
  position: "first" | "middle" | "last" | "only";
}

export interface CalloutScan {
  /** 1-basierte Zeilennummern der Lint-Anker-Kommentare. */
  anchors: number[];
  lines: CalloutLineInfo[];
}

/** `> [!type] Titel` — Blockstart. Führende Leerzeichen sind erlaubt. */
const CALLOUT_START = /^\s*>\s*\[!([A-Za-z]+)\]/;
/** Jede weitere Blockquote-Zeile setzt den Block fort. */
const QUOTE_LINE = /^\s*>/;
/** Öffnender oder schließender Lint-Anker. */
const ANCHOR_LINE = /^<!--\s*\/?lokyy-lint:[^\s]+\s*-->$/;

/**
 * Obsidian kennt Dutzende Callout-Aliase. Wir mappen auf vier visuelle
 * Klassen; alles Unbekannte wird neutral (`note`) dargestellt, damit ein
 * Tippfehler im Typ nicht zu einer unsichtbaren Box führt.
 */
const KIND_ALIASES: Record<string, CalloutKind> = {
  warning: "warning",
  caution: "warning",
  attention: "warning",
  danger: "danger",
  error: "danger",
  bug: "danger",
  failure: "danger",
  info: "info",
  tip: "info",
  hint: "info",
  todo: "info",
  question: "info",
  note: "note",
  abstract: "note",
  example: "note",
  quote: "note",
};

function normalizeKind(raw: string): CalloutKind {
  return KIND_ALIASES[raw.toLowerCase()] ?? "note";
}

/**
 * Zeilenweiser Scan über den Dokumenttext. Bewusst ohne Markdown-Parser: der
 * Lint-Kasten ist ein fest definiertes Format, und ein reiner Zeilen-Scan ist
 * für die Decoration-Berechnung bei jedem Tastendruck billig genug.
 */
export function scanCallouts(text: string): CalloutScan {
  const anchors: number[] = [];
  const lines: CalloutLineInfo[] = [];
  const rawLines = text.split("\n");

  let current: CalloutLineInfo[] = [];

  const flush = () => {
    if (current.length === 0) return;
    if (current.length === 1) {
      current[0]!.position = "only";
    } else {
      current[0]!.position = "first";
      current[current.length - 1]!.position = "last";
    }
    lines.push(...current);
    current = [];
  };

  let activeKind: CalloutKind | null = null;

  rawLines.forEach((raw, i) => {
    const lineNo = i + 1;

    if (ANCHOR_LINE.test(raw.trim())) {
      anchors.push(lineNo);
      // Der Anker unterbricht den Block nicht — er umschließt ihn.
      return;
    }

    const start = raw.match(CALLOUT_START);
    if (start) {
      // Ein neuer `[!type]`-Marker beginnt immer einen neuen Block, auch
      // direkt nach einem vorherigen.
      flush();
      activeKind = normalizeKind(start[1]!);
      current.push({ line: lineNo, kind: activeKind, position: "middle" });
      return;
    }

    if (activeKind && QUOTE_LINE.test(raw)) {
      current.push({ line: lineNo, kind: activeKind, position: "middle" });
      return;
    }

    flush();
    activeKind = null;
  });

  flush();
  return { anchors, lines };
}

/**
 * Zero-Height-Widget für die Anker-Zeile. Ersetzt die Zeile inklusive ihres
 * Zeilenumbruchs, damit im Editor keine Leerzeile über dem Kasten stehen
 * bleibt.
 */
class AnchorWidget extends WidgetType {
  eq(other: WidgetType): boolean {
    return other instanceof AnchorWidget;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-callout-anchor-hidden";
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const anchorWidget = new AnchorWidget();

function buildDecorations(state: EditorState): DecorationSet {
  const scan = scanCallouts(state.doc.toString());
  if (scan.anchors.length === 0 && scan.lines.length === 0) {
    return Decoration.none;
  }

  const ranges = [];

  for (const lineNo of scan.anchors) {
    const line = state.doc.line(lineNo);
    const hasNextLine = lineNo < state.doc.lines;
    ranges.push(
      Decoration.replace({ widget: anchorWidget, block: true }).range(
        line.from,
        hasNextLine ? line.to + 1 : line.to,
      ),
    );
  }

  for (const info of scan.lines) {
    const line = state.doc.line(info.line);
    ranges.push(
      Decoration.line({
        class: `cm-callout cm-callout-${info.kind} cm-callout-${info.position}`,
      }).range(line.from),
    );
  }

  // `true` = sortieren lassen: Anker- und Zeilen-Ranges entstehen oben in
  // zwei getrennten Durchläufen und sind daher nicht global aufsteigend.
  return Decoration.set(ranges, true);
}

/**
 * Callout-Extension. Im `extensions`-Array des Editors zusammen mit
 * `calloutTheme` einhängen — nach `frontmatterHideExtension` und vor den
 * Inhalts-Previews. Beide Block-Decoration-Felder koexistieren
 * konfliktfrei, weil ihre Ranges disjunkt sind (Frontmatter am Doc-Anfang,
 * Kasten im Body).
 */
export const calloutExtension = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(deco, tr) {
    return tr.docChanged ? buildDecorations(tr.state) : deco.map(tr.changes);
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // Nur die versteckten Anker sind atomar — der Cursor überspringt sie,
    // statt in einer unsichtbaren Zeile zu verschwinden. Die Kasten-Zeilen
    // selbst bleiben ganz normal editierbar.
    EditorView.atomicRanges.of((view) => {
      const set = view.state.field(f);
      const atomic = [];
      const iter = set.iter();
      while (iter.value) {
        // Block-Replaces (Anker) haben kein `class` im Spec — Zeilen-
        // Decorations schon. Nur erstere sollen atomar sein.
        if (iter.value.spec?.widget instanceof AnchorWidget) {
          atomic.push(Decoration.mark({}).range(iter.from, iter.to));
        }
        iter.next();
      }
      return Decoration.set(atomic, true);
    }),
  ],
});

/**
 * Farben bewusst als feste RGBA-Tönungen statt Theme-Variablen: der Kasten
 * muss in jedem Theme als Warnung erkennbar bleiben, und der Editor rendert
 * auf dunklem Grund.
 */
export const calloutTheme = EditorView.theme({
  ".cm-callout-anchor-hidden": {
    display: "block",
    height: "0",
    margin: "0",
    padding: "0",
    overflow: "hidden",
  },
  ".cm-callout": {
    paddingLeft: "10px",
    paddingRight: "8px",
    borderLeft: "3px solid transparent",
  },
  ".cm-callout-first": {
    paddingTop: "6px",
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
  },
  ".cm-callout-last": {
    paddingBottom: "6px",
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
  },
  ".cm-callout-only": {
    paddingTop: "6px",
    paddingBottom: "6px",
    borderRadius: "6px",
  },
  ".cm-callout-warning": {
    background: "rgba(245, 158, 11, 0.10)",
    borderLeftColor: "#F59E0B",
  },
  ".cm-callout-danger": {
    background: "rgba(239, 68, 68, 0.12)",
    borderLeftColor: "#EF4444",
  },
  ".cm-callout-info": {
    background: "rgba(59, 130, 246, 0.10)",
    borderLeftColor: "#3B82F6",
  },
  ".cm-callout-note": {
    background: "rgba(148, 163, 184, 0.10)",
    borderLeftColor: "#94A3B8",
  },
});
