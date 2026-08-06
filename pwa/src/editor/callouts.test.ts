import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { calloutExtension, calloutTheme, scanCallouts } from "./callouts.js";
import {
  frontmatterHideExtension,
  frontmatterHideTheme,
} from "./frontmatterHide.js";

/**
 * AC2 — Callout-Rendering im Editor.
 *
 * Der harte Teil ist nicht das Styling, sondern die CM6-Invariante: Block-
 * Decorations (`block: true`) dürfen NUR aus einem StateField kommen. Aus
 * einem ViewPlugin wirft CodeMirror zur Laufzeit
 * `RangeError: Block decorations may not be specified via plugins` — ein
 * Fehler, den weder `tsc` noch der Build sieht. Deshalb mountet dieser Test
 * einen echten EditorView (jsdom) und beweist, dass Mount UND Update ohne
 * Exception durchlaufen — inklusive Koexistenz mit `frontmatterHide`, das
 * ebenfalls Block-Decorations liefert.
 */

const FINDING_ID = "01J0000000000000000000000X";

const DOC = `---
id: 01JAAAAAAAAAAAAAAAAAAAAAAA
type: note
title: Angebot A
created: 2026-05-30
updated: 2026-05-30
---
<!-- lokyy-lint:${FINDING_ID} -->
> [!warning] Widerspruch — zwei Aussagen stehen gegeneinander
> Der Preis unterscheidet sich.
>
> **A · [[10_projects/a|Angebot A]]**
> > Der Preis ist 100 €.
<!-- /lokyy-lint:${FINDING_ID} -->

# Angebot A

Der Preis ist 100 €.
`;

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string, withFrontmatterHide = false): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: withFrontmatterHide
        ? [
            frontmatterHideExtension,
            frontmatterHideTheme,
            calloutExtension,
            calloutTheme,
          ]
        : [calloutExtension, calloutTheme],
    }),
    parent,
  });
}

describe("scanCallouts (parser)", () => {
  it("finds the callout body lines and both anchor lines", () => {
    const scan = scanCallouts(DOC);
    // Zeile 8 = öffnender Anker, Zeile 14 = schließender Anker (1-basiert).
    expect(scan.anchors).toEqual([8, 14]);
    // Zeilen 9..13 sind der Kasten.
    expect(scan.lines.map((l) => l.line)).toEqual([9, 10, 11, 12, 13]);
    expect(scan.lines.every((l) => l.kind === "warning")).toBe(true);
  });

  it("marks the first and last line of a block", () => {
    const scan = scanCallouts(DOC);
    expect(scan.lines[0]?.position).toBe("first");
    expect(scan.lines[scan.lines.length - 1]?.position).toBe("last");
    expect(scan.lines[1]?.position).toBe("middle");
  });

  it("recognises [!info] and maps unknown types to note", () => {
    expect(scanCallouts("> [!info] Hinweis\n> Text").lines[0]?.kind).toBe("info");
    expect(scanCallouts("> [!danger] Stop").lines[0]?.kind).toBe("danger");
    expect(scanCallouts("> [!quux] ?").lines[0]?.kind).toBe("note");
  });

  it("ignores plain blockquotes without a callout marker", () => {
    const scan = scanCallouts("> nur ein Zitat\n> zweite Zeile");
    expect(scan.lines).toEqual([]);
  });

  it("handles two callout blocks in one document", () => {
    const scan = scanCallouts("> [!warning] A\n\n> [!info] B\n> mehr");
    expect(scan.lines.map((l) => l.kind)).toEqual([
      "warning",
      "info",
      "info",
    ]);
  });

  it("ends a block at the first non-quote line", () => {
    const scan = scanCallouts("> [!warning] A\n> drin\nnicht mehr drin\n> [!info] B");
    expect(scan.lines.map((l) => l.line)).toEqual([1, 2, 4]);
  });
});

describe("calloutExtension (StateField, runtime)", () => {
  it("mounts an EditorView with a callout block without throwing RangeError", () => {
    expect(() => {
      view = mount(DOC);
    }).not.toThrow();

    const deco = view!.state.field(calloutExtension);
    expect(deco).toBeDefined();
    // 2 Anker-Block-Replaces + 5 Zeilen-Decorations.
    expect(deco.size).toBe(7);
  });

  it("survives a doc-change dispatch (the path that used to crash on update)", () => {
    view = mount(DOC);
    expect(() => {
      view!.dispatch({
        changes: { from: view!.state.doc.length, insert: "\nnoch ein Satz" },
      });
    }).not.toThrow();
    expect(view!.state.field(calloutExtension).size).toBe(7);
  });

  it("coexists with the frontmatterHide block decoration", () => {
    expect(() => {
      view = mount(DOC, true);
    }).not.toThrow();
    expect(view!.state.field(frontmatterHideExtension).size).toBe(1);
    expect(view!.state.field(calloutExtension).size).toBe(7);
  });

  it("keeps the anchors in the document (only their rendering is hidden)", () => {
    view = mount(DOC);
    expect(view.state.doc.toString()).toContain(`<!-- lokyy-lint:${FINDING_ID} -->`);
    expect(view.state.doc.toString()).toContain(
      `<!-- /lokyy-lint:${FINDING_ID} -->`,
    );
  });

  it("emits no decorations for a document without callouts", () => {
    view = mount("# Nur Text\n\nKein Kasten hier.");
    expect(view.state.field(calloutExtension).size).toBe(0);
  });

  it("renders a hand-written callout that has no lint anchors", () => {
    view = mount("> [!info] Hinweis\n> Zweite Zeile\n\nRest.");
    expect(view.state.field(calloutExtension).size).toBe(2);
  });

  it("skips the hidden anchor when the cursor is moved through it", () => {
    view = mount(DOC);
    // `moveByChar` konsultiert die atomicRanges — der Pfad, auf dem eine
    // fehlerhafte Range-Berechnung zur Laufzeit (und nur dort) fliegt.
    expect(() => {
      const anchorStart = view!.state.doc.line(8).from;
      view!.dispatch({ selection: EditorSelection.cursor(anchorStart) });
      const moved = view!.moveByChar(view!.state.selection.main, true);
      view!.dispatch({ selection: EditorSelection.cursor(moved.head) });
    }).not.toThrow();
  });

  it("recovers when the user types the callout marker into a plain line", () => {
    view = mount("Text\n");
    expect(view.state.field(calloutExtension).size).toBe(0);
    expect(() => {
      view!.dispatch({ changes: { from: 0, to: 4, insert: "> [!warning] Neu" } });
    }).not.toThrow();
    expect(view!.state.field(calloutExtension).size).toBe(1);
  });
});
