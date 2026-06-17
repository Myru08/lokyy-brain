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

  it("defaults to the PARA profile (no arg) and matches an explicit para call", () => {
    expect(getVaultConventions()).toEqual(getVaultConventions("para"));
  });
});

describe("getVaultConventions — karpathy profile (Story S2 / B1)", () => {
  const conv = getVaultConventions("karpathy");

  it("advertises exactly the three RAW/Wiki/Outputs types with their folders", () => {
    const byType = new Map(conv.types.map((t) => [t.type, t.folder]));
    expect(conv.types).toHaveLength(3);
    expect(byType.get("raw-source")).toBe("RAW");
    expect(byType.get("wiki-article")).toBe("Wiki");
    expect(byType.get("frage-report")).toBe("Outputs");
  });

  it("advertises the karpathy folders and NOT the PARA roots", () => {
    const paths = new Set(conv.folders.map((f) => f.path));
    expect(paths.has("RAW")).toBe(true);
    expect(paths.has("Wiki")).toBe(true);
    expect(paths.has("Outputs")).toBe(true);
    // PARA-only roots must not leak into the karpathy view.
    expect(paths.has("20_notes")).toBe(false);
    expect(paths.has("30_captures")).toBe(false);
  });

  it("dates RAW (raw-source) with an underscore, keeps Wiki/Outputs static (Story S3)", () => {
    // Story S3 — raw-source IS dated (`RAW/{YYYY-MM-DD}_slug`, underscore sep
    // per KONVENTIONEN RAW-Dateinamen-Vertrag). Wiki + Outputs stay static.
    const raw = conv.folders.find((f) => f.path === "RAW");
    const wiki = conv.folders.find((f) => f.path === "Wiki");
    const outputs = conv.folders.find((f) => f.path === "Outputs");
    expect(raw?.pathPattern).toBe("RAW/{YYYY-MM-DD}_slug");
    expect(wiki?.pathPattern).toBe("Wiki/slug");
    expect(outputs?.pathPattern).toBe("Outputs/slug");
    // The `ids` blurb stays profile-correct: karpathy shows the static
    // {folder}/slug summary (no dated example string).
    expect(conv.ids).not.toContain("{YYYY-MM-DD}");
  });

  it("keeps the same base frontmatter contract (id/type/title/created/updated)", () => {
    expect(conv.frontmatter.required).toEqual(
      expect.arrayContaining(["id", "type", "title", "created", "updated"]),
    );
  });

  it("advertises the SPEC-mandated 00_meta root (no type owns it)", () => {
    const paths = new Set(conv.folders.map((f) => f.path));
    expect(paths.has("00_meta")).toBe(true);
  });

  it("documents the RAW Hände-weg-Zone and the flat Wiki rule", () => {
    const raw = conv.folders.find((f) => f.path === "RAW");
    const wiki = conv.folders.find((f) => f.path === "Wiki");
    expect(raw?.purpose).toMatch(/RAW\/_<name>/);
    expect(raw?.purpose).toMatch(/Hände weg/);
    expect(wiki?.purpose).toMatch(/flach/);
  });

  it("lists the required vault files (AGENTS.md, CHANGELOG.md, …)", () => {
    expect(conv.requiredFiles).toEqual([
      "AGENTS.md",
      "CHANGELOG.md",
      "RAW/_INGESTED.md",
      "Wiki/INDEX.md",
      "Wiki/QUESTIONS.md",
    ]);
  });

  it("expresses the per-layer frontmatter rules (Option-Y-Vertrag)", () => {
    const byType = new Map(
      (conv.typeFrontmatter ?? []).map((r) => [r.type, r]),
    );
    expect(byType.get("raw-source")?.requiredExtra).toEqual([
      "author",
      "source_url",
      "date_added",
      "date_published",
      "source_type",
    ]);
    expect(byType.get("wiki-article")?.requiredExtra).toEqual(["status", "stand"]);
    expect(byType.get("wiki-article")?.optional).toContain("sources");
    expect(byType.get("frage-report")?.requiredExtra).toEqual([
      "question",
      "sources",
    ]);
  });

  it("documents the status-trias meaning", () => {
    expect(Object.keys(conv.statusTrias ?? {})).toEqual([
      "gesichert",
      "im Aufbau",
      "These",
    ]);
  });
});

describe("getVaultConventions — PARA stays free of karpathy-only fields", () => {
  it("leaves requiredFiles/typeFrontmatter/statusTrias undefined for PARA", () => {
    const conv = getVaultConventions("para");
    expect(conv.requiredFiles).toBeUndefined();
    expect(conv.typeFrontmatter).toBeUndefined();
    expect(conv.statusTrias).toBeUndefined();
  });
});
