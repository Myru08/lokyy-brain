import { describe, expect, it } from "vitest";
import { buildCreatePath, safeName } from "./paths.js";

describe("safeName", () => {
  it("keeps a clean name unchanged", () => {
    expect(safeName("Daily Note")).toBe("Daily Note");
  });

  it("preserves internal spaces (Obsidian-faithful) but trims the ends", () => {
    expect(safeName("  My Note  ")).toBe("My Note");
  });

  it("strips path separators so a name cannot inject a sub-folder", () => {
    expect(safeName("foo/bar")).toBe("foobar");
    expect(safeName("a\\b")).toBe("ab");
  });

  it("strips the full cross-platform-illegal set : * ? \" < > |", () => {
    expect(safeName('a:b*c?d"e<f>g|h')).toBe("abcdefgh");
  });

  it("returns empty string for a name made entirely of unsafe chars", () => {
    expect(safeName("///")).toBe("");
    expect(safeName("   ")).toBe("");
  });
});

describe("buildCreatePath", () => {
  it("joins a sanitised name under a parent folder", () => {
    expect(buildCreatePath("70_pai/notes", "Hermes")).toBe(
      "70_pai/notes/Hermes",
    );
  });

  it("returns the bare name when parentPath is empty (vault root)", () => {
    expect(buildCreatePath("", "Hermes")).toBe("Hermes");
  });

  it("sanitises the name before joining (no separator injection)", () => {
    expect(buildCreatePath("inbox", "evil/../escape")).toBe(
      "inbox/evil..escape",
    );
  });

  it("trims whitespace from the name before joining", () => {
    expect(buildCreatePath("inbox", "  spaced  ")).toBe("inbox/spaced");
  });

  it("returns null when the name sanitises to empty (handleCreate no-op)", () => {
    expect(buildCreatePath("inbox", "   ")).toBeNull();
    expect(buildCreatePath("", "////")).toBeNull();
  });
});
