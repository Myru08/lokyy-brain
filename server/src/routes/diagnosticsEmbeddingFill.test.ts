import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * issue #52 — Diagnose-Füllstand für `note_embeddings`.
 *
 * DER BEFUND: Die Diagnose kannte nur Tier 1 („note_search befüllt"). Für Tier 2
 * gab es kein Äquivalent — deshalb konnten 14 von 19 Notizen ohne Embedding
 * liegen, ohne dass irgendetwas es angezeigt hat. Eine Lücke, die kein
 * Instrument misst, ist per Konstruktion unsichtbar.
 *
 * Geprüft wird die Verdikt-Logik: Unterdeckung → `warn` mit Verweis auf den
 * Backfill-Weg (und ausdrücklich NICHT auf „Suchindex neu aufbauen", das nur
 * Tier 1 baut), volle Deckung → `info`, fehlende Tabelle → `error` statt 500.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

/** Antwort des gemockten `COUNT(DISTINCT note_id)`-Aufrufs. */
let embeddedCount: number | null = 0;
let noteCount = 0;
const ended: number[] = [];

vi.mock("postgres", () => {
  const factory = () => {
    const client = async () => {
      if (embeddedCount === null) {
        throw new Error('relation "note_embeddings" does not exist');
      }
      return [{ n: String(embeddedCount) }];
    };
    client.end = async () => {
      ended.push(1);
    };
    return client;
  };
  return { default: factory };
});

vi.mock("@lokyy/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listNotes: async () =>
      Array.from({ length: noteCount }, (_, i) => ({
        id: `n${i}.md`,
        title: `n${i}`,
        tags: [],
      })),
  };
});

const { checkEmbeddingIndexFill } = await import("./diagnostics.js");

beforeEach(() => {
  embeddedCount = 0;
  noteCount = 0;
  ended.length = 0;
});

describe("Diagnose: note_embeddings befüllt", () => {
  it("warnt bei leerem Tier-2-Index und nennt den Backfill-Weg", async () => {
    noteCount = 19;
    embeddedCount = 0;

    const check = await checkEmbeddingIndexFill();

    expect(check.service).toBe("search");
    expect(check.name).toBe("note_embeddings befüllt");
    expect(check.ok).toBe(false);
    expect(check.severity).toBe("warn");
    expect(check.detail).toMatch(/0\/19/);
    expect(check.detail).toMatch(/embeddings\/backfill/);
    // Der irreführende Knopf wird ausdrücklich ausgeschlossen.
    expect(check.detail).toMatch(/hilft hier NICHT/);
  });

  it("warnt bei deutlicher Unterdeckung (Fall des Beta-Testers: 5 von 19)", async () => {
    noteCount = 19;
    embeddedCount = 5;

    const check = await checkEmbeddingIndexFill();

    expect(check.ok).toBe(false);
    expect(check.severity).toBe("warn");
    expect(check.detail).toMatch(/5\/19/);
  });

  it("meldet volle Deckung als info", async () => {
    noteCount = 19;
    embeddedCount = 19;

    const check = await checkEmbeddingIndexFill();

    expect(check.ok).toBe(true);
    expect(check.severity).toBe("info");
    expect(check.detail).toMatch(/19\/19 Notizen mit Embedding/);
  });

  it("wertet einen leeren Vault nicht als Fehler", async () => {
    noteCount = 0;
    embeddedCount = 0;

    const check = await checkEmbeddingIndexFill();

    // Kein Vault-Inhalt → nichts zu indexieren; das darf keine Warnung sein.
    expect(check.ok).toBe(true);
    expect(check.severity).toBe("info");
  });

  it("macht aus einer fehlenden Tabelle einen Fehler-Check statt eines 500ers", async () => {
    noteCount = 3;
    embeddedCount = null; // Query wirft — Zustand vor der Migration

    const check = await checkEmbeddingIndexFill();

    expect(check.ok).toBe(false);
    expect(check.severity).toBe("error");
    expect(check.detail).toMatch(/note_embeddings/);
    // Verbindung wird auch im Fehlerfall geschlossen (finally-Zweig).
    expect(ended.length).toBe(1);
  });
});
