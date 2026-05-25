import { describe, it, expect } from "vitest";
import {
  applyContextBoost,
  captureEncodingContext,
  contextMatchBoost,
  timeOfDayFrom,
  weekdayFrom,
  type QueryContext,
  type ScoredHit,
} from "./encodingContext.js";
import type { EncodedContext } from "../frontmatter/types.js";

describe("timeOfDayFrom", () => {
  it("buckets hours into morning/midday/evening/night", () => {
    // Year/month/day arbitrary — only the local hour is observed.
    expect(timeOfDayFrom(new Date(2026, 0, 1, 5, 0))).toBe("morning");
    expect(timeOfDayFrom(new Date(2026, 0, 1, 10, 59))).toBe("morning");
    expect(timeOfDayFrom(new Date(2026, 0, 1, 11, 0))).toBe("midday");
    expect(timeOfDayFrom(new Date(2026, 0, 1, 16, 59))).toBe("midday");
    expect(timeOfDayFrom(new Date(2026, 0, 1, 17, 0))).toBe("evening");
    expect(timeOfDayFrom(new Date(2026, 0, 1, 21, 59))).toBe("evening");
    expect(timeOfDayFrom(new Date(2026, 0, 1, 22, 0))).toBe("night");
    expect(timeOfDayFrom(new Date(2026, 0, 1, 4, 59))).toBe("night");
    expect(timeOfDayFrom(new Date(2026, 0, 1, 0, 0))).toBe("night");
  });
});

describe("weekdayFrom", () => {
  it("maps getDay() to lowercase English names", () => {
    // 2026-01-04 is a Sunday.
    expect(weekdayFrom(new Date(2026, 0, 4))).toBe("sunday");
    expect(weekdayFrom(new Date(2026, 0, 5))).toBe("monday");
    expect(weekdayFrom(new Date(2026, 0, 6))).toBe("tuesday");
    expect(weekdayFrom(new Date(2026, 0, 7))).toBe("wednesday");
    expect(weekdayFrom(new Date(2026, 0, 8))).toBe("thursday");
    expect(weekdayFrom(new Date(2026, 0, 9))).toBe("friday");
    expect(weekdayFrom(new Date(2026, 0, 10))).toBe("saturday");
  });
});

describe("captureEncodingContext", () => {
  it("derives time-of-day + weekday from `now` and passes inputs through", () => {
    const now = new Date(2026, 0, 6, 19, 30); // Tuesday evening
    const encoded = captureEncodingContext(
      {
        device: "laptop",
        app_state: "focused-writing",
        preceding_notes: ["20_projects/a", "20_projects/b"],
        session_duration_min: 42,
        word_count_session: 1200,
        source: { kind: "manual" },
      },
      now,
    );

    expect(encoded.device).toBe("laptop");
    expect(encoded.app_state).toBe("focused-writing");
    expect(encoded.time_of_day).toBe("evening");
    expect(encoded.weekday).toBe("tuesday");
    expect(encoded.preceding_notes).toEqual([
      "20_projects/a",
      "20_projects/b",
    ]);
    expect(encoded.session_duration_min).toBe(42);
    expect(encoded.word_count_session).toBe(1200);
    expect(encoded.source).toEqual({ kind: "manual" });
  });

  it("works with empty input — still fills time-of-day + weekday", () => {
    const now = new Date(2026, 0, 5, 7, 0); // Monday morning
    const encoded = captureEncodingContext(undefined, now);
    expect(encoded.time_of_day).toBe("morning");
    expect(encoded.weekday).toBe("monday");
    expect(encoded.device).toBeUndefined();
    expect(encoded.preceding_notes).toBeUndefined();
  });
});

