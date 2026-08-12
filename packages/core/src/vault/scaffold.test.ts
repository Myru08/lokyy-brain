import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildVaultScaffold,
  scaffoldFolders,
  VAULT_HOOKS_DIR,
  VAULT_HOOK_PATH,
  type ScaffoldFile,
} from "./scaffold.js";
import { TYPE_FOLDER } from "../notes/folderMap.js";
import { getProfileSpec } from "../frontmatter/profiles.js";
import { getVaultConventions } from "../conventions/index.js";

const SCHEMA_SRC_DIR = fileURLToPath(
  new URL("../frontmatter/schemas/", import.meta.url),
);

function byPath(files: ScaffoldFile[]): Map<string, ScaffoldFile> {
  return new Map(files.map((f) => [f.path, f]));
}

describe("scaffoldFolders — derived, never hardcoded (Story 1.19 AC#2)", () => {
  it("contains every folder the PARA type→folder map actually writes into", () => {
    const folders = scaffoldFolders("para");
    for (const folder of new Set(Object.values(TYPE_FOLDER))) {
      expect(folders, `missing write-target ${folder}`).toContain(folder);
    }
  });

  it("contains the documented roots that no type owns yet (00_meta, 99_archive)", () => {
    const folders = scaffoldFolders("para");
    expect(folders).toContain("00_meta");
    expect(folders).toContain("99_archive");
    expect(folders).toContain("90_ideas");
  });

  it("never mixes another profile's folders into a PARA vault", () => {
    const folders = scaffoldFolders("para");
    for (const foreign of Object.values(getProfileSpec("karpathy").typeFolder)) {
      expect(folders, `leaked karpathy folder ${foreign}`).not.toContain(foreign);
    }
  });

  it("scaffolds the karpathy layer for a karpathy vault", () => {
    const folders = scaffoldFolders("karpathy");
    expect(folders).toEqual(expect.arrayContaining(["RAW", "Wiki", "Outputs", "00_meta"]));
    expect(folders).not.toContain("20_notes");
  });

  it("stays in sync with the conventions surface agents are told about", () => {
    const advertised = getVaultConventions("para")
      .folders.map((f) => f.path)
      // conventions advertises the karpathy layer to PARA agents too; the
      // scaffold deliberately only creates the active profile's folders.
      .filter((p) => !["RAW", "Wiki", "Outputs"].includes(p));
    expect(scaffoldFolders("para").sort()).toEqual(advertised.sort());
  });
});

describe("buildVaultScaffold — folders (AC#1)", () => {
  it("emits a .gitkeep for every folder so git actually tracks it", async () => {
    const files = await buildVaultScaffold("para");
    const paths = new Set(files.map((f) => f.path));
    for (const folder of scaffoldFolders("para")) {
      expect(paths, `${folder} would not survive the commit`).toContain(
        `${folder}/.gitkeep`,
      );
    }
  });
});

describe("buildVaultScaffold — schemas (AC#3)", () => {
  it("ships EVERY live schema, byte-for-byte, under 00_meta/schemas/", async () => {
    const onDisk = (await readdir(SCHEMA_SRC_DIR)).filter((f) => f.endsWith(".json"));
    const files = byPath(await buildVaultScaffold("para"));

    // The count is asserted explicitly: the story exists because a stale
    // 7-schema set was the trap. If a schema is added, this number moves WITH
    // the directory — but the equality below is the real guard.
    // 19 + learning-area.json (Modul 15_lerngebiete, ADR-015) = 20.
    expect(onDisk.length).toBe(20);

    for (const name of onDisk) {
      const scaffolded = files.get(`00_meta/schemas/${name}`);
      expect(scaffolded, `schema ${name} missing from scaffold`).toBeDefined();
      const source = JSON.parse(await readFile(SCHEMA_SRC_DIR + name, "utf8"));
      expect(JSON.parse(scaffolded!.content)).toEqual(source);
    }
  });

  it("uses the code's filename convention (note.json), not the reference vault's", async () => {
    const paths = new Set((await buildVaultScaffold("para")).map((f) => f.path));
    expect(paths).toContain("00_meta/schemas/note.json");
    expect(paths).not.toContain("00_meta/schemas/note.schema.json");
  });

  it("ships the same schema set regardless of profile", async () => {
    const para = (await buildVaultScaffold("para"))
      .map((f) => f.path)
      .filter((p) => p.startsWith("00_meta/schemas/"));
    const karpathy = (await buildVaultScaffold("karpathy"))
      .map((f) => f.path)
      .filter((p) => p.startsWith("00_meta/schemas/"));
    expect(karpathy.sort()).toEqual(para.sort());
  });
});

describe("buildVaultScaffold — hook, SPEC, templates (AC#4/#5)", () => {
  it("installs the pre-commit hook executable at .githooks/pre-commit", async () => {
    const hook = byPath(await buildVaultScaffold("para")).get(VAULT_HOOK_PATH);
    expect(VAULT_HOOK_PATH).toBe(`${VAULT_HOOKS_DIR}/pre-commit`);
    expect(hook).toBeDefined();
    expect(hook!.executable).toBe(true);
    expect(hook!.content.startsWith("#!/bin/sh")).toBe(true);
  });

  it("ships SPEC.md and the five note templates", async () => {
    const paths = new Set((await buildVaultScaffold("para")).map((f) => f.path));
    expect(paths).toContain("00_meta/SPEC.md");
    for (const t of ["note", "capture", "task", "project", "decision"]) {
      expect(paths).toContain(`00_meta/templates/${t}.md`);
    }
  });

  it("renders SPEC.md's folder/type tables from the live conventions", async () => {
    const spec = byPath(await buildVaultScaffold("para")).get("00_meta/SPEC.md")!;
    // No placeholder may survive into the generated vault.
    expect(spec.content).not.toContain("<!-- lokyy:");
    for (const folder of scaffoldFolders("para")) {
      expect(spec.content, `SPEC.md omits ${folder}`).toContain(`\`${folder}\``);
    }
    for (const type of getProfileSpec("para").docTypes) {
      expect(spec.content, `SPEC.md omits type ${type}`).toContain(`\`${type}\``);
    }
  });

  it("carries no trace of the reference vault's branding (AC#5)", async () => {
    for (const file of await buildVaultScaffold("para")) {
      expect(file.content.toLowerCase(), `branding leaked into ${file.path}`).not.toMatch(
        /paione|aiianer/,
      );
    }
  });

  it("references no external repo — the scaffold is generated in-repo (AC#6)", async () => {
    for (const file of await buildVaultScaffold("para")) {
      expect(file.content, `external source referenced in ${file.path}`).not.toMatch(
        /github\.com\/[\w-]+\/paione-vault/,
      );
    }
  });
});
