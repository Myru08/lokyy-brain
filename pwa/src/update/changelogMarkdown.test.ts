import { describe, expect, it } from "vitest";
import {
  highlightToPlainText,
  parseHighlight,
  tokenizeInline,
} from "./changelogMarkdown.js";

/**
 * The strings below are copied verbatim from the live `CHANGELOG.md` v1.11
 * section — the exact payload `GET /api/system/version` hands the banner.
 * Rendering them raw would put `###` and `**` in front of a user who never
 * opens a terminal, which is precisely the audience this feature exists for.
 */
const REAL_HEADING = "### Lokyy Brain ist jetzt Open Source";
const REAL_BULLET =
  "- **Lizenz: AGPL-3.0.** Der Quellcode ist öffentlich. Du darfst Lokyy Brain nutzen, verändern und weitergeben — privat wie geschäftlich.";
const REAL_ITALIC =
  "- Die Bedingung greift, wenn jemand eine *veränderte* Version anbietet.";
const REAL_CODE = "- Beiträge sind willkommen — siehe `CONTRIBUTING.md`.";

describe("parseHighlight", () => {
  it("reads a changelog sub-heading as a heading and drops the hashes", () => {
    expect(parseHighlight(REAL_HEADING)).toEqual({
      kind: "heading",
      text: "Lokyy Brain ist jetzt Open Source",
    });
  });

  it("reads a bullet as an item and drops the dash", () => {
    expect(parseHighlight(REAL_BULLET).kind).toBe("item");
    expect(parseHighlight(REAL_BULLET).text.startsWith("- ")).toBe(false);
    expect(parseHighlight(REAL_BULLET).text.startsWith("**Lizenz")).toBe(true);
  });

  it("handles the other list markers the changelog may use", () => {
    expect(parseHighlight("* Punkt").text).toBe("Punkt");
    expect(parseHighlight("+ Punkt").text).toBe("Punkt");
    expect(parseHighlight("1. Punkt").text).toBe("Punkt");
    expect(parseHighlight("2) Punkt").text).toBe("Punkt");
  });

  it("treats a plain paragraph as an item and survives non-strings", () => {
    expect(parseHighlight("Einfach ein Satz.")).toEqual({
      kind: "item",
      text: "Einfach ein Satz.",
    });
    expect(parseHighlight(undefined)).toEqual({ kind: "item", text: "" });
    expect(parseHighlight(null)).toEqual({ kind: "item", text: "" });
  });
});

describe("tokenizeInline", () => {
  it("turns **bold** into a strong run without markers", () => {
    const tokens = tokenizeInline(parseHighlight(REAL_BULLET).text);
    expect(tokens[0]).toEqual({ type: "strong", value: "Lizenz: AGPL-3.0." });
    expect(tokens.map((t) => t.value).join("")).not.toContain("*");
  });

  it("turns *italic* into an em run", () => {
    const tokens = tokenizeInline(parseHighlight(REAL_ITALIC).text);
    expect(tokens).toContainEqual({ type: "em", value: "veränderte" });
  });

  it("turns `code` into a code run without backticks", () => {
    const tokens = tokenizeInline(parseHighlight(REAL_CODE).text);
    expect(tokens).toContainEqual({ type: "code", value: "CONTRIBUTING.md" });
    expect(tokens.map((t) => t.value).join("")).not.toContain("`");
  });

  it("keeps the label of a link and drops the URL", () => {
    expect(tokenizeInline("siehe [die Doku](https://example.test/x) dort")).toEqual([
      { type: "text", value: "siehe " },
      { type: "text", value: "die Doku" },
      { type: "text", value: " dort" },
    ]);
  });

  it("does not read snake_case identifiers as italics", () => {
    const tokens = tokenizeInline("Die Variable LOKYY_UPDATE_CHECK zählt.");
    expect(tokens).toEqual([
      { type: "text", value: "Die Variable LOKYY_UPDATE_CHECK zählt." },
    ]);
  });

  it("drops an unbalanced marker left behind by the server's 300-char cut", () => {
    // The server truncates long items with an ellipsis, which can cut a
    // `**bold**` pair in half. The remaining `**` must never reach the DOM.
    const cut = tokenizeInline("Ein Punkt mit **abgeschnittenem Fettdruck…");
    expect(cut.map((t) => t.value).join("")).not.toContain("*");
  });

  it("survives a non-string", () => {
    expect(tokenizeInline(undefined)).toEqual([]);
  });
});

describe("highlightToPlainText", () => {
  it("yields marker-free text for the real changelog lines", () => {
    for (const raw of [REAL_HEADING, REAL_BULLET, REAL_ITALIC, REAL_CODE]) {
      const plain = highlightToPlainText(raw);
      expect(plain).not.toMatch(/[*`#]/);
      expect(plain.trim().length).toBeGreaterThan(0);
    }
  });
});
