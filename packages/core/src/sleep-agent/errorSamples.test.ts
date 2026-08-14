import { describe, expect, it } from "vitest";

import {
  MAX_ERROR_SAMPLES,
  MAX_REASON_CHARS,
  PASS_SCOPE_NOTE_ID,
  createPassErrorLog,
  errorSamplesTruncated,
  isPassScoped,
} from "./errorSamples.js";

/**
 * Issue #58 — der Fehlerkanal der Sleep-Passes war rein numerisch.
 *
 * `errors++` erfüllte den Vertrag vollständig; eine Logzeile mit Notiz-ID und
 * Grund war ein freiwilliger Zusatz. Über alle Passes: 23 Zählstellen, 6
 * Logzeilen. Ein Betreiber sah `errors: 7` und wusste nichts.
 *
 * Diese Datei nagelt das GEGENMITTEL fest, nicht bloß das Datenfeld: Der
 * Zähler ist kein `let errors = 0` mehr, sondern ein Protokoll-Objekt, dessen
 * EINZIGE Zählmethode `record(noteId, grund)` heißt. Hochzählen ohne Grund ist
 * damit nicht mehr formulierbar — der Anreiz ist umgedreht, statt nur
 * dokumentiert.
 *
 * Vier Eigenschaften müssen halten:
 *   1. Der Deckel greift — 5000 Fehler erzeugen nicht 5000 JSON-Einträge.
 *   2. Die Gesamtzahl bleibt trotz Deckel exakt (`errors` ist unverändert
 *      vergleichbar mit früheren Läufen — Abgrenzung aus #58).
 *   3. Pass-weite Fehler ohne Notiz-ID folgen der Sentinel-Konvention, statt
 *      eine falsche ID zu erfinden.
 *   4. Gründe werden gekappt, damit ein 5-MB-Stacktrace `pass_stats` nicht
 *      sprengt.
 */

