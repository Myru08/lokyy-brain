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

describe("mergeTranscript — cumulative finals WITHIN a single turn (Android)", () => {
  // Android Chrome can emit the growing phrase as CUMULATIVE FINAL results at
  // INCREASING indices inside ONE recognition turn — the per-turn segment map
  // becomes {0:"Okay", 1:"Okay ich", 2:"Okay ich bin", …}. `buildCommitted()`
  // in VoiceReviewSheet folds that sorted segment list through `mergeTranscript`
  // via `reduce` (NOT `.join(" ")`); this reproduces exactly that reduce and
  // asserts the superset finals collapse to the one clean sentence.
  const CLEAN =
    "Okay ich bin unglaublich gespannt ob das wirklich gut funktioniert " +
    "aber ich bin mir schon fast sicher dass das extrem viel Gedöns wird";

  it("reduces cumulative per-turn finals to the clean single sentence (no duplicated words)", () => {
    const words = CLEAN.split(/\s+/);
    // Per-turn final segments at increasing indices: each restates the whole
    // growing phrase from the start — the exact Android within-turn pattern.
    const segments: string[] = [];
    for (let n = 1; n <= words.length; n++) {
      segments.push(words.slice(0, n).join(" "));
    }

    // Same fold buildCommitted() applies to the sorted per-turn segments.
    const turn = segments.reduce((acc, seg) => mergeTranscript(acc, seg), "");

    expect(turn).toBe(CLEAN);
  });

  it("plain distinct (non-overlapping) per-turn finals still just append (k=0)", () => {
    // The normal desktop case: successive finals are DISTINCT segments. The
    // same reduce must behave like a single-space join — behaviour unchanged.
    const segments = ["the quick brown", "fox jumps over", "the lazy dog"];
    const turn = segments.reduce((acc, seg) => mergeTranscript(acc, seg), "");
    expect(turn).toBe("the quick brown fox jumps over the lazy dog");
  });
});

describe("mergeTranscript — full-utterance RESTATEMENT (Android re-recognition)", () => {
  // Android re-emits the ENTIRE utterance again as a new turn: a near-duplicate
  // that restarts FROM THE BEGINNING with minor word diffs ("scheint das" vs
  // "scheint es") and an extra trailing word ("arbeiten"). The seam overlap is
  // ZERO (prefix ends "vernünftig", addition starts "okay"), so the old code
  // plain-appended → the whole sentence appeared twice. Restatement detection
  // must collapse it to the single, longer/more-complete copy.
  const v1 =
    "okay dann bin ich jetzt mal gespannt ob das deutlich besser funktioniert " +
    "aber so wie es aussieht scheint das recht gut zu funktionieren und ich " +
    "glaube damit könnten wir auf jeden Fall vernünftig";
  const v2 =
    "okay dann bin ich jetzt mal gespannt ob das deutlich besser funktioniert " +
    "aber so wie es aussieht scheint es recht gut zu funktionieren und ich " +
    "glaube damit könnten wir auf jeden Fall vernünftig arbeiten";

  it("collapses the real-recording re-utterance to a single coherent copy (the longer v2)", () => {
    const merged = mergeTranscript(v1, v2);

    // Single, complete copy — equals the longer/more-complete side.
    expect(merged).toBe(v2);

    // "okay dann bin ich" appears EXACTLY ONCE (no concatenated duplicate).
    const occurrences = merged
      .toLowerCase()
      .split("okay dann bin ich").length - 1;
    expect(occurrences).toBe(1);
  });

  it("returns the longer side regardless of argument order (v2 then v1)", () => {
    expect(mergeTranscript(v2, v1)).toBe(v2);
  });

  it("NEGATIVE: two distinct sentences sharing only the first word are NOT collapsed", () => {
    // Only one shared leading word ("the") — far below the 4-word floor — so
    // these are genuinely distinct turns and must be appended, not merged.
    expect(
      mergeTranscript("the cat sat on the mat", "the dog ran in the park"),
    ).toBe("the cat sat on the mat the dog ran in the park");
  });

  it("NEGATIVE: a short shared lead (below the 4-word floor) still appends", () => {
    // Three shared leading words ("ich gehe gleich") < 4 → not a restatement.
    expect(mergeTranscript("ich gehe gleich nach Hause", "ich gehe gleich")).toBe(
      "ich gehe gleich nach Hause ich gehe gleich",
    );
  });
});
