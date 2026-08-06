import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatRunStart,
  toProtocolEntries,
  type SleepRunDto,
} from "./sleepAgentProtocol.js";

/**
 * Datenaufbereitung der Nacht-Protokoll-Ansicht (Story C1).
 *
 * Getestet wird die REINE Übersetzungsschicht: Server-Rohdaten
 * (`/api/sleep-agent/runs`) → deutschsprachige, nicht-technische
 * Anzeige-Objekte. Genau hier bricht die Ansicht, wenn der Server ein Feld
 * umbenennt, `passStats` eine unbekannte Form hat oder ein Lauf noch läuft —
 * deshalb liegt die Logik in einer eigenen, testbaren Datei und nicht im TSX.
 */

/** Minimal-Lauf, den einzelne Tests punktuell überschreiben. */
function run(over: Partial<SleepRunDto> = {}): SleepRunDto {
  return {
    id: "01JRUN0000000000000000001",
    phase: "nrem",
    trigger: "nightly",
    status: "completed",
    startedAt: "2026-08-05T01:00:00.000Z",
    finishedAt: "2026-08-05T01:02:30.000Z",
    passesCompleted: ["importance-recompute"],
    passStats: { "importance-recompute": { processed: 12, errors: 0 } },
    notesProcessed: 12,
    ...over,
  };
}

describe("toProtocolEntries", () => {
  it("übersetzt einen Lauf in deutsche, nicht-technische Anzeige-Felder", () => {
    const [entry] = toProtocolEntries([run()]);

    expect(entry.id).toBe("01JRUN0000000000000000001");
    expect(entry.statusLabel).toBe("Fertig");
    expect(entry.statusTone).toBe("ok");
    expect(entry.phaseLabel).toBe("Tiefschlaf");
    expect(entry.triggerLabel).toBe("Nachtlauf");
    expect(entry.notesProcessed).toBe(12);
    expect(entry.durationLabel).toBe("2 Minuten 30 Sekunden");
  });

  it("übersetzt jeden Arbeitsschritt in Klartext statt Pass-Namen", () => {
    const [entry] = toProtocolEntries([
      run({
        passesCompleted: ["karpathy-lint", "peer-profile-update"],
        passStats: {
          "karpathy-lint": { processed: 3, errors: 0, notes: "5 findings" },
          "peer-profile-update": { processed: 2, errors: 0 },
        },
      }),
    ]);

    const labels = entry.actions.map((a) => a.label);
    expect(labels).toEqual([
      "Vault auf Lücken und Widersprüche geprüft",
      "Personen-Profile aktualisiert",
    ]);
    // Der technische Name bleibt für Diagnosezwecke erhalten, wird aber
    // nicht als Überschrift verwendet.
    expect(entry.actions[0].passName).toBe("karpathy-lint");
    expect(entry.actions[0].processed).toBe(3);
  });

  it("kennzeichnet unbekannte Arbeitsschritte lesbar statt sie zu verschlucken", () => {
    const [entry] = toProtocolEntries([
      run({
        passesCompleted: ["brandneuer-pass"],
        passStats: { "brandneuer-pass": { processed: 1, errors: 0 } },
      }),
    ]);

    expect(entry.actions).toHaveLength(1);
    expect(entry.actions[0].label).toBe("Arbeitsschritt „brandneuer-pass“");
  });

  it("markiert einen fehlgeschlagenen Arbeitsschritt, ohne den Lauf zu verlieren", () => {
    const [entry] = toProtocolEntries([
      run({
        passesCompleted: ["importance-recompute"],
        passStats: {
          "importance-recompute": { processed: 4, errors: 0 },
          "topic-synthesis": { error: "no chat provider" },
        },
      }),
    ]);

    const failed = entry.actions.find((a) => a.passName === "topic-synthesis");
    expect(failed?.failed).toBe(true);
    expect(failed?.errorMessage).toBe("no chat provider");
    expect(entry.actions).toHaveLength(2);
  });

  it("sortiert neueste Läufe zuerst, unabhängig von der Server-Reihenfolge", () => {
    const older = run({ id: "alt", startedAt: "2026-08-01T01:00:00.000Z" });
    const newer = run({ id: "neu", startedAt: "2026-08-05T01:00:00.000Z" });

    expect(toProtocolEntries([older, newer]).map((e) => e.id)).toEqual([
      "neu",
      "alt",
    ]);
  });

  it("kommt mit einem noch laufenden Lauf klar (kein finishedAt)", () => {
    const [entry] = toProtocolEntries([
      run({ status: "running", finishedAt: null }),
    ]);

    expect(entry.statusLabel).toBe("Läuft gerade");
    expect(entry.statusTone).toBe("warn");
    expect(entry.durationLabel).toBe("läuft noch");
    expect(entry.durationMs).toBeNull();
  });

  it("zeigt bei einem gescheiterten Lauf Status und Fehlertext", () => {
    const [entry] = toProtocolEntries([
      run({ status: "failed", errorMessage: "Datenbank nicht erreichbar" }),
    ]);

    expect(entry.statusLabel).toBe("Fehlgeschlagen");
    expect(entry.statusTone).toBe("err");
    expect(entry.errorMessage).toBe("Datenbank nicht erreichbar");
  });

  it("überlebt lückenhafte Server-Daten ohne zu werfen", () => {
    const broken = {
      id: "kaputt",
      startedAt: "nicht-datierbar",
    } as unknown as SleepRunDto;

    const [entry] = toProtocolEntries([broken]);
    expect(entry.id).toBe("kaputt");
    expect(entry.actions).toEqual([]);
    expect(entry.notesProcessed).toBe(0);
    expect(entry.startedAtLabel).toBe("Zeitpunkt unbekannt");
    expect(entry.statusLabel).toBe("Unbekannt");
  });

  it("fasst den Lauf in einem Satz zusammen", () => {
    const [entry] = toProtocolEntries([
      run({
        notesProcessed: 1,
        passesCompleted: ["importance-recompute"],
        passStats: { "importance-recompute": { processed: 1, errors: 0 } },
      }),
    ]);
    expect(entry.summary).toBe("1 Notiz bearbeitet · 1 Arbeitsschritt");

    const [many] = toProtocolEntries([
      run({
        notesProcessed: 12,
        passesCompleted: ["importance-recompute", "karpathy-lint"],
        passStats: {
          "importance-recompute": { processed: 8, errors: 0 },
          "karpathy-lint": { processed: 4, errors: 0 },
        },
      }),
    ]);
    expect(many.summary).toBe("12 Notizen bearbeitet · 2 Arbeitsschritte");
  });

  it("sagt es deutlich, wenn nichts zu tun war", () => {
    const [entry] = toProtocolEntries([
      run({ notesProcessed: 0, passesCompleted: [], passStats: {} }),
    ]);
    expect(entry.summary).toBe("Nichts zu tun — der Vault war schon aufgeräumt");
  });
});

