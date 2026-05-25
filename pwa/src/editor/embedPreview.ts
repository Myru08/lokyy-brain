import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { resolveWikilinkTarget } from "./wikilinkAutocomplete.js";

/**
 * Embedded Note Previews — Obsidian-Style `![[Note Title]]`.
 *
 * Erkennt eine Embed-Zeile (`![[Ziel]]` oder `![[Ziel|Alias]]` allein auf
 * der Zeile) und ersetzt sie durch eine Embed-Card mit Titel + ersten ~200
 * Zeichen des Ziel-Note-Bodys. Cursor in der Zeile → Roh-Markdown bleibt
 * sichtbar, damit normal editiert werden kann (gleicher Mechanismus wie
 * `livePreview.ts`).
 *
 * Architektur-Spiegel von `wikilink.ts`:
 *   - `ViewPlugin.fromClass` rebuildet bei docChanged/viewportChanged/selectionSet
 *   - `WidgetType` rendert die Card
 *   - Klick auf den Card-Header bubbelt ein `lokyy-open-link`-CustomEvent
 *     hoch UND setzt `data-link`, sodass der bestehende mousedown-Handler
 *     im `wikilinkExtension` ebenfalls greift (defensiv — was zuerst feuert
 *     öffnet die Note).
 */

// `![[Ziel]]` oder `![[Ziel|Alias]]` — allein auf der Zeile (trailing whitespace ok)
const EMBED_LINE = /^!\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]\s*$/m;

class EmbedWidget extends WidgetType {
  constructor(readonly target: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof EmbedWidget && other.target === this.target;
  }

  toDOM(_view: EditorView): HTMLElement {
    const card = document.createElement("div");
    card.className = "cm-embed-card";

    const resolved = resolveWikilinkTarget(this.target);
    const displayTitle = resolved?.title ?? this.target;
    const fetchKey = resolved?.id ?? this.target;

    const header = document.createElement("div");
    header.className = "cm-embed-title";
    header.textContent = `📄 ${displayTitle}`;
    // Mit `data-link` greift der bestehende mousedown-Handler aus
    // `wikilinkExtension` (siehe wikilink.ts) — selber Open-Flow wie ein
    // normaler `[[Wikilink]]`-Klick.
    header.dataset.link = this.target;
    header.addEventListener("click", (ev) => {
      ev.stopPropagation();
      header.dispatchEvent(
        new CustomEvent("lokyy-open-link", {
          detail: { target: this.target },
          bubbles: true,
        }),
      );
    });
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "cm-embed-body";
    body.textContent = "…loading…";
    card.appendChild(body);

    // Async fetch — Widget-DOM lebt unabhängig vom CM-Update-Zyklus.
    void fetch(`/api/notes/${encodeURIComponent(fetchKey)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`http ${res.status}`);
        const note = (await res.json()) as { body?: string };
        const raw = note.body ?? "";
        const stripped = stripFrontmatter(raw).trim();
        const truncated =
          stripped.length > 200 ? `${stripped.slice(0, 200)}…` : stripped;
        body.textContent = truncated || "(empty)";
      })
      .catch(() => {
        body.textContent = "⚠ Note not found";
      });

    return card;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Entfernt einen führenden YAML-Frontmatter-Block (`---\n...\n---\n`) aus
 * dem Note-Body. Lokales Mini-Stripper — keine Abhängigkeit auf gray-matter
 * im PWA-Bundle.
 */
function stripFrontmatter(body: string): string {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return body;
  // Sucht nach dem schließenden `---` am Zeilenanfang.
  const closing = body.indexOf("\n---", 3);
  if (closing < 0) return body;
  const after = body.indexOf("\n", closing + 4);
  return after < 0 ? "" : body.slice(after + 1);
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const sel = state.selection.main;

  for (const { from, to } of view.visibleRanges) {
    // Wir scannen Zeile für Zeile statt einer einzigen Multiline-Regex —
    // das macht Range-Mapping trivial und mehrere Embeds pro Viewport
    // funktionieren out-of-the-box.
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      const text = line.text;
      const m = EMBED_LINE.exec(text);
      if (m) {
        const target = m[1].trim();
        const lineFrom = line.from;
        const lineTo = line.to;
        // Cursor / Selection irgendwo in dieser Zeile? → roh anzeigen.
        const cursorInside = sel.from <= lineTo && sel.to >= lineFrom;
        if (!cursorInside && target) {
          builder.add(
            lineFrom,
            lineTo,
            Decoration.replace({
              widget: new EmbedWidget(target),
              block: false,
            }),
          );
        }
      }
      pos = line.to + 1;
      if (line.to >= to) break;
    }
  }

  return builder.finish();
}

/**
 * Embed-Preview-Extension. Im `extensions`-Array des Editors zusammen mit
 * `embedTheme` aus `embedPreview.css.ts` einhängen.
 */
export const embedPreviewExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      // selectionSet auch — sonst bleibt die Zeile nach Cursor-Bewegung
      // im falschen Modus (raw vs. card).
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export { embedTheme } from "./embedPreview.css.js";
