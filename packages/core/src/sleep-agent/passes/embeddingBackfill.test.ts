import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * issue #52 — Tier-2 Embedding-Backfill-Pass.
 *
 * DER BUG: Tier-2-Embeddings entstehen ausschließlich auf dem Speicherpfad
 * (`queueIndexRefresh` → `indexNote`, fire-and-forget). Jede Notiz, die
 * gespeichert wurde während Ollama nicht erreichbar war, blieb dauerhaft ohne
 * Embedding — kein Nachtlauf und keine Route hat das je nachgezogen. Bei einem
 * Beta-Tester hatten 14 von 19 Notizen keine Embeddings.
 *
 * WARUM DIESER TEST OHNE DATENBANK UND OHNE OLLAMA AUSKOMMT: die DB wird durch
 * einen Doppelgänger ersetzt, der `note_embeddings` als Menge von note_ids
 * simuliert, und `indexNote` durch ein Mock, das in genau diese Menge schreibt.
 * Damit ist prüfbar, was am Pass zählt: WELCHE Notizen er anfasst (nur die ohne
 * Embedding), WIE VIELE pro Lauf (Budget), und dass ein stiller
 * Embedding-Ausfall als Fehler auffällt statt als Erfolg.
 */

/** Simuliert `note_embeddings`: note_ids, die (irgend)ein Chunk-Row haben. */
let embeddingRows: Set<string>;
/** Alle Bind-Parameter roher `execute()`-Aufrufe — pro Test frisch. */
let executedParams: unknown[][];

const dialect = new PgDialect();

const fakeDb = {
  execute: async (query: unknown) => {
    const built = dialect.sqlToQuery(query as never);
    executedParams.push(built.params);
    if (/DISTINCT/i.test(built.sql)) {
      return [...embeddingRows].map((note_id) => ({ note_id }));
    }
    // Verify-Query: erster Parameter ist die note_id.
    const noteId = built.params[0];
    return typeof noteId === "string" && embeddingRows.has(noteId)
      ? [{ note_id: noteId }]
      : [];
  },
};

vi.mock("../../db/index.js", () => ({
  database: () => fakeDb,
  indexDatabase: () => fakeDb,
}));

let noteIds: string[] = [];
vi.mock("../../notes/notesService.js", () => ({
  listNotes: async () => noteIds.map((id) => ({ id, title: id, tags: [] })),
}));

/** Default: erfolgreiches Indexieren schreibt eine Zeile — wie in Produktion. */
let indexNote = vi.fn(async (noteId: string) => {
  embeddingRows.add(noteId);
});
vi.mock("../../memory/index.js", () => ({
  getMemoryProvider: () => ({ indexNote: (id: string) => indexNote(id) }),
}));

vi.mock("../../llm/embeddingsMigration.js", () => ({
  getActiveGeneration: async () => "default",
}));

vi.mock("../../util/coreConfig.js", () => ({
  indexVaultId: () => "vault-test",
  coreConfig: () => ({ vaultDir: "/tmp/vault" }),
}));

const { embeddingBackfillPass, EMBEDDING_BACKFILL_NOTES_PER_RUN } = await import(
  "./embeddingBackfill.js"
);

import type { SleepRun } from "../types.js";

function makeRun(): SleepRun {
  return {
    id: "01KZBAG4FD0YFQSPCGTW57ZGQV",
    phase: "nrem",
    trigger: "nightly",
    status: "running",
    startedAt: new Date("2026-08-14T03:00:00.000Z"),
    passesCompleted: [],
    passStats: {},
    notesProcessed: 0,
  };
}

beforeEach(() => {
  embeddingRows = new Set<string>();
  executedParams = [];
  noteIds = [];
  indexNote = vi.fn(async (noteId: string) => {
    embeddingRows.add(noteId);
  });
});

