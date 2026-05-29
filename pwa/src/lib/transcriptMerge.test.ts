import { describe, expect, it } from "vitest";
import { mergeTranscript } from "./transcriptMerge.js";

describe("mergeTranscript — basics", () => {
  it("returns prefix when addition is empty", () => {
    expect(mergeTranscript("hello world", "")).toBe("hello world");
    expect(mergeTranscript("hello world", "   ")).toBe("hello world");
  });

  it("returns addition when prefix is empty", () => {
    expect(mergeTranscript("", "hello world")).toBe("hello world");
    expect(mergeTranscript("   ", "hello world")).toBe("hello world");
  });

  it("returns empty string when both are empty", () => {
    expect(mergeTranscript("", "")).toBe("");
  });

  it("collapses repeated whitespace in the output", () => {
    expect(mergeTranscript("hello    world", "")).toBe("hello world");
    expect(mergeTranscript("a", "b   c")).toBe("a b c");
  });
});

describe("mergeTranscript — overlap behaviour", () => {
  it("zero-overlap append (desktop / distinct turns) is a plain single-space join", () => {
    expect(mergeTranscript("the quick brown", "fox jumps over")).toBe(
      "the quick brown fox jumps over",
    );
  });

  it("partial word-suffix overlap drops the repeated head of the addition", () => {
    // last 2 words of prefix == first 2 words of addition
    expect(mergeTranscript("a b c d", "c d e f")).toBe("a b c d e f");
  });

  it("full-containment: addition starts with the entire prefix → result is addition", () => {
    expect(mergeTranscript("okay ich bin", "okay ich bin unglaublich")).toBe(
      "okay ich bin unglaublich",
    );
  });

  it("addition that adds nothing new (addition === prefix) returns prefix", () => {
    expect(mergeTranscript("okay ich bin", "okay ich bin")).toBe(
      "okay ich bin",
    );
  });

  it("case-insensitive overlap match, but addition's casing wins on the seam", () => {
    // overlap matches "okay ich" / "Okay Ich" ignoring case; tail "Bin Da"
    // keeps the addition's casing.
    expect(mergeTranscript("okay ich", "Okay Ich Bin Da")).toBe(
      "okay ich Bin Da",
    );
  });

  it("picks the LARGEST overlap, not the first small one", () => {
    // "a a a" vs "a a a b": small overlaps (k=1,2) and the full k=3 all match;
    // the largest (k=3) must win so we don't double-append.
    expect(mergeTranscript("x a a a", "a a a b")).toBe("x a a a b");
  });
});

describe("mergeTranscript — real Android re-delivery (the bug)", () => {
  // The exact clean sentence the user spoke once.
  const CLEAN =
    "Okay ich bin unglaublich gespannt ob das wirklich gut funktioniert, " +
    "aber ich bin mir schon fast sicher dass das extrem viel Gedöns wird";

  it("collapses the cumulative re-delivery back to the single clean sentence", () => {
    // Simulate Android Chrome re-delivering the GROWING phrase from the start
    // on each auto-restart: "Okay", "Okay ich", "Okay ich bin", … up to the
    // full sentence. We fold each successive delivery into the committed text
    // exactly as VoiceReviewSheet does on `onend` (mergeTranscript(prior, turn)).
    const words = CLEAN.split(/\s+/);
    const growingTurns: string[] = [];
    for (let n = 1; n <= words.length; n++) {
      growingTurns.push(words.slice(0, n).join(" "));
    }

    let committed = "";
    for (const turn of growingTurns) {
      committed = mergeTranscript(committed, turn);
    }

    // No cumulative stutter — exactly the clean sentence, no duplicated words.
    expect(committed).toBe(CLEAN);
  });

  it("survives turn-boundary re-overlap (Android repeats the last few words at the seam)", () => {
    // A more realistic pattern: each restart re-states the PREVIOUS turn's full
    // text plus a couple of new words (not always growing one word at a time).
    const turns = [
      "Okay ich bin",
      "Okay ich bin unglaublich gespannt",
      "unglaublich gespannt ob das wirklich gut funktioniert,",
      "wirklich gut funktioniert, aber ich bin mir schon fast sicher",
      "schon fast sicher dass das extrem viel Gedöns wird",
    ];
    let committed = "";
    for (const turn of turns) {
      committed = mergeTranscript(committed, turn);
    }
    expect(committed).toBe(CLEAN);
  });
});