describe("PassErrorLog — Deckelung", () => {
  it("nagelt die gewählte Obergrenze fest", () => {
    // Bewusst hart geprüft: die Zahl ist eine Entscheidung (Begründung im
    // jsdoc von MAX_ERROR_SAMPLES), keine Beliebigkeit. Wer sie ändert, ändert
    // die Größe jeder pass_stats-Zeile — das soll im Diff sichtbar werden.
    expect(MAX_ERROR_SAMPLES).toBe(20);
    expect(MAX_REASON_CHARS).toBe(200);
  });

  it("behält die ersten N Stichproben und verwirft den Rest", () => {
    const log = createPassErrorLog();

    for (let i = 0; i < 5000; i++) {
      log.record(`10_projects/note-${i}`, `Grund ${i}`);
    }

    expect(log.samples).toHaveLength(MAX_ERROR_SAMPLES);
    // ERSTE N, nicht letzte N: die frühen Fehler erklären die Kaskade, und
    // "erste N" ist reproduzierbar — ein Zufalls-Sample wäre es nicht.
    expect(log.samples[0].noteId).toBe("10_projects/note-0");
    expect(log.samples[MAX_ERROR_SAMPLES - 1].noteId).toBe(
      `10_projects/note-${MAX_ERROR_SAMPLES - 1}`,
    );
  });

  it("zählt trotz Deckel jeden Fehler — `errors` bleibt exakt", () => {
    const log = createPassErrorLog();

    for (let i = 0; i < 5000; i++) log.record(`n-${i}`, "kaputt");

    const result = log.result(0);
    expect(result.errors).toBe(5000);
    expect(result.errorSamples).toHaveLength(MAX_ERROR_SAMPLES);
    // Die Abschneidung ist am Ergebnis ABLESBAR — kein Extrafeld nötig.
    expect(errorSamplesTruncated(result)).toBe(true);
  });

  it("meldet keine Abschneidung, solange alle Fehler in die Stichprobe passen", () => {
    const log = createPassErrorLog();
    log.record("a", "kaputt");
    log.record("b", "auch kaputt");

    const result = log.result(3);
    expect(result.processed).toBe(3);
    expect(result.errors).toBe(2);
    expect(result.errorSamples).toHaveLength(2);
    expect(errorSamplesTruncated(result)).toBe(false);
  });

  it("kappt überlange Gründe statt einen Stacktrace zu persistieren", () => {
    const log = createPassErrorLog();
    log.record("a", "x".repeat(5000));

    expect(log.samples[0].reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
  });
});

describe("PassErrorLog — Grund aus beliebigem Wurf", () => {
  it("nimmt die Message eines Error statt `[object Object]`", () => {
    const log = createPassErrorLog();
    log.record("30_captures/x", new Error("Ollama nicht erreichbar"));

    expect(log.samples[0].reason).toBe("Ollama nicht erreichbar");
  });

  it("verträgt Nicht-Error-Würfe", () => {
    const log = createPassErrorLog();
    log.record("30_captures/x", { code: 500 });
    log.record("30_captures/y", null);

    expect(log.samples[0].reason.length).toBeGreaterThan(0);
    expect(log.samples[1].reason.length).toBeGreaterThan(0);
  });

  it("ersetzt einen leeren Grund durch einen benannten Platzhalter", () => {
    const log = createPassErrorLog();
    log.record("a", "   ");

    // Ein leerer Grund ist derselbe stille Fehler in neuem Gewand.
    expect(log.samples[0].reason).toBe("unspecified error");
  });
});

describe("PassErrorLog — Konvention für Fehler ohne Notiz-ID", () => {
  it("benutzt den Sentinel statt eine Notiz-ID zu erfinden", () => {
    const log = createPassErrorLog();
    log.recordPassScoped("no ner provider configured");

    expect(log.samples[0].noteId).toBe(PASS_SCOPE_NOTE_ID);
    expect(log.samples[0].reason).toBe("no ner provider configured");
    expect(isPassScoped(log.samples[0])).toBe(true);
  });

  it("wählt einen Sentinel, der keine gültige Notiz-ID sein kann", () => {
    // Notiz-IDs sind Vault-Pfade (`30_captures/foo`) oder ULIDs. Spitze
    // Klammern kommen in beidem nicht vor — kein Konsument kann den Sentinel
    // versehentlich als Notiz öffnen.
    expect(PASS_SCOPE_NOTE_ID).toMatch(/^<.+>$/);
  });

  it("hält notiz-bezogene Stichproben von pass-weiten auseinander", () => {
    const log = createPassErrorLog();
    log.record("10_projects/a", "Notiz kaputt");
    log.recordPassScoped("DB weg");

    expect(log.samples.filter(isPassScoped)).toHaveLength(1);
    expect(log.samples.filter((s) => !isPassScoped(s))).toHaveLength(1);
  });

  it("behandelt eine leere Notiz-ID wie einen pass-weiten Fehler", () => {
    // Sonst entstünde ein Sample mit `noteId: ""` — genau die falsche ID,
    // die die Konvention vermeiden soll.
    const log = createPassErrorLog();
    log.record("", "irgendwas");

    expect(log.samples[0].noteId).toBe(PASS_SCOPE_NOTE_ID);
  });
});

describe("PassErrorLog — Ergebnisbau", () => {
  it("liefert ein vollständiges SleepPassResult inklusive `notes`", () => {
    const log = createPassErrorLog();
    log.record("a", "kaputt");

    const result = log.result(7, "7 Notizen verarbeitet");

    expect(result).toEqual({
      processed: 7,
      errors: 1,
      errorSamples: [{ noteId: "a", reason: "kaputt" }],
      notes: "7 Notizen verarbeitet",
    });
  });

  it("lässt `notes` weg, wenn der Pass keine Zusammenfassung hat", () => {
    const result = createPassErrorLog().result(0);

    expect(result.errorSamples).toEqual([]);
    expect("notes" in result).toBe(false);
  });

  it("gibt bei jedem Aufruf eine eigene Kopie der Stichprobe heraus", () => {
    // `pass_stats` wird nach dem Lauf serialisiert; ein Konsument, der die
    // Liste sortiert, darf das Protokoll des Passes nicht verändern.
    const log = createPassErrorLog();
    log.record("a", "kaputt");

    const first = log.result(0);
    first.errorSamples.push({ noteId: "gefälscht", reason: "gefälscht" });

    expect(log.result(0).errorSamples).toHaveLength(1);
  });
});