describe("embedding-backfill Pass", () => {
  it("zieht eine Notiz ohne Embedding nach", async () => {
    noteIds = ["10_projects/a.md"];

    const result = await embeddingBackfillPass.run(makeRun());

    expect(indexNote).toHaveBeenCalledWith("10_projects/a.md");
    expect(embeddingRows.has("10_projects/a.md")).toBe(true);
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.notes).not.toMatch(/^pass-error:/);
  });

  it("überspringt Notizen, die bereits Embeddings haben", async () => {
    noteIds = ["a.md", "b.md"];
    embeddingRows.add("b.md");

    const result = await embeddingBackfillPass.run(makeRun());

    expect(indexNote).toHaveBeenCalledTimes(1);
    expect(indexNote).toHaveBeenCalledWith("a.md");
    expect(indexNote).not.toHaveBeenCalledWith("b.md");
    expect(result.processed).toBe(1);
  });

  it("meldet sauber, wenn alle Notizen Embeddings haben", async () => {
    noteIds = ["a.md", "b.md"];
    embeddingRows.add("a.md");
    embeddingRows.add("b.md");

    const result = await embeddingBackfillPass.run(makeRun());

    expect(indexNote).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.notes).toMatch(/all notes have Tier-2 embeddings/);
  });

  it("hält das Notiz-Budget pro Lauf ein und meldet den Rest", async () => {
    const over = EMBEDDING_BACKFILL_NOTES_PER_RUN + 5;
    noteIds = Array.from({ length: over }, (_, i) => `n${i}.md`);

    const result = await embeddingBackfillPass.run(makeRun());

    expect(indexNote).toHaveBeenCalledTimes(EMBEDDING_BACKFILL_NOTES_PER_RUN);
    expect(result.processed).toBe(EMBEDDING_BACKFILL_NOTES_PER_RUN);
    // Der Rest bleibt für den nächsten Lauf stehen — nichts geht verloren.
    expect(result.notes).toMatch(/5 still missing/);
  });

  it("nimmt den Rest im nächsten Lauf mit (fortsetzbar)", async () => {
    const over = EMBEDDING_BACKFILL_NOTES_PER_RUN + 3;
    noteIds = Array.from({ length: over }, (_, i) => `n${i}.md`);

    await embeddingBackfillPass.run(makeRun());
    const second = await embeddingBackfillPass.run(makeRun());

    expect(second.processed).toBe(3);
    expect(embeddingRows.size).toBe(over);
  });

  it("zählt eine werfende Notiz als Fehler, ohne den Lauf abzubrechen", async () => {
    noteIds = ["a.md", "kaputt.md", "c.md"];
    indexNote = vi.fn(async (noteId: string) => {
      if (noteId === "kaputt.md") throw new Error("chunk rejected");
      embeddingRows.add(noteId);
    });

    const result = await embeddingBackfillPass.run(makeRun());

    expect(indexNote).toHaveBeenCalledTimes(3);
    expect(result.processed).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.notes).toMatch(/1 failed/);
  });

  it("erkennt einen stillen Embedding-Ausfall und bricht früh ab", async () => {
    // `CombinedProvider.indexNote` schluckt EmbeddingUnavailableError: der
    // Aufruf gelingt, geschrieben wird nichts. Genau das darf NICHT als
    // Erfolg durchgehen — sonst meldet der Backfill „fertig" und es ist
    // nichts passiert.
    noteIds = Array.from({ length: 20 }, (_, i) => `n${i}.md`);
    indexNote = vi.fn(async () => {
      /* Ollama tot: kein Row-Write */
    });

    const result = await embeddingBackfillPass.run(makeRun());

    expect(result.processed).toBe(0);
    expect(result.errors).toBe(5);
    expect(indexNote).toHaveBeenCalledTimes(5);
    expect(result.notes).toMatch(/stopped early/);
  });

  it("bindet nur treiber-serialisierbare Parameter an rohes SQL", async () => {
    // Lehre aus dem synaptic-pruning-Bug: ein `Date` im rohen `execute()`
    // sprengt postgres.js auf dem `unsafe`-Pfad.
    noteIds = ["a.md"];

    await embeddingBackfillPass.run(makeRun());

    for (const params of executedParams) {
      for (const p of params) {
        expect(p instanceof Date).toBe(false);
        expect(["string", "number", "boolean"]).toContain(typeof p);
      }
    }
  });

  it("ist als NREM-Pass mit stabilem pass_stats-Schlüssel registriert", async () => {
    // `SleepAgent.runPhase` schreibt `passStats[pass.name] = result` und
    // filtert die Pass-Liste über `phases`. Ein Pass, der zwar existiert,
    // aber nicht in ALL_PASSES steht, läuft nie — genau die Lücke aus #52.
    expect(embeddingBackfillPass.name).toBe("embedding-backfill");
    expect(embeddingBackfillPass.phases).toContain("nrem");

    const orchestrator = readFileSync(
      new URL("../index.ts", import.meta.url),
      "utf8",
    );
    expect(orchestrator).toMatch(/embeddingBackfillPass,/);
  });
});
