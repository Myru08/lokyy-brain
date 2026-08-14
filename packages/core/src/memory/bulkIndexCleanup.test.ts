import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Tier1BM25 } from "./Tier1BM25.js";
import { Tier1Provider } from "./Tier1Provider.js";
import { Tier2Provider } from "./Tier2Provider.js";
import { CombinedProvider } from "./CombinedProvider.js";
import {
  queueBulkTierRemove,
  queueBulkTierRefresh,
  flushBulkIndexQueue,
  BULK_INDEX_CHUNK,
  getBreakerStateSize,
  resetQuarantineState,
  type BulkRefreshItem,
} from "./index.js";

/**
 * Issue #56, AC#6 — der eigentliche Kern der Story.
 *
 * Beim Einzel-Delete entsteht GENAU EINE Bereinigung. Bei einem Ordner mit N
 * Notizen entstehen N. Würden die als N parallele Microtasks feuern, wäre das
 * exakt der Fehlermodus vom 2026-05-28: fehlgeschlagene Writes stürmten den
 * Connection-Pool leer (siehe Kommentar in `memory/index.ts`).
 *
 * Diese Datei nagelt fest, dass die Bulk-Variante
 *   a) gebündelt löscht (EINE Query pro Chunk statt einer pro Notiz),
 *   b) strikt seriell läuft (nie mehr als eine Index-Operation in flight),
 *   c) fire-and-forget bleibt und keinen Fehler nach oben durchlässt.
 *
 * Keine DB, kein Ollama: gespiegelt wird auf den Prototypen der Provider.
 */

const VAULT = "01KYPWCA9JA6TBRF9NFZMC47PB";

