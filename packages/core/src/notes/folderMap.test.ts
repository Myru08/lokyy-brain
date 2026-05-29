import { describe, it, expect } from "vitest";

import { DOC_TYPES } from "../frontmatter/types.js";
import {
  TYPE_FOLDER,
  folderForType,
  isDatedType,
  derivePathForType,
  checkPathMatchesType,
  canonicalFolders,
} from "./folderMap.js";

describe("folderMap — canonical type→folder map (Story 10.2, AC#3)", () => {
  it("covers EVERY DOC_TYPE (no gaps, no drift)", () => {
    for (const type of DOC_TYPES) {
      expect(TYPE_FOLDER[type], `missing folder for type "${type}"`).toBeTruthy();
      expect(typeof folderForType(type)).toBe("string");
    }
    expect(Object.keys(TYPE_FOLDER).sort()).toEqual([...DOC_TYPES].sort());
  });

  it("maps the verified canonical placements", () => {
    expect(folderForType("note")).toBe("20_notes");
    expect(folderForType("capture")).toBe("30_captures");
    expect(folderForType("project")).toBe("10_projects");
    expect(folderForType("task")).toBe("40_tasks");
    expect(folderForType("decision")).toBe("50_decisions");
    expect(folderForType("meeting")).toBe("60_meetings");
    expect(folderForType("customer")).toBe("40_customers");
    expect(folderForType("intervention")).toBe("70_pai/interventions");
    expect(folderForType("skill")).toBe("70_pai/skills");
    // Story 10.15 — extended type enum.
    expect(folderForType("tool")).toBe("35_tools");
    expect(folderForType("resource")).toBe("30_captures");
    expect(folderForType("reference")).toBe("20_notes");
  });

  it("canonicalFolders() returns a de-duplicated folder list", () => {
    const folders = canonicalFolders();
    expect(new Set(folders).size).toBe(folders.length);
    expect(folders).toContain("20_notes");
    expect(folders).toContain("70_pai/skills");
  });
});

describe("derivePathForType — path derivation (Story 10.2, AC#4)", () => {
  const FIXED = new Date("2026-05-29T12:00:00.000Z");

  it("plain `{folder}/{slug}` for non-dated types", () => {
    expect(derivePathForType("note", "my-insight", FIXED)).toBe(
      "20_notes/my-insight",
    );
    expect(derivePathForType("decision", "use-pgvector", FIXED)).toBe(
      "50_decisions/use-pgvector",
    );
    expect(derivePathForType("skill", "wochenrueckblick", FIXED)).toBe(
      "70_pai/skills/wochenrueckblick",
    );
  });

  it("dated `{folder}/{YYYY-MM-DD}-{slug}` for captures + tasks", () => {
    expect(isDatedType("capture")).toBe(true);
    expect(isDatedType("task")).toBe(true);
    expect(isDatedType("note")).toBe(false);

    expect(derivePathForType("capture", "yt-video", FIXED)).toBe(
      "30_captures/2026-05-29-yt-video",
    );
    expect(derivePathForType("task", "ship-it", FIXED)).toBe(
      "40_tasks/2026-05-29-ship-it",
    );
  });

  it("strips stray leading/trailing slashes from slug", () => {
    expect(derivePathForType("note", "/slug/", FIXED)).toBe("20_notes/slug");
  });
});

describe("folderMap — extended type enum (Story 10.15)", () => {
  const FIXED = new Date("2026-05-29T12:00:00.000Z");

  it("places tool/resource/reference in their canonical folders", () => {
    expect(folderForType("tool")).toBe("35_tools");
    expect(folderForType("resource")).toBe("30_captures");
    expect(folderForType("reference")).toBe("20_notes");
  });

  it("treats all three as STATIC (non-dated) types", () => {
    expect(isDatedType("tool")).toBe(false);
    expect(isDatedType("resource")).toBe(false);
    expect(isDatedType("reference")).toBe(false);
  });

  it("derives plain {folder}/{slug} paths (no date prefix)", () => {
    expect(derivePathForType("tool", "ripgrep", FIXED)).toBe("35_tools/ripgrep");
    expect(derivePathForType("resource", "ajv-docs", FIXED)).toBe(
      "30_captures/ajv-docs",
    );
    expect(derivePathForType("reference", "ulid-spec", FIXED)).toBe(
      "20_notes/ulid-spec",
    );
  });

  it("accepts canonical placement via the guard", () => {
    expect(checkPathMatchesType("tool", "35_tools/x").ok).toBe(true);
    expect(checkPathMatchesType("resource", "30_captures/x").ok).toBe(true);
    expect(checkPathMatchesType("reference", "20_notes/x").ok).toBe(true);
  });
});

describe("checkPathMatchesType — placement guard (Story 10.2, AC#5)", () => {
  it("accepts the exact canonical folder", () => {
    expect(checkPathMatchesType("note", "20_notes/foo").ok).toBe(true);
    expect(checkPathMatchesType("decision", "50_decisions/adr-1").ok).toBe(true);
  });

  it("accepts valid sub-folders under the canonical top folder", () => {
    expect(checkPathMatchesType("capture", "30_captures/youtube/foo").ok).toBe(
      true,
    );
    expect(checkPathMatchesType("capture", "30_captures/voice/bar").ok).toBe(
      true,
    );
    expect(checkPathMatchesType("skill", "70_pai/skills/sub/x").ok).toBe(true);
  });

  it("rejects a contradictory folder with a structured payload", () => {
    const res = checkPathMatchesType("capture", "20_notes/x");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.type).toBe("capture");
      expect(res.expectedFolder).toBe("30_captures");
      expect(res.gotPath).toBe("20_notes/x");
    }
  });

  it("does NOT confuse a prefix-similar folder (segment-aware)", () => {
    // `20_notes_archive` must NOT count as under `20_notes`.
    expect(checkPathMatchesType("note", "20_notes_archive/x").ok).toBe(false);
  });
});
