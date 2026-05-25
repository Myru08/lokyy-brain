import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { api, type DataviewQuery, type DataviewRow } from "../api.js";

/**
 * Dataview-like Query Preview — renders ```dataview\n{json}\n``` code-fences
 * as a table built from vault frontmatter.
 *
 * Architecture mirrors `mermaidPreview.ts`:
 *   - line-walk to find fence blocks (no multi-line regex — range mapping
 *     stays trivial),
 *   - cursor INSIDE the fence → raw block stays visible (editable),
 *   - widget renders async with loading / error / table states,
 *   - row click dispatches the same `lokyy-open-link` custom event the
 *     wikilink + embed widgets use, so the App opens the note.
 */

const DEFAULT_SELECT = ["title", "type", "updated"];

interface DataviewBlock {
  from: number;
  to: number;
  source: string;
}

/** Line-by-line scan for ```dataview…``` fence blocks. */
function findDataviewBlocks(view: EditorView): DataviewBlock[] {
  const { state } = view;
  const blocks: DataviewBlock[] = [];
  const lineCount = state.doc.lines;

  let i = 1;
  while (i <= lineCount) {
    const line = state.doc.line(i);
    if (/^```dataview\s*$/.test(line.text)) {
      const fenceFrom = line.from;
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
      if (!closed) i = i + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

class DataviewWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof DataviewWidget && other.source === this.source;
  }

  toDOM(_view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-dataview-block";

    // Parse JSON first — JSON errors are render-synchronous and don't need
    // a loading state.
    let query: DataviewQuery;
    try {
      query = JSON.parse(this.source) as DataviewQuery;
      if (!query || typeof query !== "object") {
        throw new Error("query must be an object");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errBox = document.createElement("div");
      errBox.className = "cm-dataview-error";
      errBox.textContent = `⚠ Invalid JSON: ${msg}`;
      container.appendChild(errBox);
      return container;
    }

    const loading = document.createElement("div");
    loading.className = "cm-dataview-loading";
    loading.textContent = "Loading…";
    container.appendChild(loading);

    const select =
      query.select && query.select.length > 0 ? query.select : DEFAULT_SELECT;

    api
      .dataview(query)
      .then((rows) => {
        const table = renderTable(select, rows);
        container.replaceChildren(table);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const errBox = document.createElement("div");
        errBox.className = "cm-dataview-error";
        errBox.textContent = `⚠ Query failed: ${msg}`;
        container.replaceChildren(errBox);
      });

    return container;
  }

  ignoreEvent(): boolean {
    // Allow clicks (we need them for row open).
    return false;
  }
}

function renderTable(select: string[], rows: DataviewRow[]): HTMLElement {
  const table = document.createElement("table");
  table.className = "cm-dataview-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of select) {
    const th = document.createElement("th");
    th.textContent = col;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    // `id` is always populated by queryNotes — used to open the note on click.
    const rowId = row.id;
    if (typeof rowId === "string" && rowId) {
      tr.dataset.link = rowId;
      tr.addEventListener("click", (ev) => {
        ev.stopPropagation();
        tr.dispatchEvent(
          new CustomEvent("lokyy-open-link", {
            detail: { target: rowId },
            bubbles: true,
          }),
        );
      });
    }
    for (const col of select) {
      const td = document.createElement("td");
      const v = row[col];
      td.textContent = v === null || v === undefined ? "" : String(v);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const sel = state.selection.main;

  const blocks = findDataviewBlocks(view);
  for (const block of blocks) {
    const cursorInside = sel.from <= block.to && sel.to >= block.from;
    if (cursorInside) continue;
    builder.add(
      block.from,
      block.to,
      Decoration.replace({
        widget: new DataviewWidget(block.source),
        block: true,
      }),
    );
  }

  return builder.finish();
}

/**
 * Dataview-Preview-Extension. Im `extensions`-Array des Editors zusammen
 * mit `dataviewTheme` einhängen.
 */
export const dataviewExtension = ViewPlugin.fromClass(
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
 * Theme for the Dataview table — matches the warm-dark palette of
 * `lokyyTheme` so it sits inside the editor naturally.
 */
export const dataviewTheme = EditorView.theme({
  ".cm-dataview-block": {
    display: "block",
    margin: "8px 0",
  },
  ".cm-dataview-table": {
    width: "100%",
    borderCollapse: "collapse",
    margin: "8px 0",
    fontSize: "0.92em",
  },
  ".cm-dataview-table th": {
    textAlign: "left",
    padding: "6px 10px",
    borderBottom: "1px solid #2A323D",
    color: "#8B9099",
    textTransform: "uppercase",
    fontSize: "0.8em",
    letterSpacing: "0.05em",
  },
  ".cm-dataview-table td": {
    padding: "6px 10px",
    borderBottom: "1px solid #222831",
  },
  ".cm-dataview-table tr:hover td": {
    background: "rgba(249,115,22,0.08)",
    cursor: "pointer",
  },
  ".cm-dataview-error": {
    color: "#EF4444",
    padding: "12px",
    fontFamily: "monospace",
    fontSize: "0.85em",
    background: "rgba(239,68,68,0.08)",
    borderLeft: "3px solid #EF4444",
  },
  ".cm-dataview-loading": {
    color: "#8B9099",
    padding: "12px",
    fontStyle: "italic",
  },
});
