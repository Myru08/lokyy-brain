import { describe, it, expect } from "vitest";

import { getVaultConventions } from "./index.js";
import { DOC_TYPES } from "../frontmatter/types.js";
import { TYPE_FOLDER, canonicalFolders } from "../notes/folderMap.js";

describe("getVaultConventions (Story 10.4)", () => {
  const conv = getVaultConventions();

  it("includes every DOC_TYPE with its canonical folder from folderMap (no drift)", () => {
    const byType = new Map(conv.types.map((t) => [t.type, t]));
    for (const type of DOC_TYPES) {
      const entry = byType.get(type);
      expect(entry, `missing type ${type}`).toBeDefined();
      // AC#5 — the folder MUST equal folderMap's single source of truth.
      expect(entry!.folder).toBe(TYPE_FOLDER[type]);
      expect(entry!.meaning.length).toBeGreaterThan(0);
    }
    // No extra types beyond the closed DOC_TYPES list.
    expect(conv.types).toHaveLength(DOC_TYPES.length);
  });

  it("contains every canonical folder from folderMap", () => {
    const folderPaths = new Set(conv.folders.map((f) => f.path));
    for (const folder of canonicalFolders()) {
      expect(folderPaths.has(folder), `missing folder ${folder}`).toBe(true);
    }
  });

  it("includes the SPEC top-level roots required by AC#3", () => {
    const folderPaths = new Set(conv.folders.map((f) => f.path));
    for (const root of [
      "00_meta",
      "10_projects",
      "20_notes",
      "30_captures",
      "35_tools",
      "50_decisions",
      "70_pai/interventions",
      "70_pai/skills",
      "70_pai/sessions",
      "90_ideas",
      "99_archive",
    ]) {
      expect(folderPaths.has(root), `missing root ${root}`).toBe(true);
    }
  });

  it("uses the dated path pattern for dated folders (30_captures) and static otherwise", () => {
    const captures = conv.folders.find((f) => f.path === "30_captures");
    expect(captures?.pathPattern).toBe("30_captures/{YYYY-MM-DD}-slug");
    const notes = conv.folders.find((f) => f.path === "20_notes");
    expect(notes?.pathPattern).toBe("20_notes/slug");
  });

  it("summarises the required frontmatter fields (id/type/title/created/updated)", () => {
    expect(conv.frontmatter.required).toEqual(
      expect.arrayContaining(["id", "type", "title", "created", "updated"]),
    );
    const idField = conv.frontmatter.fields.find((f) => f.field === "id");
    expect(idField?.required).toBe(true);
    const tagsField = conv.frontmatter.fields.find((f) => f.field === "tags");
    expect(tagsField?.required).toBe(false);
  });

  it("documents wikilink, tag and ULID conventions", () => {
    expect(conv.wikilinks).toMatch(/\[\[/);
    expect(conv.tags).toMatch(/#tag/);
    expect(conv.ids).toMatch(/ULID/);
    // The dated-path example is derived from folderMap, not hand-typed.
    expect(conv.ids).toContain("30_captures/2026-01-15-slug");
  });
});
