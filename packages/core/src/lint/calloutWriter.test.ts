import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Story „Widerspruchs-Warnkasten" (Paket B) / AC1 — Callout-Writer.
 *
 * Der Kasten wird als reiner Markdown-Block in die betroffene Notiz
 * geschrieben. Zwei Invarianten sind kritisch und deshalb hier festgenagelt:
 *
 *   1. IDEMPOTENZ — ein zweiter Lauf für dasselbe Finding darf KEINEN zweiten
 *      Kasten erzeugen. Der Anker (`<!-- lokyy-lint:<id> -->`) ist die
 *      Identität; beim Schreiben wird ein vorhandener Block mit derselben ID
 *      zuerst entfernt und dann neu gesetzt.
 *   2. FRONTMATTER UNANGETASTET — der Block landet NACH dem Frontmatter-Fence,
 *      niemals darin. Geschrieben wird ausschließlich über `saveNote`, damit
 *      `updated` über den SPEC-Pfad gesetzt wird und der Commit über
 *      gitService läuft.
 *
 * Die IO-Funktionen laufen gegen ein gemocktes notesService — hier wird die
 * Verdrahtung geprüft (welcher Text geht an saveNote), nicht Git.
 */

const getNote = vi.fn();
const saveNote = vi.fn();

vi.mock("../notes/notesService.js", () => ({
  getNote: (...args: unknown[]) => getNote(...args),
  saveNote: (...args: unknown[]) => saveNote(...args),
}));

const {
  buildCalloutBlock,
  insertCalloutBlock,
  stripCalloutBlock,
  hasCalloutBlock,
  excerptStatement,
  writeFindingCallout,
  removeFindingCallout,
} = await import("./calloutWriter.js");

const FINDING = {
  id: "01J0000000000000000000000X",
  kind: "contradiction",
  severity: "warning" as const,
  message: "Notes scheinen widersprüchlich: Preis unterscheidet sich.",
  statements: [
    { noteId: "10_projects/a", title: "Angebot A", text: "Der Preis ist 100 €." },
    { noteId: "10_projects/b", title: "Angebot B", text: "Der Preis ist 250 €." },
  ],
};

const DOC_WITH_FRONTMATTER = `---
id: 01JAAAAAAAAAAAAAAAAAAAAAAA
type: note
title: Angebot A
created: 2026-05-30
updated: 2026-05-30
---
# Angebot A

Der Preis ist 100 €.
`;

beforeEach(() => {
  getNote.mockReset();
  saveNote.mockReset();
});

describe("buildCalloutBlock", () => {
  it("wraps the block in an id-anchored comment pair", () => {
    const block = buildCalloutBlock(FINDING);
    expect(block.startsWith(`<!-- lokyy-lint:${FINDING.id} -->`)).toBe(true);
    expect(block.trimEnd().endsWith(`<!-- /lokyy-lint:${FINDING.id} -->`)).toBe(
      true,
    );
  });

  it("renders a warning callout carrying both statements and source wikilinks", () => {
    const block = buildCalloutBlock(FINDING);
    expect(block).toContain("> [!warning]");
    expect(block).toContain("Der Preis ist 100 €.");
    expect(block).toContain("Der Preis ist 250 €.");
    expect(block).toContain("[[10_projects/a|Angebot A]]");
    expect(block).toContain("[[10_projects/b|Angebot B]]");
  });

  it("states the repair rule so the box is not just deleted", () => {
    expect(buildCalloutBlock(FINDING)).toContain(
      "Quelle reparieren, nicht nur den Kasten löschen",
    );
  });

  it("prefixes every line of a multi-line statement with the quote marker", () => {
    const block = buildCalloutBlock({
      ...FINDING,
      statements: [
        { noteId: "n/a", title: "A", text: "Zeile eins\nZeile zwei" },
        { noteId: "n/b", title: "B", text: "Gegenteil" },
      ],
    });
    for (const line of block.split("\n")) {
      if (line.startsWith("<!--") || line === "") continue;
      expect(line.startsWith(">")).toBe(true);
    }
    expect(block).toContain("Zeile zwei");
  });

  it("uses [!danger] for error severity and [!info] for info severity", () => {
    expect(buildCalloutBlock({ ...FINDING, severity: "error" })).toContain(
      "> [!danger]",
    );
    expect(buildCalloutBlock({ ...FINDING, severity: "info" })).toContain(
      "> [!info]",
    );
  });
});

