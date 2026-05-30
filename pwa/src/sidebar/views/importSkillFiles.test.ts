import { describe, expect, it } from "vitest";
import { collectSkillUpload } from "./importSkillFiles.js";

/**
 * collectSkillUpload normalises a webkitdirectory FileList into
 * { suggestedName, files (relative to skill root), hasSkillMd }. These tests
 * pin the path-stripping, name-derivation, hidden-file filtering and SKILL.md
 * detection — pure, no DOM/network beyond the `File` web type (jsdom).
 */

/** Build a `File` carrying a `webkitRelativePath` like a real directory pick. */
function dirFile(relativePath: string, content = "x"): File {
  const name = relativePath.split("/").pop() ?? relativePath;
  const file = new File([content], name, { type: "text/plain" });
  Object.defineProperty(file, "webkitRelativePath", {
    value: relativePath,
    configurable: true,
  });
  return file;
}

describe("collectSkillUpload", () => {
  it("derives the skill name from the top folder and strips it from paths", () => {
    const result = collectSkillUpload([
      dirFile("My Skill/SKILL.md"),
      dirFile("My Skill/references/layout.md"),
      dirFile("My Skill/templates/dashboard.jsx"),
    ]);

    expect(result.suggestedName).toBe("my-skill");
    expect(result.hasSkillMd).toBe(true);
    expect(result.files.map((f) => f.relPath)).toEqual([
      "SKILL.md",
      "references/layout.md",
      "templates/dashboard.jsx",
    ]);
  });

  it("sorts SKILL.md first, then alphabetically", () => {
    const result = collectSkillUpload([
      dirFile("s/templates/z.txt"),
      dirFile("s/references/a.md"),
      dirFile("s/SKILL.md"),
    ]);
    expect(result.files.map((f) => f.relPath)).toEqual([
      "SKILL.md",
      "references/a.md",
      "templates/z.txt",
    ]);
  });

  it("drops hidden files and folders (.DS_Store, .git/…)", () => {
    const result = collectSkillUpload([
      dirFile("s/SKILL.md"),
      dirFile("s/.DS_Store"),
      dirFile("s/.git/config"),
    ]);
    expect(result.files.map((f) => f.relPath)).toEqual(["SKILL.md"]);
  });

  it("flags a missing SKILL.md at the root", () => {
    const result = collectSkillUpload([
      dirFile("s/references/a.md"),
      dirFile("s/notes.md"),
    ]);
    expect(result.hasSkillMd).toBe(false);
    expect(result.files.map((f) => f.relPath)).toEqual([
      "notes.md",
      "references/a.md",
    ]);
  });

  it("keeps paths unchanged and name empty for a flat multi-file pick", () => {
    // No common top folder → nothing to strip, name not derivable.
    const a = new File(["x"], "SKILL.md");
    const b = new File(["x"], "extra.md");
    const result = collectSkillUpload([a, b]);
    expect(result.suggestedName).toBe("");
    expect(result.hasSkillMd).toBe(true);
    expect(result.files.map((f) => f.relPath).sort()).toEqual([
      "SKILL.md",
      "extra.md",
    ]);
  });

  it("dedupes repeated relative paths (first wins)", () => {
    const result = collectSkillUpload([
      dirFile("s/SKILL.md", "first"),
      dirFile("s/SKILL.md", "second"),
    ]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.relPath).toBe("SKILL.md");
  });

  it("returns an empty, SKILL.md-less result for an empty pick", () => {
    const result = collectSkillUpload([]);
    expect(result.files).toEqual([]);
    expect(result.hasSkillMd).toBe(false);
    expect(result.suggestedName).toBe("");
  });
});
