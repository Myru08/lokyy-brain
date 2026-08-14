import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * issue #52 — `POST/GET /api/search/embeddings/backfill`.
 *
 * DER BUG: `/api/search/reindex` baut ausschließlich Tier 1 (BM25) neu.
 * Tier-2-Embeddings entstehen nur auf dem Speicherpfad (fire-and-forget), also
 * blieben Notizen, die während eines Ollama-Ausfalls gespeichert wurden, für
 * immer ohne Embedding — ohne jeden Reparaturweg außer „jede Notiz von Hand neu
 * speichern" (Beta-Tester: 14 von 19 Notizen betroffen).
 *
 * Was hier abgesichert ist:
 *   - Der POST blockiert nicht: er antwortet 202, während der Lauf noch läuft.
 *   - Die Zahlen im Status stimmen (indiziert / übersprungen / fehlgeschlagen /
 *     offen / Dauer).
 *   - Eine werfende Notiz bricht den Lauf NICHT ab.
 *   - Ein zweiter Start während eines laufenden Laufs wird abgelehnt (409).
 *
 * Weder DB noch Ollama nötig: `@lokyy/core` wird partiell gemockt, die
 * `note_embeddings`-Tabelle durch eine Menge von note_ids simuliert.
 */

// @lokyy/core liest beim Import process.env (DB-URL etc.).
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

/** Simuliert `note_embeddings`: note_ids, die (irgend)ein Chunk-Row haben. */
let embeddingRows = new Set<string>();

const dialect = new PgDialect();
const fakeDb = {
  execute: async (query: unknown) => {
    const built = dialect.sqlToQuery(query as never);
    if (/DISTINCT/i.test(built.sql)) {
      return [...embeddingRows].map((note_id) => ({ note_id }));
    }
    const noteId = built.params[0];
    return typeof noteId === "string" && embeddingRows.has(noteId)
      ? [{ note_id: noteId }]
      : [];
  },
};

let noteIds: string[] = [];
let indexNote = vi.fn(async (noteId: string) => {
  embeddingRows.add(noteId);
});

vi.mock("@lokyy/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    database: () => fakeDb,
    indexVaultId: () => "vault-test",
    listNotes: async () => noteIds.map((id) => ({ id, title: id, tags: [] })),
    getMemoryProvider: () => ({ indexNote: (id: string) => indexNote(id) }),
  };
});

interface BackfillStatus {
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  skipped: number;
  indexed: number;
  failed: number;
  remaining: number;
  force: boolean;
  limit: number;
  lastError: string | null;
  ms: number;
}

let app: Hono;
let reset: () => void;

beforeAll(async () => {
  const mod = await import("./search.js");
  reset = mod._resetEmbeddingBackfillForTests;
  app = new Hono();
  app.route("/api", mod.searchRoutes);
});

beforeEach(() => {
  embeddingRows = new Set<string>();
  noteIds = [];
  indexNote = vi.fn(async (noteId: string) => {
    embeddingRows.add(noteId);
  });
  reset();
});

afterEach(() => vi.clearAllMocks());

