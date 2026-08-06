import { describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@lokyy/shared";

import {
  VAULT_INDEX_PATH,
  collectIndexFolders,
  renderVaultIndex,
  buildVaultIndexBody,
  isIndexStale,
  generateVaultIndex,
  type IndexFolderEntry,
} from "./indexGenerator.js";

/**
 * Story "Suchleiter + Pipeline" AC#1 — the deterministic INDEX.md generator.
 *
 * The whole point of this file is that NO LLM is involved: the same vault
 * tree must render the same bytes, forever. Everything below either pins
 * that property or pins the compaction behaviour that keeps a big vault's
 * index inside the line budget.
 */

function folder(name: string, children: TreeNode[]): TreeNode {
  return { type: "folder", name, path: name, children };
}
function note(path: string, title: string): TreeNode {
  return { type: "note", name: title, path, children: [] };
}

/** Small three-folder vault used by most cases below. */
const SAMPLE_TREE: TreeNode[] = [
  {
    type: "folder",
    name: "00_meta",
    path: "00_meta",
    children: [note("00_meta/KONVENTIONEN", "Konventionen")],
  },
  {
    type: "folder",
    name: "20_notes",
    path: "20_notes",
    children: [
      note("20_notes/zebra", "Zebra"),
      note("20_notes/alpha", "Alpha"),
    ],
  },
  {
    type: "folder",
    name: "10_projects",
    path: "10_projects",
    children: [
      note("10_projects/lokyy/README", "Lokyy"),
      {
        type: "folder",
        name: "lokyy",
        path: "10_projects/lokyy",
        children: [note("10_projects/lokyy/api", "API-Vertrag")],
      },
    ],
  },
];

describe("collectIndexFolders — flattening (AC#1)", () => {
  it("flattens nested folders into one path-sorted list", () => {
    const folders = collectIndexFolders(SAMPLE_TREE);
    expect(folders.map((f) => f.path)).toEqual([
      "00_meta",
      "10_projects",
      "10_projects/lokyy",
      "20_notes",
    ]);
  });

  it("sorts notes inside a folder by path (not by tree order)", () => {
    const folders = collectIndexFolders(SAMPLE_TREE);
    const notes = folders.find((f) => f.path === "20_notes");
    expect(notes?.notes.map((n) => n.path)).toEqual([
      "20_notes/alpha",
      "20_notes/zebra",
    ]);
  });

  it("drops empty folders (nothing to index there)", () => {
    const folders = collectIndexFolders([folder("99_archive", [])]);
    expect(folders).toEqual([]);
  });

  it("keeps root-level notes under a stable pseudo-folder", () => {
    const folders = collectIndexFolders([note("README", "Vault")]);
    expect(folders).toHaveLength(1);
    expect(folders[0]?.path).toBe("/");
    expect(folders[0]?.notes[0]?.path).toBe("README");
  });
});

describe("renderVaultIndex — determinism (AC#1)", () => {
  it("produces byte-identical output for the same input", () => {
    const folders = collectIndexFolders(SAMPLE_TREE);
    expect(renderVaultIndex(folders)).toBe(renderVaultIndex(folders));
  });

  it("carries no timestamp / clock-dependent text", () => {
    const out = renderVaultIndex(collectIndexFolders(SAMPLE_TREE));
    // A date anywhere in the body would break byte-identity across runs.
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("lists every note with its path", () => {
    const out = renderVaultIndex(collectIndexFolders(SAMPLE_TREE));
    expect(out).toContain("`20_notes/alpha`");
    expect(out).toContain("Alpha");
    expect(out).toContain("`10_projects/lokyy/api`");
  });

  it("renders the folder purpose line", () => {
    const folders: IndexFolderEntry[] = [
      { path: "20_notes", purpose: "Allgemeine Notizen.", notes: [note0()], totalNotes: 1 },
    ];
    expect(renderVaultIndex(folders)).toContain("Allgemeine Notizen.");
  });

  it("explains the search ladder so the index is self-teaching (AC#2/AC#4)", () => {
    const out = renderVaultIndex(collectIndexFolders(SAMPLE_TREE));
    expect(out).toContain("search_vault");
    expect(out).toContain("read_note");
  });
});

function note0() {
  return { title: "Alpha", path: "20_notes/alpha" };
}

describe("renderVaultIndex — line budget (AC#1: < ~500 Zeilen)", () => {
  /** 60 folders × 40 notes = 2400 notes — well past any sane budget. */
  const bigVault: IndexFolderEntry[] = Array.from({ length: 60 }, (_, f) => ({
    path: `f${String(f).padStart(2, "0")}`,
    purpose: `Ordner ${f}`,
    notes: Array.from({ length: 40 }, (_, n) => ({
      title: `Note ${n}`,
      path: `f${String(f).padStart(2, "0")}/n${n}`,
    })),
    totalNotes: 40,
  }));

  it("stays within the default 500-line budget on a large vault", () => {
    const lines = renderVaultIndex(bigVault).split("\n").length;
    expect(lines).toBeLessThanOrEqual(500);
  });

  it("summarises truncated folders instead of silently dropping notes", () => {
    const out = renderVaultIndex(bigVault);
    expect(out).toMatch(/weitere Notizen/);
    // The full count must still be visible so the agent knows what it can't see.
    expect(out).toContain("40 Notizen");
  });

  it("is still deterministic once compaction kicks in", () => {
    expect(renderVaultIndex(bigVault)).toBe(renderVaultIndex(bigVault));
  });

  it("does not truncate a vault that already fits", () => {
    const out = renderVaultIndex(collectIndexFolders(SAMPLE_TREE));
    expect(out).not.toMatch(/weitere Notizen/);
  });
});

describe("buildVaultIndexBody — purpose resolution (AC#1)", () => {
  it("prefers a folder README's first prose line as the purpose", async () => {
    const getNote = vi.fn(async (id: string) =>
      id === "10_projects/lokyy/README"
        ? {
            id,
            title: "Lokyy",
            body: "---\ntype: project\n---\n\n# Lokyy\n\nDas Programm-Dach für Brain und OS.\n",
          }
        : null,
    );
    const body = await buildVaultIndexBody({
      getTree: async () => SAMPLE_TREE,
      getNote: getNote as never,
    });
    expect(body).toContain("Das Programm-Dach für Brain und OS.");
  });

  it("falls back to the vault conventions purpose when there is no README", async () => {
    const body = await buildVaultIndexBody({
      getTree: async () => SAMPLE_TREE,
      getNote: async () => null,
    });
    // 20_notes has a conventions blurb in @lokyy/core's FOLDER_PURPOSE map.
    expect(body).toContain("General notes & insights");
  });

  it("never throws when a README read fails", async () => {
    const body = await buildVaultIndexBody({
      getTree: async () => SAMPLE_TREE,
      getNote: async () => {
        throw new Error("git backend down");
      },
    });
    expect(body).toContain("20_notes");
  });

  it("is idempotent — an unchanged vault yields identical bytes", async () => {
    const deps = { getTree: async () => SAMPLE_TREE, getNote: async () => null };
    expect(await buildVaultIndexBody(deps)).toBe(await buildVaultIndexBody(deps));
  });
});

describe("isIndexStale — 24h freshness gate (AC#4)", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");

  it("treats a missing updated field as stale", () => {
    expect(isIndexStale({}, now)).toBe(true);
  });

  it("treats an unparsable updated field as stale", () => {
    expect(isIndexStale({ updated: "gestern" }, now)).toBe(true);
  });

  it("is fresh inside 24h", () => {
    expect(isIndexStale({ updated: "2026-08-06T00:00:00.000Z" }, now)).toBe(false);
  });

  it("is stale past 24h", () => {
    expect(isIndexStale({ updated: "2026-08-04T00:00:00.000Z" }, now)).toBe(true);
  });
});

describe("generateVaultIndex — write path (AC#1)", () => {
  const deps = {
    getTree: async () => SAMPLE_TREE,
    getNote: async () => null,
  };

  it("writes SPEC-valid reference frontmatter through the injected save API", async () => {
    const save = vi.fn(async () => "abc123");
    const res = await generateVaultIndex({
      ...deps,
      save,
      now: new Date("2026-08-06T12:00:00.000Z"),
    });

    expect(res.path).toBe(VAULT_INDEX_PATH);
    expect(res.written).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    const [relPath, content] = save.mock.calls[0] as unknown as [string, string];
    expect(relPath).toBe("00_meta/INDEX.md");
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("type: reference");
    expect(content).toMatch(/id: '?[0-9A-HJKMNP-TV-Z]{26}'?/);
    expect(content).toContain("2026-08-06T12:00:00.000Z");
  });

  it("skips the write when the rendered body is unchanged (idempotent)", async () => {
    const first = await generateVaultIndex({ ...deps, save: async () => "sha" });
    const save = vi.fn(async () => "sha");
    const res = await generateVaultIndex({
      ...deps,
      save,
      existing: first.content,
    });
    expect(res.written).toBe(false);
    expect(save).not.toHaveBeenCalled();
    // Byte-identical: same id, same created, same body.
    expect(res.content).toBe(first.content);
  });

  it("preserves id and created from an existing index note", async () => {
    const existing =
      "---\nid: 01KSFC0T2J8XG91RV6Z6D825X9\ntype: reference\ntitle: Vault-Index\n" +
      "created: '2020-01-01T00:00:00.000Z'\nupdated: '2020-01-01T00:00:00.000Z'\n---\n\nveraltet\n";
    const res = await generateVaultIndex({
      ...deps,
      save: async () => "sha",
      existing,
      now: new Date("2026-08-06T12:00:00.000Z"),
    });
    expect(res.written).toBe(true);
    expect(res.content).toContain("01KSFC0T2J8XG91RV6Z6D825X9");
    expect(res.content).toContain("2020-01-01T00:00:00.000Z");
    expect(res.content).toContain("updated: '2026-08-06T12:00:00.000Z'");
  });

  it("still returns the content when the save fails (best-effort write)", async () => {
    const res = await generateVaultIndex({
      ...deps,
      save: async () => {
        throw new Error("forgejo unreachable");
      },
    });
    expect(res.written).toBe(false);
    expect(res.saveError).toContain("forgejo unreachable");
    expect(res.content).toContain("Vault-Index");
  });
});