describe("insertCalloutBlock / stripCalloutBlock", () => {
  it("inserts the block after the frontmatter fence, never inside it", () => {
    const block = buildCalloutBlock(FINDING);
    const { text, changed } = insertCalloutBlock(
      DOC_WITH_FRONTMATTER,
      block,
      FINDING.id,
    );

    expect(changed).toBe(true);
    const lines = text.split("\n");
    // Frontmatter bleibt Zeile 1..6 unverändert.
    expect(lines[0]).toBe("---");
    expect(lines.slice(0, 7).join("\n")).toBe(
      DOC_WITH_FRONTMATTER.split("\n").slice(0, 7).join("\n"),
    );
    // Der Anker steht NACH dem schließenden Fence.
    const anchorLine = lines.findIndex((l) => l.includes("lokyy-lint:"));
    const closingFence = lines.indexOf("---", 1);
    expect(anchorLine).toBeGreaterThan(closingFence);
    // Der ursprüngliche Body ist noch da.
    expect(text).toContain("# Angebot A");
  });

  it("is idempotent — writing the same finding twice yields one block", () => {
    const block = buildCalloutBlock(FINDING);
    const once = insertCalloutBlock(DOC_WITH_FRONTMATTER, block, FINDING.id).text;
    const twice = insertCalloutBlock(once, block, FINDING.id).text;

    expect(twice).toBe(once);
    const openers = twice.split(`<!-- lokyy-lint:${FINDING.id} -->`).length - 1;
    expect(openers).toBe(1);
  });

  it("keeps a box of a DIFFERENT finding untouched", () => {
    const first = insertCalloutBlock(
      DOC_WITH_FRONTMATTER,
      buildCalloutBlock(FINDING),
      FINDING.id,
    ).text;
    const other = { ...FINDING, id: "01JZZZZZZZZZZZZZZZZZZZZZZZ" };
    const both = insertCalloutBlock(first, buildCalloutBlock(other), other.id).text;

    expect(hasCalloutBlock(both, FINDING.id)).toBe(true);
    expect(hasCalloutBlock(both, other.id)).toBe(true);
  });

  it("strips exactly the addressed block and restores the original text", () => {
    const block = buildCalloutBlock(FINDING);
    const withBox = insertCalloutBlock(DOC_WITH_FRONTMATTER, block, FINDING.id).text;
    const { text, changed } = stripCalloutBlock(withBox, FINDING.id);

    expect(changed).toBe(true);
    expect(hasCalloutBlock(text, FINDING.id)).toBe(false);
    expect(text).toBe(DOC_WITH_FRONTMATTER);
  });

  it("reports changed=false when the block is not present", () => {
    const { changed } = stripCalloutBlock(DOC_WITH_FRONTMATTER, FINDING.id);
    expect(changed).toBe(false);
  });

  it("prepends the block when the note has no frontmatter", () => {
    const doc = "# Titel\n\nText.\n";
    const { text } = insertCalloutBlock(doc, buildCalloutBlock(FINDING), FINDING.id);
    expect(text.startsWith(`<!-- lokyy-lint:${FINDING.id} -->`)).toBe(true);
    expect(text).toContain("# Titel");
  });
});

describe("excerptStatement", () => {
  it("skips frontmatter and headings and returns the first real sentence", () => {
    expect(excerptStatement(DOC_WITH_FRONTMATTER)).toBe("Der Preis ist 100 €.");
  });

  it("never quotes an existing warning box back into a new one", () => {
    const withBox = insertCalloutBlock(
      DOC_WITH_FRONTMATTER,
      buildCalloutBlock(FINDING),
      FINDING.id,
    ).text;
    const excerpt = excerptStatement(withBox);
    expect(excerpt).not.toContain("[!warning]");
    expect(excerpt).not.toContain("lokyy-lint:");
    expect(excerpt).toBe("Der Preis ist 100 €.");
  });

  it("truncates long bodies with an ellipsis", () => {
    const long = "x".repeat(500);
    const excerpt = excerptStatement(`---\nid: 1\n---\n${long}`, 80);
    expect(excerpt.length).toBeLessThanOrEqual(81);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("writeFindingCallout (IO)", () => {
  it("writes the box into every affected note via saveNote", async () => {
    getNote.mockImplementation(async (id: string) => ({
      id,
      body: DOC_WITH_FRONTMATTER,
    }));
    saveNote.mockResolvedValue({});

    const result = await writeFindingCallout(FINDING);

    expect(result.written).toEqual(["10_projects/a", "10_projects/b"]);
    expect(saveNote).toHaveBeenCalledTimes(2);
    const [id, body] = saveNote.mock.calls[0] as [string, string];
    expect(id).toBe("10_projects/a");
    expect(body).toContain(`<!-- lokyy-lint:${FINDING.id} -->`);
    // Frontmatter geht unverändert mit in den Save.
    expect(body).toContain("id: 01JAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("does not call saveNote a second time when the box is already there", async () => {
    const withBox = insertCalloutBlock(
      DOC_WITH_FRONTMATTER,
      buildCalloutBlock(FINDING),
      FINDING.id,
    ).text;
    getNote.mockImplementation(async (id: string) => ({ id, body: withBox }));
    saveNote.mockResolvedValue({});

    const result = await writeFindingCallout(FINDING);

    expect(saveNote).not.toHaveBeenCalled();
    expect(result.written).toEqual([]);
    expect(result.unchanged).toEqual(["10_projects/a", "10_projects/b"]);
  });

  it("reports missing notes instead of throwing", async () => {
    getNote.mockResolvedValue(null);
    const result = await writeFindingCallout(FINDING);
    expect(result.missing).toEqual(["10_projects/a", "10_projects/b"]);
    expect(saveNote).not.toHaveBeenCalled();
  });
});

describe("removeFindingCallout (IO)", () => {
  it("removes the box from each note that carries it", async () => {
    const withBox = insertCalloutBlock(
      DOC_WITH_FRONTMATTER,
      buildCalloutBlock(FINDING),
      FINDING.id,
    ).text;
    getNote.mockImplementation(async (id: string) => ({ id, body: withBox }));
    saveNote.mockResolvedValue({});

    const result = await removeFindingCallout(FINDING.id, [
      "10_projects/a",
      "10_projects/b",
    ]);

    expect(result.removed).toEqual(["10_projects/a", "10_projects/b"]);
    expect(saveNote).toHaveBeenCalledTimes(2);
    const [, body] = saveNote.mock.calls[0] as [string, string];
    expect(body).toBe(DOC_WITH_FRONTMATTER);
  });

  it("is a no-op for notes without the box", async () => {
    getNote.mockImplementation(async (id: string) => ({
      id,
      body: DOC_WITH_FRONTMATTER,
    }));
    const result = await removeFindingCallout(FINDING.id, ["10_projects/a"]);
    expect(saveNote).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
  });
});
