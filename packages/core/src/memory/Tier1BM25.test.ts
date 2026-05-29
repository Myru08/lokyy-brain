import { describe, it, expect } from "vitest";
import { sanitizeBm25Query } from "./Tier1BM25.js";

/**
 * Story 10.1, AC#1 — ParadeDB query hardening.
 *
 * These tests target `sanitizeBm25Query` directly: it is the first line of
 * defense that neutralizes the BM25-DSL-significant characters which made the
 * `@@@` operator throw `PostgresError 42601` and cascade into the 2026-05-28
 * pool-exhaustion outage. No database is required — this is the pure transform
 * that guarantees the search path never hands ParadeDB an unparseable query.
 */
describe("sanitizeBm25Query — AC#1 ParadeDB DSL neutralization", () => {
  it("strips an unbalanced closing paren ('foo) bar' was the crash repro)", () => {
    const out = sanitizeBm25Query("foo) bar");
    expect(out).toBe("foo bar");
    expect(out).not.toMatch(/[()]/);
  });

  it("strips a single quote (o'brien)", () => {
    const out = sanitizeBm25Query("o'brien");
    // ' becomes a space → two terms, both safe.
    expect(out).toBe("o brien");
    expect(out).not.toContain("'");
  });

  it("neutralizes the full ParadeDB/Tantivy operator set without throwing", () => {
    const nasty = `(a) [b] {c} d:e f^2 g~1 h* i? j\\k l/m "n" o'p +q -r !s &t |u <v> =w #x @y`;
    const out = sanitizeBm25Query(nasty);
    // Only the alnum term tokens survive, space-separated.
    expect(out).not.toMatch(/[()[\]{}:^~*?\\/"'+\-!&|<>=#@]/);
    expect(out.split(/\s+/).every((t) => /^[a-z0-9]+$/i.test(t) || t === "")).toBe(true);
  });

  it("drops bare boolean keywords so they are not parsed as operators", () => {
    expect(sanitizeBm25Query("cats AND dogs")).toBe("cats dogs");
    expect(sanitizeBm25Query("cats OR dogs NOT birds")).toBe("cats dogs birds");
    // Lowercase keywords are operators in the DSL too.
    expect(sanitizeBm25Query("a or b")).toBe("a b");
  });

  it("returns empty string when nothing usable remains (caller short-circuits)", () => {
    expect(sanitizeBm25Query(")")).toBe("");
    expect(sanitizeBm25Query("()[]{}")).toBe("");
    expect(sanitizeBm25Query("   ")).toBe("");
    expect(sanitizeBm25Query("AND OR NOT")).toBe("");
  });

  it("preserves normal multi-token queries unchanged", () => {
    expect(sanitizeBm25Query("project planning notes")).toBe("project planning notes");
    expect(sanitizeBm25Query("  spaced   out  ")).toBe("spaced out");
  });

  it("keeps unicode/emoji-adjacent terms intact (only DSL punctuation is removed)", () => {
    // The crash repro body: "Hey, schau mal: 🎉 (Klammer) 'quote'"
    const out = sanitizeBm25Query("Hey, schau mal: 🎉 (Klammer) 'quote'");
    expect(out).not.toMatch(/[():']/);
    expect(out).toContain("Klammer");
    expect(out).toContain("quote");
    expect(out).toContain("🎉");
  });
});
