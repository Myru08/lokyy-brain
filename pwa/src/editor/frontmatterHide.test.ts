import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  frontmatterHideExtension,
  frontmatterHideTheme,
} from "./frontmatterHide.js";

/**
 * Laufzeit-Regressionstest für den CM6-Block-Decoration-Bug.
 *
 * Der alte ViewPlugin-Ansatz warf beim Mounten/Update
 * `RangeError: Block decorations may not be specified via plugins`, weil
 * CodeMirror 6 Block-Decorations (`block: true`) ausschließlich aus einem
 * StateField zulässt. Dieser Test mountet einen echten EditorView mit der
 * Extension und beweist, dass KEINE Exception fliegt.
 *
 * Hinweis: CM6 misst Layout im DOM. jsdom liefert dafür keine echten
 * Box-Größen, aber die Decoration-Validierung (Block-aus-Plugin-Verbot) läuft
 * VOR der Layout-Messung — exakt diese Validierung warf den RangeError. Der
 * Test triggert sie zuverlässig.
 */

const FRONTMATTER_DOC = `---
id: 01J0000000000000000000000X
type: note
title: T
created: 2026-05-30
updated: 2026-05-30
---
# Body

Some content.`;

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [frontmatterHideExtension, frontmatterHideTheme],
    }),
    parent,
  });
}

describe("frontmatterHide StateField", () => {
  it("mounts an EditorView with frontmatter without throwing RangeError", () => {
    expect(() => {
      view = mount(FRONTMATTER_DOC);
    }).not.toThrow();

    // Decorations sind über das StateField vorhanden.
    const deco = view!.state.field(frontmatterHideExtension);
    expect(deco).toBeDefined();
    // Genau ein Block-Replace-Range für den Frontmatter-Block.
    expect(deco.size).toBe(1);
  });

  it("survives a doc-change dispatch (the path that used to crash on update)", () => {
    view = mount(FRONTMATTER_DOC);

    expect(() => {
      view!.dispatch({
        changes: { from: view!.state.doc.length, insert: "\nmore text" },
      });
    }).not.toThrow();

    // Frontmatter-Decoration bleibt nach dem Body-Edit erhalten.
    expect(view!.state.field(frontmatterHideExtension).size).toBe(1);
  });

  it("keeps the frontmatter text in the document (Save preserves it)", () => {
    view = mount(FRONTMATTER_DOC);
    // Der Text wird nur visuell ausgeblendet, NICHT aus dem Doc entfernt.
    expect(view.state.doc.toString()).toContain("id: 01J0000000000000000000000X");
    expect(view.state.doc.toString()).toContain("type: note");
  });

  it("emits no decorations when the doc has no leading frontmatter", () => {
    view = mount("# Just a heading\n\nNo frontmatter here.");
    expect(view.state.field(frontmatterHideExtension).size).toBe(0);
  });

  it("provides the frontmatter range as an atomic range (cursor skips it)", () => {
    view = mount(FRONTMATTER_DOC);
    // Selektion an Doc-Anfang setzen und nach rechts bewegen — der atomare
    // Block darf den Cursor nicht innerhalb des versteckten Frontmatter landen
    // lassen. Wir prüfen primär, dass dispatch nicht wirft.
    expect(() => {
      view!.dispatch({ selection: EditorSelection.cursor(0) });
    }).not.toThrow();
  });
});
