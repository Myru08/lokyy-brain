import { describe, it, expect } from "vitest";
import {
  buildLayoutedPrompt,
  layoutToMessages,
  lostInMiddleArrange,
  type ContextChunk,
} from "./contextLayout.js";

/**
 * The arrangement contract from the Lost-in-the-Middle paper:
 *   - Best chunk at the start.
 *   - Second-best chunk at the end.
 *   - Weakest chunks pushed toward the middle.
 *
 * We build inputs where each chunk's `score` matches its rank label so
 * "rank-K" is easy to read in the assertion: rank 1 = highest score.
 */

function rankedChunks(n: number): ContextChunk[] {
  // rank label 1..n, score N..1 (so rank 1 is strongest).
  return Array.from({ length: n }, (_, i) => {
    const rank = i + 1;
    return {
      noteId: `note-${rank}`,
      chunkId: `c-${rank}`,
      title: `Rank ${rank}`,
      text: `body of rank ${rank}`,
      score: n - i,
    };
  });
}

function labels(chunks: ContextChunk[]): string[] {
  return chunks.map((c) => c.title!.replace("Rank ", ""));
}

describe("lostInMiddleArrange", () => {
  it("returns [] for empty input", () => {
    expect(lostInMiddleArrange([])).toEqual([]);
  });

  it("returns single chunk unchanged", () => {
    const result = lostInMiddleArrange(rankedChunks(1));
    expect(labels(result)).toEqual(["1"]);
  });

  it("returns 2 chunks sorted by score", () => {
    // intentionally unsorted input — must come out best-first.
    const a: ContextChunk = { noteId: "a", text: "a", title: "Rank 2", score: 1 };
    const b: ContextChunk = { noteId: "b", text: "b", title: "Rank 1", score: 2 };
    expect(labels(lostInMiddleArrange([a, b]))).toEqual(["1", "2"]);
  });

  it("arranges N=3 as [r1, r3, r2]", () => {
    const result = lostInMiddleArrange(rankedChunks(3));
    expect(labels(result)).toEqual(["1", "3", "2"]);
  });

  it("arranges N=4 as [r1, r3, r4, r2]", () => {
    const result = lostInMiddleArrange(rankedChunks(4));
    expect(labels(result)).toEqual(["1", "3", "4", "2"]);
  });

  it("arranges N=5 as [r1, r3, r5, r4, r2]", () => {
    const result = lostInMiddleArrange(rankedChunks(5));
    expect(labels(result)).toEqual(["1", "3", "5", "4", "2"]);
  });

  it("does not mutate the input array", () => {
    const input = rankedChunks(5);
    const before = labels(input);
    lostInMiddleArrange(input);
    expect(labels(input)).toEqual(before);
  });

  it("re-sorts inputs that arrive out of score order", () => {
    const chunks = rankedChunks(5);
    // shuffle deterministically
    const shuffled = [chunks[2]!, chunks[0]!, chunks[4]!, chunks[1]!, chunks[3]!];
    const result = lostInMiddleArrange(shuffled);
    expect(labels(result)).toEqual(["1", "3", "5", "4", "2"]);
  });
});

describe("buildLayoutedPrompt", () => {
  it("keeps top-N and reports rejected chunks", () => {
    const result = buildLayoutedPrompt("q?", rankedChunks(5), { maxChunks: 3 });
    expect(labels(result.arrangedChunks)).toEqual(["1", "3", "2"]);
    expect(labels(result.rejectedChunks).sort()).toEqual(["4", "5"]);
  });

  it("emits position-mapping keyed by chunkId in arranged order", () => {
    const result = buildLayoutedPrompt("q?", rankedChunks(5));
    expect(result.positionMapping).toEqual({
      "c-1": 0,
      "c-3": 1,
      "c-5": 2,
      "c-4": 3,
      "c-2": 4,
    });
  });

  it("sandwich mode injects the query both before AND after the context", () => {
    const result = buildLayoutedPrompt("what is foo?", rankedChunks(3), {
      queryInjectionMode: "sandwich",
    });
    const occurrences = result.userMessage.match(/what is foo\?/g) ?? [];
    expect(occurrences.length).toBe(2);
    expect(result.userMessage.startsWith("Query: what is foo?")).toBe(true);
    expect(result.userMessage.endsWith("what is foo?")).toBe(true);
  });

  it("before mode injects the query exactly once, at the start", () => {
    const result = buildLayoutedPrompt("Q1", rankedChunks(2), {
      queryInjectionMode: "before",
    });
    const occurrences = result.userMessage.match(/Q1/g) ?? [];
    expect(occurrences.length).toBe(1);
    expect(result.userMessage.startsWith("Query: Q1")).toBe(true);
  });

  it("after mode injects the query exactly once, at the end", () => {
    const result = buildLayoutedPrompt("Q2", rankedChunks(2), {
      queryInjectionMode: "after",
    });
    const occurrences = result.userMessage.match(/Q2/g) ?? [];
    expect(occurrences.length).toBe(1);
    expect(result.userMessage.endsWith("Query: Q2")).toBe(true);
  });

  it("none mode produces just the rendered context", () => {
    const result = buildLayoutedPrompt("ignored", rankedChunks(2), {
      queryInjectionMode: "none",
    });
    expect(result.userMessage).not.toContain("Query:");
    expect(result.userMessage).not.toContain("ignored");
  });

  it("handles an empty chunk list without crashing", () => {
    const result = buildLayoutedPrompt("q?", []);
    expect(result.arrangedChunks).toEqual([]);
    expect(result.rejectedChunks).toEqual([]);
    expect(result.positionMapping).toEqual({});
    // sandwich mode is still applied — query still appears twice.
    const occurrences = result.userMessage.match(/q\?/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("handles a single chunk", () => {
    const result = buildLayoutedPrompt("q?", rankedChunks(1));
    expect(labels(result.arrangedChunks)).toEqual(["1"]);
    expect(result.userMessage).toContain("note-1");
  });

  it("respects custom separator and chunk template", () => {
    const result = buildLayoutedPrompt("q?", rankedChunks(2), {
      separatorTemplate: " ||| ",
      chunkTemplate: "{noteId}::{text}",
      queryInjectionMode: "none",
    });
    expect(result.userMessage).toBe("note-1::body of rank 1 ||| note-2::body of rank 2");
  });

  it("uses the default system message", () => {
    const result = buildLayoutedPrompt("q?", rankedChunks(2));
    expect(result.systemMessage).toContain("knowledge-aware assistant");
  });

  it("layoutToMessages produces a system + user pair", () => {
    const result = buildLayoutedPrompt("q?", rankedChunks(2));
    const messages = layoutToMessages(result);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toBe(result.userMessage);
  });
});