describe("contextMatchBoost — required test matrix", () => {
  const queryFullMatch: QueryContext = {
    device: "laptop",
    time_of_day: "evening",
    weekday: "tuesday",
    preceding_notes: ["a", "b", "c"],
    active_project: "20_projects/lokyy",
  };

  const noteFullMatch: EncodedContext = {
    device: "laptop",
    time_of_day: "evening",
    weekday: "tuesday",
    preceding_notes: ["a", "b", "c"],
  };

  it("empty encoded → boost = 1.0", () => {
    const r = contextMatchBoost(undefined, queryFullMatch);
    expect(r.totalBoost).toBe(1.0);
    expect(r.matches).toHaveLength(0);
  });

  it("all fields match → boost in [1.65, 1.80]", () => {
    const r = contextMatchBoost(
      noteFullMatch,
      queryFullMatch,
      "20_projects/lokyy/notes",
    );
    // 1.0 + 0.05 (device) + 0.10 (time) + 0.05 (weekday)
    //     + 0.25 (preceding 3/3) + 0.20 (active_project) = 1.65
    expect(r.totalBoost).toBeGreaterThanOrEqual(1.65);
    expect(r.totalBoost).toBeLessThanOrEqual(1.8);
    expect(r.matches.map((m) => m.field).sort()).toEqual([
      "active_project",
      "device",
      "preceding_notes_overlap",
      "time_of_day",
      "weekday",
    ]);
  });

  it("partial match → partial boost", () => {
    // Only time-of-day matches.
    const r = contextMatchBoost(
      {
        device: "mobile",
        time_of_day: "evening",
        weekday: "friday",
      },
      queryFullMatch,
    );
    expect(r.totalBoost).toBeCloseTo(1.1, 5); // 1.0 + 0.10
    expect(r.matches).toEqual([{ field: "time_of_day", weight: 0.1 }]);
  });

  it("preceding_notes overlap of 3+ saturates at the bucket weight", () => {
    // Overlap of exactly 3.
    const r3 = contextMatchBoost(
      { preceding_notes: ["a", "b", "c"] },
      { preceding_notes: ["a", "b", "c"] },
    );
    expect(r3.totalBoost).toBeCloseTo(1.25, 5); // 1.0 + 0.25

    // Overlap of 5 — saturates at the same value as overlap-of-3.
    const r5 = contextMatchBoost(
      { preceding_notes: ["a", "b", "c", "d", "e"] },
      { preceding_notes: ["a", "b", "c", "d", "e"] },
    );
    expect(r5.totalBoost).toBeCloseTo(1.25, 5);

    // Overlap of 1 — half-step.
    const r1 = contextMatchBoost(
      { preceding_notes: ["a"] },
      { preceding_notes: ["a"] },
    );
    expect(r1.totalBoost).toBeCloseTo(1.0 + (1 / 3) * 0.25, 5);
  });

  it("active_project: prefix match works, mismatch yields no boost", () => {
    const noteEncoded: EncodedContext = { device: "laptop" };
    const queryCtx: QueryContext = {
      device: "laptop",
      active_project: "20_projects/lokyy",
    };
    const matched = contextMatchBoost(
      noteEncoded,
      queryCtx,
      "20_projects/lokyy/research/notes.md",
    );
    expect(matched.matches.some((m) => m.field === "active_project")).toBe(true);
    // 1.0 + 0.05 device + 0.20 project
    expect(matched.totalBoost).toBeCloseTo(1.25, 5);

    const mismatched = contextMatchBoost(
      noteEncoded,
      queryCtx,
      "30_captures/url/foo.md",
    );
    expect(mismatched.matches.some((m) => m.field === "active_project")).toBe(false);
  });
});

describe("applyContextBoost", () => {
  it("multiplies score by boost and re-sorts hits desc", () => {
    const hits: ScoredHit[] = [
      // Best raw score but no encoded → boost 1.0
      {
        noteId: "A",
        score: 1.0,
      },
      // Lower raw score but full-context-match → boost 1.65
      {
        noteId: "B",
        score: 0.7,
        encoded: {
          device: "laptop",
          time_of_day: "evening",
          weekday: "tuesday",
          preceding_notes: ["x", "y", "z"],
        },
        folder: "20_projects/lokyy/sub",
      },
      // Middle raw score, partial match → moderate boost
      {
        noteId: "C",
        score: 0.85,
        encoded: { device: "laptop" },
        folder: "irrelevant",
      },
    ];
    const queryCtx: QueryContext = {
      device: "laptop",
      time_of_day: "evening",
      weekday: "tuesday",
      preceding_notes: ["x", "y", "z"],
      active_project: "20_projects/lokyy",
    };
    const boosted = applyContextBoost(hits, queryCtx);

    // B wins: 0.7 * 1.65 = 1.155 > A 1.0 > C 0.85 * 1.05 = 0.8925
    expect(boosted[0]!.noteId).toBe("B");
    expect(boosted[1]!.noteId).toBe("A");
    expect(boosted[2]!.noteId).toBe("C");
    // boostedScore preserves the multiplication.
    expect(boosted[0]!.boostedScore).toBeCloseTo(0.7 * 1.65, 5);
    expect(boosted[1]!.boostedScore).toBeCloseTo(1.0, 5);
  });
});
