import { describe, it, expect } from "vitest";

// Der Core-Barrel zieht Module nach, die beim Laden eine DSN sehen wollen.
// Hier wird nie verbunden — der Test ist reine Listen-Arithmetik.
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

import { RENAMED_NOTE_REF_COLUMNS } from "@lokyy/core";

import { DERIVED_STORES } from "./derivedStoreOrphans.js";

/**
 * Die eine Regel, die diese beiden Listen zusammenhält.
 *
 * `derivedStoreOrphans.ts` MISST („Zeile ohne Datei"), `renameNoteReferences.ts`
 * PFLEGT („Zeile einem Move mitnehmen"). Beide beantworten dieselbe Frage —
 * welche Spalte hält eine kanonische Pfad-ID? — und beide müssen dieselben zwei
 * Spalten auslassen (`temporal_edges.to_note_id` hält Wikilink-Titel,
 * `mem0_review_queue.target_note_id` rohe LLM-Ausgabe).
 *
 * Driften die Listen auseinander, entsteht genau der Defekt, den beide Module
 * beheben sollen — nur leiser: eine Spalte, die gemessen aber nicht gepflegt
 * wird, meldet nach jedem Move Verwaisungen; eine, die gepflegt aber nicht
 * gemessen wird, verschleiert echte Karteileichen. Deshalb dieser Test statt
 * eines Kommentars „bitte beide anfassen".
 */
describe("Verwaisungs-Messung und Referenz-Nachzug prüfen dieselben Spalten", () => {
  it("deckt exakt dieselben Tabellen ab", () => {
    expect(DERIVED_STORES.map((s) => s.table).sort()).toEqual(
      Object.keys(RENAMED_NOTE_REF_COLUMNS).sort(),
    );
  });

  for (const store of DERIVED_STORES) {
    it(`${store.table}: geprüfte Spalten == nachgezogene Spalten`, () => {
      const measured = [
        ...store.columns,
        ...(store.arrayColumn ? [store.arrayColumn] : []),
      ].sort();
      const renamed = [...(RENAMED_NOTE_REF_COLUMNS[store.table] ?? [])].sort();
      expect(renamed).toEqual(measured);
    });

    if (store.excluded?.length) {
      it(`${store.table}: bewusst ausgelassene Spalten werden auch nicht umgeschrieben`, () => {
        const renamed = RENAMED_NOTE_REF_COLUMNS[store.table] ?? [];
        for (const ex of store.excluded!) {
          expect(renamed).not.toContain(ex.column);
        }
      });
    }
  }
});