/** Startet den Lauf und pollt den Status, bis er fertig ist. */
async function runBackfill(query = ""): Promise<BackfillStatus> {
  const start = await app.request(`/api/search/embeddings/backfill${query}`, {
    method: "POST",
  });
  expect(start.status).toBe(202);

  for (let i = 0; i < 500; i++) {
    const res = await app.request("/api/search/embeddings/backfill");
    const job = (await res.json()) as BackfillStatus;
    if (!job.running) return job;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("Backfill wurde nicht fertig");
}

describe("POST /api/search/embeddings/backfill", () => {
  it("indiziert nur Notizen ohne Embeddings und meldet verwertbare Zahlen", async () => {
    noteIds = ["a.md", "b.md", "c.md"];
    embeddingRows.add("b.md");

    const job = await runBackfill();

    expect(indexNote).toHaveBeenCalledTimes(2);
    expect(indexNote).not.toHaveBeenCalledWith("b.md");
    expect(job).toMatchObject({
      running: false,
      total: 3,
      skipped: 1,
      indexed: 2,
      failed: 0,
      remaining: 0,
      lastError: null,
    });
    expect(typeof job.ms).toBe("number");
    expect(job.finishedAt).toBeTruthy();
  });

  it("bricht bei einer werfenden Notiz nicht ab", async () => {
    noteIds = ["a.md", "kaputt.md", "c.md"];
    indexNote = vi.fn(async (noteId: string) => {
      if (noteId === "kaputt.md") throw new Error("chunk rejected");
      embeddingRows.add(noteId);
    });

    const job = await runBackfill();

    expect(indexNote).toHaveBeenCalledTimes(3);
    expect(job.indexed).toBe(2);
    expect(job.failed).toBe(1);
    expect(job.lastError).toMatch(/kaputt\.md: chunk rejected/);
  });

  it("zählt fehlende Vektoren als Fehler statt als Erfolg", async () => {
    // Ollama tot: `indexNote` gelingt, schreibt aber nichts. Genau das darf
    // nicht als „indiziert" durchgehen.
    noteIds = Array.from({ length: 10 }, (_, i) => `n${i}.md`);
    indexNote = vi.fn(async () => {});

    const job = await runBackfill();

    expect(job.indexed).toBe(0);
    expect(job.failed).toBe(5); // früher Abbruch nach 5 Fehlschlägen in Folge
    expect(job.lastError).toMatch(/stopped early/);
    expect(job.remaining).toBe(5);
  });

  it("indiziert mit force=true auch Notizen, die schon Embeddings haben", async () => {
    noteIds = ["a.md", "b.md"];
    embeddingRows.add("a.md");
    embeddingRows.add("b.md");

    const job = await runBackfill("?force=true");

    expect(indexNote).toHaveBeenCalledTimes(2);
    expect(job.force).toBe(true);
    expect(job.skipped).toBe(0);
    expect(job.indexed).toBe(2);
  });

  it("begrenzt einen Lauf über limit und meldet den Rest als remaining", async () => {
    noteIds = Array.from({ length: 5 }, (_, i) => `n${i}.md`);

    const job = await runBackfill("?limit=2");

    expect(indexNote).toHaveBeenCalledTimes(2);
    expect(job.limit).toBe(2);
    expect(job.indexed).toBe(2);
    expect(job.remaining).toBe(3);
  });

  it("antwortet sofort und lehnt einen zweiten Lauf mit 409 ab", async () => {
    noteIds = ["a.md"];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    indexNote = vi.fn(async (noteId: string) => {
      await gate;
      embeddingRows.add(noteId);
    });

    // Der POST kehrt zurück, WÄHREND die Indizierung noch hängt — das ist der
    // Kern des Nicht-Blockier-Designs.
    const first = await app.request("/api/search/embeddings/backfill", {
      method: "POST",
    });
    expect(first.status).toBe(202);
    expect((await first.json()).job.running).toBe(true);

    const second = await app.request("/api/search/embeddings/backfill", {
      method: "POST",
    });
    expect(second.status).toBe(409);
    expect((await second.json()).reason).toBe("already_running");

    release();
    const job = await runBackfillWait();
    expect(job.indexed).toBe(1);
  });

  it("liefert eine genullte Status-Antwort, bevor je ein Lauf startete", async () => {
    const res = await app.request("/api/search/embeddings/backfill");
    expect(res.status).toBe(200);
    const job = (await res.json()) as BackfillStatus;
    expect(job).toMatchObject({
      running: false,
      indexed: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
      ms: 0,
    });
  });
});

/** Nur pollen (ohne neuen POST) — für den 409-Fall. */
async function runBackfillWait(): Promise<BackfillStatus> {
  for (let i = 0; i < 500; i++) {
    const res = await app.request("/api/search/embeddings/backfill");
    const job = (await res.json()) as BackfillStatus;
    if (!job.running) return job;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("Backfill wurde nicht fertig");
}
