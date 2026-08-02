import { describe, it, expect } from "vitest";
import { CombinedProvider } from "./CombinedProvider.js";
import type { Tier1Provider } from "./Tier1Provider.js";
import type { Tier2Provider } from "./Tier2Provider.js";
import type { Tier1BM25, BM25Hit } from "./Tier1BM25.js";
import type { SearchHit } from "./MemoryProvider.js";

/**
 * Story 5.8 AC#6 — Tier-2 hits must not be structurally starved.
 *
 * The old merge was `merged = [...t1Hits]; push unseen t2; slice(0, limit)`.
 * `t1Hits` had no cap of its own, so on any vault where a query returns
 * `limit` (default 25) BM25 hits, NO semantic hit could ever reach the caller
 * regardless of relevance — the exact reason the community reporter's
 * "eingebaute semantische Suche" looked dead even for notes that WERE indexed.
 */

const bm25Hit = (i: number): BM25Hit => ({
  noteId: `t1-${i}`,
  title: `Keyword Note ${i}`,
  snippet: "…",
  score: 100 - i,
});

const t2Hit = (id: string, score: number): SearchHit => ({
  noteId: id,
  title: `Semantic ${id}`,
  score,
  tier: "t2",
});

function build(opts: {
  bm25Hits: BM25Hit[];
  t2Hits: SearchHit[];
}): CombinedProvider {
  const fakeT1 = {
    search: async (): Promise<SearchHit[]> => [],
    relatedNotes: async (): Promise<SearchHit[]> => [],
    indexNote: async (): Promise<void> => {},
    removeNote: async (): Promise<void> => {},
  } as unknown as Tier1Provider;
  const fakeT2 = {
    search: async (): Promise<SearchHit[]> => opts.t2Hits,
    relatedNotes: async (): Promise<SearchHit[]> => [],
    indexNote: async (): Promise<void> => {},
    removeNote: async (): Promise<void> => {},
  } as unknown as Tier2Provider;
  const fakeBm25 = {
    search: async (): Promise<BM25Hit[]> => opts.bm25Hits,
  } as unknown as Tier1BM25;
  return new CombinedProvider(fakeT1, fakeT2, "01TESTVAULT0000000000000000", fakeBm25);
}

describe("Story 5.8 AC#6 — CombinedProvider.search merge", () => {
  it("surfaces Tier-2 hits even when Tier 1 alone fills the limit", async () => {
    const provider = build({
      bm25Hits: Array.from({ length: 25 }, (_, i) => bm25Hit(i)),
      t2Hits: [t2Hit("sem-a", 0.91), t2Hit("sem-b", 0.88)],
    });

    const hits = await provider.search("account blowup protection", { limit: 25 });

    expect(hits).toHaveLength(25);
    expect(hits.filter((h) => h.tier === "t2").map((h) => h.noteId)).toEqual([
      "sem-a",
      "sem-b",
    ]);
    // The strongest keyword hits must survive — this is not a Tier-1 regression.
    expect(hits[0]!.noteId).toBe("t1-0");
  });

  it("does not shrink results when Tier 2 returns nothing", async () => {
    const provider = build({
      bm25Hits: Array.from({ length: 25 }, (_, i) => bm25Hit(i)),
      t2Hits: [],
    });
    const hits = await provider.search("keyword", { limit: 25 });
    expect(hits).toHaveLength(25);
    expect(hits.every((h) => h.tier === "t1")).toBe(true);
  });

  it("still dedupes a note both tiers found, and keeps the Tier-1 entry", async () => {
    const provider = build({
      bm25Hits: Array.from({ length: 25 }, (_, i) => bm25Hit(i)),
      t2Hits: [t2Hit("t1-3", 0.99), t2Hit("sem-only", 0.8)],
    });
    const hits = await provider.search("q", { limit: 25 });
    expect(hits.filter((h) => h.noteId === "t1-3")).toHaveLength(1);
    expect(hits.find((h) => h.noteId === "t1-3")!.tier).toBe("t1");
    expect(hits.some((h) => h.noteId === "sem-only")).toBe(true);
  });

  it("never returns more than the requested limit", async () => {
    const provider = build({
      bm25Hits: Array.from({ length: 40 }, (_, i) => bm25Hit(i)),
      t2Hits: Array.from({ length: 40 }, (_, i) => t2Hit(`sem-${i}`, 0.9)),
    });
    const hits = await provider.search("q", { limit: 10 });
    expect(hits).toHaveLength(10);
    expect(hits.some((h) => h.tier === "t2")).toBe(true);
    expect(hits.some((h) => h.tier === "t1")).toBe(true);
  });

  it("a limit of 1 with plenty of Tier-1 hits still cannot be all-Tier-1 forever", async () => {
    // Degenerate case: with limit 1 the reservation rounds up to 1, so the
    // single slot goes to the semantic leg rather than silently dropping it.
    const provider = build({
      bm25Hits: [bm25Hit(0)],
      t2Hits: [t2Hit("sem-a", 0.95)],
    });
    const hits = await provider.search("q", { limit: 1 });
    expect(hits).toHaveLength(1);
  });

  it("fills the full limit from Tier 1 when Tier 2 supplies fewer than its reserve", async () => {
    const provider = build({
      bm25Hits: Array.from({ length: 25 }, (_, i) => bm25Hit(i)),
      t2Hits: [t2Hit("sem-a", 0.9)],
    });
    const hits = await provider.search("q", { limit: 25 });
    expect(hits).toHaveLength(25);
    expect(hits.filter((h) => h.tier === "t1")).toHaveLength(24);
  });
});