describe("berührte Notizen", () => {
  it("liest Notiz-Listen aus den Schritt-Daten, wenn der Server welche liefert", () => {
    const [entry] = toProtocolEntries([
      run({
        passesCompleted: ["topic-synthesis"],
        passStats: {
          "topic-synthesis": {
            processed: 2,
            errors: 0,
            notePaths: [
              "20_topics/ki-agenten.md",
              { id: "01JNOTE000000000000000001", title: "Vault-Aufbau" },
            ],
          },
        },
      }),
    ]);

    expect(entry.touchedNotes).toEqual([
      { id: "20_topics/ki-agenten.md", label: "ki-agenten" },
      { id: "01JNOTE000000000000000001", label: "Vault-Aufbau" },
    ]);
    expect(entry.touchedNotesKnown).toBe(true);
  });

  it("meldet ehrlich, wenn der Server keine Notiz-Liste mitliefert", () => {
    const [entry] = toProtocolEntries([run()]);
    expect(entry.touchedNotes).toEqual([]);
    expect(entry.touchedNotesKnown).toBe(false);
  });

  it("entdoppelt Notizen über mehrere Arbeitsschritte hinweg", () => {
    const [entry] = toProtocolEntries([
      run({
        passesCompleted: ["karpathy-lint", "entity-extraction"],
        passStats: {
          "karpathy-lint": { processed: 1, errors: 0, notePaths: ["a/x.md"] },
          "entity-extraction": {
            processed: 2,
            errors: 0,
            notes: ["a/x.md", "b/y.md"],
          },
        },
      }),
    ]);

    expect(entry.touchedNotes.map((n) => n.id)).toEqual(["a/x.md", "b/y.md"]);
  });

  it("verwechselt den Freitext-Kommentar `notes` nicht mit einer Notiz-Liste", () => {
    const [entry] = toProtocolEntries([
      run({
        passesCompleted: ["synaptic-pruning"],
        passStats: {
          "synaptic-pruning": {
            processed: 5,
            errors: 0,
            notes: "3 demoted, 1 pruned to graveyard",
          },
        },
      }),
    ]);

    expect(entry.touchedNotes).toEqual([]);
    expect(entry.actions[0].detail).toBe("3 demoted, 1 pruned to graveyard");
  });
});

describe("formatDuration", () => {
  it("formatiert Sekunden, Minuten und Stunden auf Deutsch", () => {
    expect(formatDuration(400)).toBe("unter 1 Sekunde");
    expect(formatDuration(1_000)).toBe("1 Sekunde");
    expect(formatDuration(45_000)).toBe("45 Sekunden");
    expect(formatDuration(60_000)).toBe("1 Minute");
    expect(formatDuration(150_000)).toBe("2 Minuten 30 Sekunden");
    expect(formatDuration(3_600_000)).toBe("1 Stunde");
    expect(formatDuration(3_930_000)).toBe("1 Stunde 5 Minuten");
  });

  it("liefert für unbekannte Dauer einen sprechenden Platzhalter", () => {
    expect(formatDuration(null)).toBe("läuft noch");
    expect(formatDuration(-5)).toBe("unter 1 Sekunde");
  });
});

describe("formatRunStart", () => {
  const now = new Date("2026-08-05T09:00:00.000Z");

  it("sagt „Heute“ und „Gestern“ statt eines Datums", () => {
    expect(formatRunStart(new Date("2026-08-05T01:05:00.000Z"), now)).toMatch(
      /^Heute, \d{2}:\d{2} Uhr$/,
    );
    expect(formatRunStart(new Date("2026-08-04T01:05:00.000Z"), now)).toMatch(
      /^Gestern, \d{2}:\d{2} Uhr$/,
    );
  });

  it("nennt bei älteren Läufen das volle Datum", () => {
    expect(formatRunStart(new Date("2026-07-30T01:05:00.000Z"), now)).toMatch(
      /^30\.07\.2026, \d{2}:\d{2} Uhr$/,
    );
  });

  it("bleibt bei fehlendem Zeitpunkt sprechend", () => {
    expect(formatRunStart(null, now)).toBe("Zeitpunkt unbekannt");
  });
});