function ids(n: number, prefix = "10_projects/lokyy/note-"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

/** Zählt maximale Nebenläufigkeit über einen async-Spy. */
function concurrencyTracker() {
  const state = { current: 0, max: 0 };
  return {
    state,
    async wrap<T>(fn: () => Promise<T> | T): Promise<T> {
      state.current++;
      state.max = Math.max(state.max, state.current);
      try {
        // Ein echter Tick, damit paralleles Feuern auch wirklich auffliegt.
        await new Promise((r) => setTimeout(r, 0));
        return await fn();
      } finally {
        state.current--;
      }
    },
  };
}

beforeEach(() => {
  resetQuarantineState();
});

afterEach(async () => {
  await flushBulkIndexQueue();
  vi.restoreAllMocks();
  resetQuarantineState();
});

describe("queueBulkTierRemove (Issue #56, AC#1/#2/#4/#6)", () => {
  it("kehrt SYNCHRON zurück — der Request-Pfad wartet nie auf die Bereinigung", async () => {
    let ran = false;
    vi.spyOn(Tier1BM25.prototype, "removeMany").mockImplementation(async () => {
      ran = true;
    });
    vi.spyOn(Tier2Provider.prototype, "removeNotes").mockResolvedValue(undefined);

    queueBulkTierRemove(VAULT, ids(50));
    expect(ran).toBe(false);

    await flushBulkIndexQueue();
    expect(ran).toBe(true);
  });

  it("entfernt ALLE gesammelten IDs aus BEIDEN Tiers", async () => {
    const t1 = vi
      .spyOn(Tier1BM25.prototype, "removeMany")
      .mockResolvedValue(undefined);
    const t2 = vi
      .spyOn(Tier2Provider.prototype, "removeNotes")
      .mockResolvedValue(undefined);

    const all = ids(7);
    queueBulkTierRemove(VAULT, all);
    await flushBulkIndexQueue();

    expect(t1.mock.calls.flatMap((c) => c[0])).toEqual(all);
    expect(t2.mock.calls.flatMap((c) => c[0])).toEqual(all);
  });

  it("bündelt statt zu stürmen: N Notizen ⇒ ceil(N/CHUNK) Queries, nicht N", async () => {
    const n = BULK_INDEX_CHUNK * 2 + 25;
    const t1 = vi
      .spyOn(Tier1BM25.prototype, "removeMany")
      .mockResolvedValue(undefined);
    const t2 = vi
      .spyOn(Tier2Provider.prototype, "removeNotes")
      .mockResolvedValue(undefined);

    queueBulkTierRemove(VAULT, ids(n));
    await flushBulkIndexQueue();

    const expectedChunks = Math.ceil(n / BULK_INDEX_CHUNK);
    expect(t1).toHaveBeenCalledTimes(expectedChunks);
    expect(t2).toHaveBeenCalledTimes(expectedChunks);
    // Der Punkt der Story: die Query-Zahl wächst NICHT mit N.
    expect(expectedChunks).toBeLessThan(n / 10);
    for (const call of t1.mock.calls) {
      expect(call[0]!.length).toBeLessThanOrEqual(BULK_INDEX_CHUNK);
    }
  });

  it("läuft strikt seriell — nie mehr als EINE Index-Operation in flight", async () => {
    const tracker = concurrencyTracker();
    vi.spyOn(Tier1BM25.prototype, "removeMany").mockImplementation(() =>
      tracker.wrap(() => undefined),
    );
    vi.spyOn(Tier2Provider.prototype, "removeNotes").mockImplementation(() =>
      tracker.wrap(() => undefined),
    );

    // Drei Ordner-Löschungen gleichzeitig, jede über mehrere Chunks.
    queueBulkTierRemove(VAULT, ids(BULK_INDEX_CHUNK + 5, "a/"));
    queueBulkTierRemove(VAULT, ids(BULK_INDEX_CHUNK + 5, "b/"));
    queueBulkTierRemove(VAULT, ids(BULK_INDEX_CHUNK + 5, "c/"));
    await flushBulkIndexQueue();

    expect(tracker.state.max).toBe(1);
  });

  it("ein fehlschlagender Tier bricht weder den anderen noch die Folge-Chunks ab", async () => {
    const t1 = vi
      .spyOn(Tier1BM25.prototype, "removeMany")
      .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    const t2 = vi
      .spyOn(Tier2Provider.prototype, "removeNotes")
      .mockResolvedValue(undefined);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const n = BULK_INDEX_CHUNK + 3;
    expect(() => queueBulkTierRemove(VAULT, ids(n))).not.toThrow();
    await flushBulkIndexQueue();

    expect(t1).toHaveBeenCalledTimes(2);
    expect(t2).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalled();
  });

  it("fasst den strukturellen In-Memory-Index EINMAL an, nicht pro Notiz", async () => {
    vi.spyOn(Tier1BM25.prototype, "removeMany").mockResolvedValue(undefined);
    vi.spyOn(Tier2Provider.prototype, "removeNotes").mockResolvedValue(undefined);
    const structural = vi
      .spyOn(Tier1Provider.prototype, "removeNote")
      .mockResolvedValue(undefined);

    queueBulkTierRemove(VAULT, ids(120));
    await flushBulkIndexQueue();

    expect(structural).toHaveBeenCalledTimes(1);
  });

  it("rührt den Per-Note-Circuit-Breaker nicht an (Story-10.1-State bleibt sauber)", async () => {
    vi.spyOn(Tier1BM25.prototype, "removeMany").mockRejectedValue(
      new Error("index pool down"),
    );
    vi.spyOn(Tier2Provider.prototype, "removeNotes").mockRejectedValue(
      new Error("tier2 down"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    queueBulkTierRemove(VAULT, ids(5));
    await flushBulkIndexQueue();

    expect(getBreakerStateSize()).toBe(0);
  });

  it("ignoriert eine leere ID-Liste komplett", async () => {
    const t1 = vi
      .spyOn(Tier1BM25.prototype, "removeMany")
      .mockResolvedValue(undefined);

    queueBulkTierRemove(VAULT, []);
    await flushBulkIndexQueue();

    expect(t1).not.toHaveBeenCalled();
  });
});

describe("queueBulkTierRefresh (Issue #56, AC#3/#4/#6)", () => {
  function refreshItems(count: number): BulkRefreshItem[] {
    return ids(count, "neu/").map((noteId) => ({
      noteId,
      load: async () => ({
        title: noteId,
        body: `# ${noteId}\n\nbody`,
        tags: [],
        forgotten: false,
      }),
    }));
  }

  it("indiziert jede Notiz unter ihrer NEUEN ID in beiden Tiers", async () => {
    const upsert = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockResolvedValue(undefined);
    const indexNote = vi
      .spyOn(CombinedProvider.prototype, "indexNote")
      .mockResolvedValue(undefined);

    queueBulkTierRefresh(VAULT, refreshItems(4));
    await flushBulkIndexQueue();

    expect(upsert.mock.calls.map((c) => c[0])).toEqual(ids(4, "neu/"));
    expect(indexNote.mock.calls.map((c) => c[0])).toEqual(ids(4, "neu/"));
    // Tier 1 wird mit der konfigurierten Vault-ID geschrieben.
    expect(upsert.mock.calls[0]![1]).toBe(VAULT);
  });

  it("kehrt SYNCHRON zurück und arbeitet Notiz für Notiz ab (Nebenläufigkeit 1)", async () => {
    const tracker = concurrencyTracker();
    let ran = false;
    vi.spyOn(Tier1BM25.prototype, "upsert").mockImplementation(() =>
      tracker.wrap(() => {
        ran = true;
      }),
    );
    vi.spyOn(CombinedProvider.prototype, "indexNote").mockImplementation(() =>
      tracker.wrap(() => undefined),
    );

    queueBulkTierRefresh(VAULT, refreshItems(25));
    expect(ran).toBe(false);

    await flushBulkIndexQueue();
    expect(tracker.state.max).toBe(1);
  });

  it("eine kaputte Notiz stoppt die übrigen nicht und wirft nicht", async () => {
    const upsert = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockResolvedValue(undefined);
    vi.spyOn(CombinedProvider.prototype, "indexNote").mockResolvedValue(undefined);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const items = refreshItems(3);
    items[1]!.load = async () => {
      throw new Error("EACCES");
    };

    expect(() => queueBulkTierRefresh(VAULT, items)).not.toThrow();
    await flushBulkIndexQueue();

    expect(upsert.mock.calls.map((c) => c[0])).toEqual(["neu/0", "neu/2"]);
    expect(logged).toHaveBeenCalled();
  });

  it("überspringt Notizen, die zwischen Move und Re-Index verschwunden sind", async () => {
    const upsert = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockResolvedValue(undefined);
    vi.spyOn(CombinedProvider.prototype, "indexNote").mockResolvedValue(undefined);

    const items = refreshItems(2);
    items[0]!.load = async () => null;

    queueBulkTierRefresh(VAULT, items);
    await flushBulkIndexQueue();

    expect(upsert.mock.calls.map((c) => c[0])).toEqual(["neu/1"]);
  });
});

describe("Reihenfolge von Remove und Refresh (Issue #56, AC#3)", () => {
  it("erst die alten IDs raus, dann die neuen rein — eine gemeinsame Warteschlange", async () => {
    const order: string[] = [];
    vi.spyOn(Tier1BM25.prototype, "removeMany").mockImplementation(async () => {
      order.push("remove");
    });
    vi.spyOn(Tier2Provider.prototype, "removeNotes").mockResolvedValue(undefined);
    vi.spyOn(Tier1BM25.prototype, "upsert").mockImplementation(async () => {
      order.push("refresh");
    });
    vi.spyOn(CombinedProvider.prototype, "indexNote").mockResolvedValue(undefined);

    queueBulkTierRemove(VAULT, ["alt/a", "alt/b"]);
    queueBulkTierRefresh(VAULT, [
      {
        noteId: "neu/a",
        load: async () => ({ title: "a", body: "b", tags: [], forgotten: false }),
      },
    ]);
    await flushBulkIndexQueue();

    expect(order).toEqual(["remove", "refresh"]);
  });
});
