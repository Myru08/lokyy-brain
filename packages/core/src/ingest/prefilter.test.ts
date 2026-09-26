import { describe, expect, it } from "vitest";

import {
  contrastSignals,
  prefilter,
  MAX_LINK_PROPOSALS,
  type CandidateNote,
} from "./prefilter.js";

/**
 * Issue #67 — der Vorfilter entscheidet, ob überhaupt gefragt wird.
 *
 * Er ist die einzige Bremse zwischen einem Import und einem LLM-Aufruf, und im
 * Import-Pfad wartet der Nutzer. Geprüft wird deshalb genau das: WANN ein
 * Kandidat entsteht — und dass ohne Kontrast-Signal keiner entsteht.
 */

function note(
  id: string,
  tags: string[] = [],
  links: string[] = [],
  title = id,
): CandidateNote {
  return { id, title, tags, links };
}

describe("Kontrast-Signale", () => {
  it("erkennt deutsche und englische Signale", () => {
    expect(contrastSignals("A im Gegensatz zu B")).toContain("im gegensatz");
    expect(contrastSignals("Redis vs. Postgres")).toContain("vs");
    expect(contrastSignals("Unlike the old setup")).toContain("unlike");
    expect(contrastSignals("Das widerspricht der Annahme")).toContain(
      "widerspricht",
    );
  });

  it("findet in neutralem Text nichts", () => {
    expect(contrastSignals("Eine ruhige Notiz ohne jede Gegenrede.")).toEqual(
      [],
    );
  });

  it("stolpert nicht über Teilwörter", () => {
    // „universal" enthält „vs" nicht als Wort, „entgegennehmen" nicht „entgegen der".
    expect(contrastSignals("universal, entgegennehmen, however-ish")).toEqual([
      "however",
    ]);
  });
});

describe("Vorfilter", () => {
  const notes = [
    note("50_decisions/postgres", ["db", "arch"], []),
    note("10_projects/anderes", ["kochen"], []),
  ];

  it("erzeugt OHNE Kontrast-Signal keinen Judge-Kandidaten", () => {
    const r = prefilter({
      sourceNoteId: "30_captures/urls/neu",
      sourceTitle: "Neu",
      sourceBody: "Wir nutzen Postgres. #db #arch",
      sourceTags: ["db", "arch"],
      sourceLinks: [],
      notes,
    });

    expect(r.signals).toEqual([]);
    expect(r.judgeHits).toEqual([]);
  });

  it("erzeugt mit Kontrast-Signal UND 2 gemeinsamen Tags einen Kandidaten", () => {
    const r = prefilter({
      sourceNoteId: "30_captures/urls/neu",
      sourceTitle: "Neu",
      sourceBody: "Redis vs. Postgres — wir wechseln. #db #arch",
      sourceTags: ["db", "arch"],
      sourceLinks: [],
      notes,
    });

    expect(r.judgeHits).toHaveLength(1);
    expect(r.judgeHits[0]?.noteId).toBe("50_decisions/postgres");
    expect(r.judgeHits[0]?.sharedTags).toEqual(["db", "arch"]);
  });

  it("verlangt mehr als einen gemeinsamen Tag", () => {
    const r = prefilter({
      sourceNoteId: "neu",
      sourceTitle: "Neu",
      sourceBody: "Anders als bisher. #db",
      sourceTags: ["db"],
      sourceLinks: [],
      notes,
    });

    expect(r.signals.length).toBeGreaterThan(0);
    expect(r.judgeHits).toEqual([]);
  });

  it("macht aus einem Wikilink ohne Rückverweis einen link-Vorschlag — ohne Signal", () => {
    const r = prefilter({
      sourceNoteId: "30_captures/urls/neu",
      sourceTitle: "Neu",
      sourceBody: "Siehe [[50_decisions/postgres]].",
      sourceTags: [],
      sourceLinks: ["50_decisions/postgres"],
      notes,
    });

    expect(r.linkHits.map((h) => h.noteId)).toEqual(["50_decisions/postgres"]);
    // Ohne Kontrast-Signal bleibt der Judge außen vor.
    expect(r.judgeHits).toEqual([]);
  });

  it("schlägt keinen Rückverweis vor, wenn er schon existiert", () => {
    const r = prefilter({
      sourceNoteId: "30_captures/urls/neu",
      sourceTitle: "Neu",
      sourceBody: "Siehe [[50_decisions/postgres]].",
      sourceTags: [],
      sourceLinks: ["50_decisions/postgres"],
      notes: [
        note("50_decisions/postgres", [], ["30_captures/urls/neu"]),
      ],
    });

    expect(r.linkHits).toEqual([]);
  });

  it("löst Wikilinks auch über den Titel auf", () => {
    const r = prefilter({
      sourceNoteId: "neu",
      sourceTitle: "Neu",
      sourceBody: "Siehe [[Postgres-Entscheidung]].",
      sourceTags: [],
      sourceLinks: ["Postgres-Entscheidung"],
      notes: [note("50_decisions/postgres", [], [], "Postgres-Entscheidung")],
    });

    expect(r.linkHits).toHaveLength(1);
  });

  it("deckelt die link-Vorschläge", () => {
    const many = Array.from({ length: MAX_LINK_PROPOSALS + 4 }, (_, i) =>
      note(`n${i}`),
    );
    const r = prefilter({
      sourceNoteId: "neu",
      sourceTitle: "Neu",
      sourceBody: many.map((n) => `[[${n.id}]]`).join(" "),
      sourceTags: [],
      sourceLinks: many.map((n) => n.id),
      notes: many,
    });

    expect(r.linkHits).toHaveLength(MAX_LINK_PROPOSALS);
  });

  it("sortiert Wikilink-Kandidaten vor reine Tag-Kandidaten", () => {
    const r = prefilter({
      sourceNoteId: "neu",
      sourceTitle: "Neu",
      sourceBody: "Im Gegensatz dazu: [[b]] #x #y",
      sourceTags: ["x", "y"],
      sourceLinks: ["b"],
      notes: [note("a", ["x", "y"]), note("b", [])],
    });

    expect(r.judgeHits.map((h) => h.noteId)).toEqual(["b", "a"]);
  });

  it("nimmt die Quellnotiz selbst nie als Kandidat", () => {
    const r = prefilter({
      sourceNoteId: "a",
      sourceTitle: "A",
      sourceBody: "Im Gegensatz zu allem. #x #y",
      sourceTags: ["x", "y"],
      sourceLinks: ["a"],
      notes: [note("a", ["x", "y"])],
    });

    expect(r.judgeHits).toEqual([]);
    expect(r.linkHits).toEqual([]);
  });
});
