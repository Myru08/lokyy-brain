import { describe, it, expect } from "vitest";
import { chunkNote, approximateTokens, hashChunk } from "./index.js";

describe("chunkNote — basic fan-out", () => {
  it("empty body yields title-only", () => {
    const chunks = chunkNote({ title: "My Note", body: "" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.chunkType).toBe("title");
    expect(chunks[0]!.text).toBe("My Note");
    expect(chunks[0]!.anchored.startsWith("My Note")).toBe(true);
  });

  it("short body (no headings, 3 paragraphs) yields title + body_full + 1 section", () => {
    const body = "First paragraph here.\n\nSecond paragraph.\n\nThird one.";
    const chunks = chunkNote({ title: "Short", body });
    const types = chunks.map((c) => c.chunkType);
    expect(types).toContain("title");
    expect(types).toContain("body_full");
    expect(types).toContain("section");
    // No sliding chunks (only 3 paragraphs, threshold is 5).
    expect(types).not.toContain("sliding_3para");
    expect(chunks.filter((c) => c.chunkType === "section")).toHaveLength(1);
  });

  it("long single-section body (5+ paragraphs) emits sliding chunks", () => {
    const paragraphs = [
      "Alpha paragraph.",
      "Beta paragraph.",
      "Gamma paragraph.",
      "Delta paragraph.",
      "Epsilon paragraph.",
    ];
    const body = paragraphs.join("\n\n");
    const chunks = chunkNote({ title: "Long", body });
    const sliding = chunks.filter((c) => c.chunkType === "sliding_3para");
    // 5 paragraphs, window 3, stride 1 → 3 sliding chunks (i=0,1,2).
    expect(sliding).toHaveLength(3);
    // Indices should be sequential 0,1,2.
    expect(sliding.map((c) => c.chunkIdx)).toEqual([0, 1, 2]);
    // Body fits well under 6000-token cap.
    expect(chunks.some((c) => c.chunkType === "body_full")).toBe(true);
  });

  it("body over token cap skips body_full but keeps sections + sliding", () => {
    // Build a body that exceeds 100 tokens (forced cap for the test).
    const paragraphs = Array.from(
      { length: 6 },
      (_, i) => `Paragraph ${i} with quite a bit of substantive content here.`,
    );
    const body = `## Section A\n\n${paragraphs.join("\n\n")}`;
    const chunks = chunkNote({ title: "Big", body, maxBodyFullTokens: 10 });
    const types = chunks.map((c) => c.chunkType);
    expect(types).toContain("title");
    expect(types).not.toContain("body_full");
    expect(types).toContain("section");
    expect(types).toContain("sliding_3para");
  });
});

describe("chunkNote — heading hierarchy", () => {
  it("nested H1/H2/H3 produces breadcrumbs", () => {
    const body = [
      "# Top",
      "",
      "Intro line.",
      "",
      "## Middle",
      "",
      "Mid body line.",
      "",
      "### Leaf",
      "",
      "Leaf body line.",
      "",
    ].join("\n");
    const chunks = chunkNote({ title: "Hier", body });
    const sections = chunks.filter((c) => c.chunkType === "section");
    expect(sections).toHaveLength(3);
    const breadcrumbs = sections.map((s) => s.breadcrumb);
    expect(breadcrumbs).toContain("Top");
    expect(breadcrumbs).toContain("Top > Middle");
    expect(breadcrumbs).toContain("Top > Middle > Leaf");
  });

  it("sibling H2s under same H1 do not nest", () => {
    const body = [
      "# Root",
      "",
      "## Alpha",
      "",
      "Alpha body.",
      "",
      "## Beta",
      "",
      "Beta body.",
      "",
    ].join("\n");
    const chunks = chunkNote({ title: "Siblings", body });
    const sections = chunks.filter((c) => c.chunkType === "section");
    const breadcrumbs = sections.map((s) => s.breadcrumb);
    expect(breadcrumbs).toContain("Root > Alpha");
    expect(breadcrumbs).toContain("Root > Beta");
    // Beta is NOT nested under Alpha.
    expect(breadcrumbs).not.toContain("Root > Alpha > Beta");
  });

  it("no headings at all → one synthetic section spanning the body", () => {
    const body = "Just some prose.\n\nNo headings here.";
    const chunks = chunkNote({ title: "Flat", body });
    const sections = chunks.filter((c) => c.chunkType === "section");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.breadcrumb).toBe("");
  });

  it("level-skip (H3 before H2) does not crash and trims breadcrumb correctly", () => {
    const body = [
      "### Lonely H3",
      "",
      "H3 body.",
      "",
      "## H2 after",
      "",
      "H2 body.",
      "",
    ].join("\n");
    const chunks = chunkNote({ title: "Skip", body });
    const sections = chunks.filter((c) => c.chunkType === "section");
    expect(sections.length).toBeGreaterThanOrEqual(2);
    // The H2 should NOT be nested under the H3 (different branch).
    expect(sections.some((s) => s.breadcrumb === "H2 after")).toBe(true);
  });
});

describe("chunkNote — anchor injection + hash determinism", () => {
  it("anchored text starts with title", () => {
    const chunks = chunkNote({ title: "Anchor", body: "Body line." });
    for (const c of chunks) {
      expect(c.anchored.startsWith("Anchor")).toBe(true);
    }
  });

  it("hashes are deterministic and 32 hex chars", () => {
    const a = chunkNote({ title: "T", body: "Body.\n\nMore." });
    const b = chunkNote({ title: "T", body: "Body.\n\nMore." });
    expect(a.map((c) => c.hash)).toEqual(b.map((c) => c.hash));
    for (const c of a) {
      expect(c.hash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("hash changes when body changes", () => {
    const a = chunkNote({ title: "T", body: "Original." });
    const b = chunkNote({ title: "T", body: "Modified." });
    const aBody = a.find((c) => c.chunkType === "body_full");
    const bBody = b.find((c) => c.chunkType === "body_full");
    expect(aBody?.hash).not.toBe(bBody?.hash);
    // Title chunk hash stays the same.
    const aTitle = a.find((c) => c.chunkType === "title");
    const bTitle = b.find((c) => c.chunkType === "title");
    expect(aTitle?.hash).toBe(bTitle?.hash);
  });
});

describe("helpers", () => {
  it("approximateTokens grows with input length", () => {
    expect(approximateTokens("")).toBe(0);
    expect(approximateTokens("a")).toBe(1);
    expect(approximateTokens("abcd")).toBe(1);
    expect(approximateTokens("a".repeat(40))).toBe(10);
  });

  it("hashChunk is stable + 32 chars", () => {
    expect(hashChunk("foo")).toBe(hashChunk("foo"));
    expect(hashChunk("foo")).toHaveLength(32);
    expect(hashChunk("foo")).not.toBe(hashChunk("bar"));
  });
});
