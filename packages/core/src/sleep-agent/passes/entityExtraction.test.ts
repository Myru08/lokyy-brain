import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regressionstest für den `entity-extraction`-Pass (Issue #53).
 *
 * DER BUG: Der NER-Aufruf lief mit fixem `maxTokens: 1000`. Der Prompt
 * verlangte pro Entity ein `contextSnippet` von ~100 Zeichen, also brach die
 * Antwort bei 8–10 Entities mitten im JSON-Objekt ab — Ollama meldete
 * `done_reason: "length"`, das schließende `]` fehlte. `tryParseJsonArray`
 * matcht mit `/\[[\s\S]*\]/`, findet ohne `]` nichts und liefert `null`. Der
 * Aufrufer machte daraus ein stummes `errors++; continue;`. Im REM-Lauf stand
 * dann `"errors": 6, "processed": 12` — OHNE eine einzige Logzeile.
 *
 * WAS DIESER TEST FESTNAGELT:
 *   1. Ein `finishReason: "length"` mit abgeschnittenem JSON erzeugt eine
 *      eigene, als Abschneiden erkennbare Logzeile MIT Notiz-ID und wird in
 *      `notes` getrennt von gewöhnlichen Parse-Fehlern ausgewiesen.
 *   2. Ein `finishReason: "stop"` mit Müll zählt als Parse-Fehler — nicht als
 *      Abschneiden. Die beiden Ursachen bleiben unterscheidbar.
 *   3. Der Erfolgsfall extrahiert weiterhin Entities.
 *   4. Das Token-Budget ist nicht mehr fix, sondern wächst mit der Textlänge.
 *
 * Der Test kommt ohne Datenbank, ohne Vault und ohne LLM aus: Notizen,
 * Provider und DB sind Doppelgänger, der Pass selbst läuft echt.
 */

/** Kettbares No-op für die Drizzle-Aufrufe der Kandidaten-Auswahl. */
function chainable<T>(result: T) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "limit", "values", "set", "returning"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (v: T) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

// Kandidaten-Probe: 0 Mentions → jede Notiz ist Kandidat (Cold-Start).
const fakeDb = {
  select: () => chainable([{ count: 0 }]),
  insert: () => chainable(undefined),
  update: () => chainable(undefined),
  execute: async () => [] as unknown[],
};

vi.mock("../../db/index.js", () => ({
  database: () => fakeDb,
  indexDatabase: () => fakeDb,
}));

const VALID_TYPES = new Set([
  "person",
  "organization",
  "location",
  "concept",
  "date",
  "event",
]);

/** Alles, was `upsertEntity` in diesem Lauf gesehen hat. */
const upserted: Array<{ displayName: string; type: string; contextSnippet: string; noteId: string }> =
  [];

vi.mock("../../entities/index.js", () => ({
  isEntityType: (t: string) => VALID_TYPES.has(t),
  upsertEntity: async (
    ex: { displayName: string; type: string; contextSnippet: string },
    noteId: string,
  ) => {
    upserted.push({ ...ex, noteId });
    return { id: "01KZ0000000000000000000000" };
  },
}));

const NOTE_BODY = `---
id: 01KZBAG4FD0YFQSPCGTW57ZGQV
type: note
title: Lokyy Brain Architektur
created: 2026-06-01T10:00:00.000Z
updated: 2026-06-17T08:00:00.000Z
---

Oliver Hees hat lokyy-brain als Single Source of Truth aufgesetzt.
Die Speicherschicht liegt bei Forgejo, der Sleep-Agent räumt nachts auf.
`;

vi.mock("../../notes/notesService.js", () => ({
  listNotes: async () => [
    {
      id: "10_projects/lokyy/architektur",
      path: "10_projects/lokyy/architektur.md",
      title: "Lokyy Brain Architektur",
      tags: [],
      links: [],
      aliases: [],
      updatedAt: "2026-06-17T08:00:00.000Z",
    },
  ],
  getNote: async (id: string) => ({
    id,
    path: `${id}.md`,
    title: "Lokyy Brain Architektur",
    body: NOTE_BODY,
    tags: [],
    links: [],
    aliases: [],
    updatedAt: "2026-06-17T08:00:00.000Z",
  }),
}));

vi.mock("../../llm/configStore.js", () => ({
  getLlmRouting: async () => ({
    roles: { ner: { provider: "ollama" } },
    privacyTier: "cloud_ok" as const,
  }),
}));

/** Was der gefälschte Provider bei `chat()` zurückgibt — pro Test gesetzt. */
let chatResponse: {
  text: string;
  finishReason: "stop" | "length" | "tool_use" | "error";
};

/** `maxTokens`, mit dem der Pass den Provider tatsächlich gerufen hat. */
let seenMaxTokens: number | undefined;

const fakeProvider = {
  info: { name: "ollama", isLocal: true, capabilities: {} },
  chat: async (_messages: unknown, opts?: { maxTokens?: number }) => {
    seenMaxTokens = opts?.maxTokens;
    return {
      text: chatResponse.text,
      usage: { inputTokens: 400, outputTokens: seenMaxTokens ?? 0 },
      model: "llama3.1:8b",
      finishReason: chatResponse.finishReason,
    };
  },
  testConnection: async () => ({ ok: true }),
};

/**
 * Die `ner`-Provider-Kette. Pro Test setzbar: eine LEERE Kette ist der Fall
 * „kein NER-Provider konfiguriert" — ein Fehler, der zu keiner einzelnen Notiz
 * gehört (siehe Sentinel-Konvention, #58).
 */
let nerChain: unknown[] = [];

vi.mock("../../llm/router.js", () => ({
  LlmRouter: class {
    getProviderChain() {
      return nerChain;
    }
    getProvider() {
      return fakeProvider;
    }
  },
  routeContextFromNote: () => ({}),
}));

const { entityExtractionPass, nerTokenBudget, deriveSnippet } = await import(
  "./entityExtraction.js"
);
const { isPassScoped, PASS_SCOPE_NOTE_ID } = await import("../errorSamples.js");

import type { SleepRun } from "../types.js";

function makeRun(): SleepRun {
  return {
    id: "01KZBAG4FD0YFQSPCGTW57ZGQW",
    phase: "rem",
    trigger: "nightly",
    status: "running",
    startedAt: new Date("2026-06-17T02:00:00.000Z"),
    passesCompleted: [],
    passStats: {},
    notesProcessed: 0,
  };
}

/**
 * Exakt die Antwortform, die der Beta-Tester gegen Ollama reproduziert hat:
 * `done_reason: length`, Abbruch mitten im letzten Objekt, kein `]`.
 */
const TRUNCATED_JSON = `[
  {"displayName": "Oliver Hees", "type": "person", "confidence": 0.95},
  {"displayName": "Forgejo", "type": "organization", "confidence": 0.9},
  {"displayName": "lokyy-brain", "`;

const VALID_JSON = `[
  {"displayName": "Oliver Hees", "type": "person", "confidence": 0.95},
  {"displayName": "Forgejo", "type": "organization", "confidence": 0.88}
]`;

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  upserted.length = 0;
  seenMaxTokens = undefined;
  nerChain = [fakeProvider];
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** Alle Warn-Zeilen dieses Laufs als einzelne Strings. */
function warnLines(): string[] {
  return warnSpy.mock.calls.map((call) => call.map(String).join(" "));
}

describe("entity-extraction — Abbruch am Token-Limit (#53)", () => {
  it("meldet einen `length`-Abbruch mit eigener Logzeile inklusive Notiz-ID", async () => {
    chatResponse = { text: TRUNCATED_JSON, finishReason: "length" };

    const result = await entityExtractionPass.run(makeRun());

    // Vor dem Fix: errors=1, processed=0 — und KEINE Logzeile.
    const truncationLog = warnLines().find((l) => /token ceiling|finishReason=length/.test(l));
    expect(truncationLog).toBeDefined();
    expect(truncationLog).toContain("10_projects/lokyy/architektur");
    expect(result.errors).toBe(1);
  });

  it("führt `length`-Abbrüche getrennt von Parse-Fehlern in der Statistik", async () => {
    chatResponse = { text: TRUNCATED_JSON, finishReason: "length" };

    const result = await entityExtractionPass.run(makeRun());

    expect(result.notes).toMatch(/truncated/);
    expect(result.notes).not.toMatch(/unparseable/);
  });
});

describe("entity-extraction — gewöhnlicher Parse-Fehler", () => {
  it("zählt Müll bei `finishReason: stop` als Parse-Fehler, nicht als Abbruch", async () => {
    chatResponse = {
      text: "Ich habe leider keine Entitäten gefunden. Soll ich es erneut versuchen?",
      finishReason: "stop",
    };

    const result = await entityExtractionPass.run(makeRun());

    expect(result.errors).toBe(1);
    expect(result.notes).toMatch(/unparseable/);
    expect(result.notes).not.toMatch(/truncated/);

    const lines = warnLines();
    expect(lines.some((l) => l.includes("no parseable JSON array"))).toBe(true);
    expect(lines.some((l) => /token ceiling/.test(l))).toBe(false);
  });
});

describe("entity-extraction — Erfolgsfall", () => {
  it("extrahiert Entities und meldet keine Fehler", async () => {
    chatResponse = { text: VALID_JSON, finishReason: "stop" };

    const result = await entityExtractionPass.run(makeRun());

    expect(result.errors).toBe(0);
    expect(result.processed).toBe(1);
    expect(upserted.map((e) => e.displayName)).toEqual(["Oliver Hees", "Forgejo"]);
    expect(result.notes).toContain("2 entity-mentions");
    expect(warnLines()).toHaveLength(0);
  });

  it("leitet den contextSnippet lokal aus dem Notiztext ab (Prompt liefert keinen mehr)", async () => {
    chatResponse = { text: VALID_JSON, finishReason: "stop" };

    await entityExtractionPass.run(makeRun());

    const oliver = upserted.find((e) => e.displayName === "Oliver Hees");
    expect(oliver?.contextSnippet).toContain("Oliver Hees");
    expect(oliver?.contextSnippet).toContain("Single Source of Truth");
    // Frontmatter gehört nicht in den Snippet — er kommt aus dem Body.
    expect(oliver?.contextSnippet).not.toContain("created:");
  });
});

/**
 * Issue #58 — aus dem Zähler wird ein Diagnosekanal.
 *
 * #53 wurde für DIESEN Pass mit Logzeilen gelöst; Logzeilen liegen aber im
 * Container-Log und nicht im Nacht-Protokoll. Dieselbe Information steht jetzt
 * strukturiert in `pass_stats` — pro Fehler die Notiz und der Grund, und für
 * pass-weite Fehler der Sentinel statt einer erfundenen ID.
 */
describe("entity-extraction — errorSamples (#58)", () => {
  it("nennt beim Token-Abbruch Notiz-ID und Ursache", async () => {
    chatResponse = { text: TRUNCATED_JSON, finishReason: "length" };

    const result = await entityExtractionPass.run(makeRun());

    expect(result.errorSamples).toHaveLength(1);
    expect(result.errorSamples[0].noteId).toBe("10_projects/lokyy/architektur");
    expect(result.errorSamples[0].reason).toMatch(/truncated/);
    expect(isPassScoped(result.errorSamples[0])).toBe(false);
  });

  it("unterscheidet den Parse-Fehler im Grund vom Abbruch", async () => {
    chatResponse = { text: "Keine Entitäten gefunden.", finishReason: "stop" };

    const result = await entityExtractionPass.run(makeRun());

    expect(result.errorSamples[0].reason).toMatch(/unparseable/);
    expect(result.errorSamples[0].reason).not.toMatch(/truncated/);
  });

  it("meldet einen fehlenden NER-Provider pass-weit statt gegen eine Notiz", async () => {
    nerChain = [];

    const result = await entityExtractionPass.run(makeRun());

    expect(result.errors).toBe(1);
    expect(result.errorSamples).toHaveLength(1);
    // KEINE erfundene Notiz-ID — der Sentinel sagt „gehört zum Pass".
    expect(isPassScoped(result.errorSamples[0])).toBe(true);
    expect(result.errorSamples[0].noteId).toBe(PASS_SCOPE_NOTE_ID);
    expect(result.errorSamples[0].reason).toBe("no ner provider configured");
  });

  it("hält `notes` und Stichprobe widerspruchsfrei: Kategorie oben, Instanz unten", async () => {
    chatResponse = { text: TRUNCATED_JSON, finishReason: "length" };

    const result = await entityExtractionPass.run(makeRun());

    // `notes` zählt die KATEGORIE, die Stichprobe nennt den FALL. Keine
    // Notiz-ID in `notes`, keine Aggregatzahl in der Stichprobe.
    expect(result.notes).toMatch(/1 truncated/);
    expect(result.notes).not.toContain("10_projects/lokyy/architektur");
    expect(result.errorSamples[0].reason).not.toMatch(/^\d+ /);
  });

  it("liefert im Erfolgsfall eine leere Stichprobe", async () => {
    chatResponse = { text: VALID_JSON, finishReason: "stop" };

    const result = await entityExtractionPass.run(makeRun());

    expect(result.errorSamples).toEqual([]);
  });
});

describe("nerTokenBudget", () => {
  it("wächst mit der Textlänge statt fix bei 1000 zu stehen", () => {
    expect(nerTokenBudget(4000)).toBeGreaterThan(1000);
    expect(nerTokenBudget(4000)).toBeGreaterThan(nerTokenBudget(500));
  });

  it("behält einen harten Deckel — die Ausgabelänge wächst nicht unbegrenzt", () => {
    expect(nerTokenBudget(1_000_000)).toBeLessThanOrEqual(2000);
    expect(nerTokenBudget(0)).toBeGreaterThanOrEqual(600);
  });

  it("wird vom Pass tatsächlich benutzt (kein fixes maxTokens mehr)", async () => {
    chatResponse = { text: VALID_JSON, finishReason: "stop" };

    await entityExtractionPass.run(makeRun());

    // Der Body der Testnotiz ist kurz → Untergrenze greift.
    expect(seenMaxTokens).toBe(nerTokenBudget(NOTE_BODY.length));
    expect(seenMaxTokens).not.toBe(1000);
  });
});

describe("deriveSnippet", () => {
  it("schneidet ein Fenster um die erste Fundstelle", () => {
    const text = "Am Anfang. Oliver Hees baute lokyy-brain. Danach kam Forgejo.";
    expect(deriveSnippet(text, "lokyy-brain")).toContain("lokyy-brain");
    expect(deriveSnippet(text, "lokyy-brain")).toContain("Oliver Hees");
  });

  it("liefert leeren String, wenn der Name nicht im Text steht", () => {
    expect(deriveSnippet("Ein Text ohne Treffer.", "Nicht Vorhanden")).toBe("");
    expect(deriveSnippet("egal", "   ")).toBe("");
  });
});
