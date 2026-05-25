import { describe, it, expect } from "vitest";
import type { GraphData } from "@lokyy/shared";
import { pageRankOnGraph, seedsFromRrfHits } from "./ppr.js";

/**
 * Phase B Wave B1 / Story 1 — Personalized PageRank tests.
 *
 * The pure helper {@link pageRankOnGraph} accepts a hand-built graph so we
 * don't need vault I/O. Verifies: seed handling, normalization, convergence,
 * dangling-node teleport, and ranking determinism.
 */

function makeGraph(nodeIds: string[], edges: Array<[string, string]>): GraphData {
  return {
    nodes: nodeIds.map((id) => ({ id, title: id, tags: [] })),
    edges: edges.map(([source, target]) => ({ source, target })),
  };
}

describe("seedsFromRrfHits", () => {
  it("returns empty seeds for empty input", () => {
    expect(seedsFromRrfHits([]).seeds.size).toBe(0);
  });

  it("assigns linear-decay weights (N, N-1, ...)", () => {
    const seeds = seedsFromRrfHits([
      { noteId: "a", score: 0.1 },
      { noteId: "b", score: 0.05 },
      { noteId: "c", score: 0.01 },
    ]);
    expect(seeds.seeds.get("a")).toBe(3);
    expect(seeds.seeds.get("b")).toBe(2);
    expect(seeds.seeds.get("c")).toBe(1);
  });

  it("dedupes by noteId keeping the highest rank", () => {
    const seeds = seedsFromRrfHits([
      { noteId: "a", score: 0.9 },
      { noteId: "b", score: 0.5 },
      { noteId: "a", score: 0.1 },
    ]);
    // First appearance is rank 1 → weight 3 (N=3). Second 'a' would be 1,
    // but we keep the max. b stays at 2.
    expect(seeds.seeds.get("a")).toBe(3);
    expect(seeds.seeds.get("b")).toBe(2);
    expect(seeds.seeds.size).toBe(2);
  });
});

describe("pageRankOnGraph — basic", () => {
  it("returns empty array for empty graph", () => {
    const result = pageRankOnGraph(makeGraph([], []), { seeds: new Map() });
    expect(result).toEqual([]);
  });

  it("seed node ranks highest in a star graph (a → {b,c,d})", () => {
    const graph = makeGraph(
      ["a", "b", "c", "d"],
      [
        ["a", "b"],
        ["a", "c"],
        ["a", "d"],
      ],
    );
    const seeds = new Map([["a", 1]]);
    const hits = pageRankOnGraph(graph, { seeds });
    expect(hits.length).toBe(4);
    expect(hits[0]!.noteId).toBe("a");
    expect(hits[0]!.isSeed).toBe(true);
    expect(hits[0]!.pprRank).toBe(1);
    // b, c, d should share roughly equal mass via the single hop from a.
    const bcd = hits.slice(1).map((h) => h.score);
    expect(bcd.every((s) => Math.abs(s - bcd[0]!) < 1e-6)).toBe(true);
  });

  it("scores sum to ~1 (probability distribution preserved)", () => {
    // 5-node chain a → b → c → d → e
    const graph = makeGraph(
      ["a", "b", "c", "d", "e"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["d", "e"],
      ],
    );
    const hits = pageRankOnGraph(graph, { seeds: new Map([["a", 1]]) });
    const sum = hits.reduce((acc, h) => acc + h.score, 0);
    expect(sum).toBeGreaterThan(0.99);
    expect(sum).toBeLessThan(1.01);
  });

  it("dangling node ('e') doesn't leak mass — total still ~1", () => {
    // Same chain — 'e' has no outgoing edges. The teleport-back-to-p path
    // is what keeps the rank sink from draining mass.
    const graph = makeGraph(
      ["a", "b", "c", "d", "e"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["d", "e"],
      ],
    );
    const hits = pageRankOnGraph(graph, { seeds: new Map([["a", 1]]) }, { iterations: 100 });
    const sum = hits.reduce((acc, h) => acc + h.score, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-3);
  });

  it("two disconnected components — seeds only flow within their component", () => {
    // {a,b,c} and {x,y,z} disconnected. Seed only 'a'.
    const graph = makeGraph(
      ["a", "b", "c", "x", "y", "z"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
        ["x", "y"],
        ["y", "z"],
        ["z", "x"],
      ],
    );
    const hits = pageRankOnGraph(graph, { seeds: new Map([["a", 1]]) });
    const byId = new Map(hits.map((h) => [h.noteId, h.score]));
    // Damping=0.5, teleport-back-to-a sends some mass to {x,y,z}? No —
    // teleport goes to personalization vector which is ONLY 'a'. So
    // {x,y,z} only get mass from their own loop, which gets nothing
    // from the teleport. They should be ~0.
    expect(byId.get("x")!).toBeLessThan(0.05);
    expect(byId.get("y")!).toBeLessThan(0.05);
    expect(byId.get("z")!).toBeLessThan(0.05);
    expect(byId.get("a")!).toBeGreaterThan(byId.get("x")!);
  });

  it("uniform fallback when no seeds resolve to graph nodes", () => {
    const graph = makeGraph(["a", "b", "c"], [["a", "b"]]);
    // Seed 'zzz' isn't in the graph → falls back to uniform PageRank.
    const hits = pageRankOnGraph(graph, { seeds: new Map([["zzz", 1]]) });
    expect(hits.length).toBe(3);
    // All three should have non-zero mass.
    for (const h of hits) expect(h.score).toBeGreaterThan(0);
  });

  it("respects topK", () => {
    const graph = makeGraph(
      ["a", "b", "c", "d", "e"],
      [
        ["a", "b"],
        ["a", "c"],
        ["a", "d"],
        ["a", "e"],
      ],
    );
    const hits = pageRankOnGraph(graph, { seeds: new Map([["a", 1]]) }, { topK: 2 });
    expect(hits.length).toBe(2);
    expect(hits[0]!.pprRank).toBe(1);
    expect(hits[1]!.pprRank).toBe(2);
  });

  it("isSeed flag is set only for original seed ids", () => {
    const graph = makeGraph(
      ["a", "b", "c"],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    );
    const seeds = new Map([
      ["a", 2],
      ["b", 1],
    ]);
    const hits = pageRankOnGraph(graph, { seeds });
    const byId = new Map(hits.map((h) => [h.noteId, h.isSeed]));
    expect(byId.get("a")).toBe(true);
    expect(byId.get("b")).toBe(true);
    expect(byId.get("c")).toBe(false);
  });
});
