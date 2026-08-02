/**
 * Story 1.19 AC#8 — a freshly provisioned vault really ends up with the
 * canonical folders, the full current schema set and the SPEC hook.
 *
 * Runs against a REAL throwaway git repo (`mkdtemp` + `provisionVaultDir`),
 * following the fixture pattern of `packages/core/src/git/gitService.test.ts`:
 * the assertion that matters is "did it survive the commit", which a mocked
 * filesystem cannot answer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initCore,
  provisionVaultDir,
  scaffoldFolders,
  VAULT_HOOKS_DIR,
  VAULT_HOOK_PATH,
  serializeFrontmatter,
} from "@lokyy/core";
const exec = promisify(execFile);

// `server/src/config.ts` reads process.env at MODULE-IMPORT time and throws on a
// missing DATABASE_URL, so both modules under test are imported dynamically
// AFTER the env is set (same pattern as routes/tenants.test.ts). No database is
// ever contacted here — the DSN only has to be non-empty.
let scaffoldVault: typeof import("./scaffoldVault.js").scaffoldVault;
let seedSkills: typeof import("./seedSkills.js").seedSkills;
let buildSkillFrontmatter: typeof import("./seedSkills.js").buildSkillFrontmatter;
let seedSkillDefinitions: typeof import("./seedSkills.js").seedSkillDefinitions;

const SCHEMA_SRC_DIR = fileURLToPath(
  new URL("../../../packages/core/src/frontmatter/schemas/", import.meta.url),
);

let base: string;
let vaultDir: string;

async function g(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, ...args], {
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lokyy-scaffold-"));
  vaultDir = join(base, "vault");

  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
  process.env.VAULT_DIR = vaultDir;
  process.env.GIT_AUTHOR_NAME = "lokyy-test";
  process.env.GIT_AUTHOR_EMAIL = "test@localhost";
  ({ scaffoldVault } = await import("./scaffoldVault.js"));
  ({ seedSkills, buildSkillFrontmatter, seedSkillDefinitions } = await import(
    "./seedSkills.js"
  ));

  initCore({
    vaultDir,
    vaultsRoot: join(base, "vaults"),
    gitRemote: "",
    gitBranch: "main",
    gitAuthorName: "lokyy-test",
    gitAuthorEmail: "test@localhost",
  });

  await provisionVaultDir({ targetDir: vaultDir });
}, 30_000);

afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe("scaffoldVault — fresh install (Story 1.19)", () => {
  it("creates every canonical folder and makes it survive the commit (AC#1/#2)", async () => {
    await scaffoldVault({ vaultDir });

    const tracked = (await g(vaultDir, ["ls-files"])).split("\n");
    for (const folder of scaffoldFolders("para")) {
      expect(existsSync(join(vaultDir, folder)), `${folder} missing`).toBe(true);
      expect(tracked, `${folder} not committed`).toContain(`${folder}/.gitkeep`);
    }
  }, 30_000);

  it("populates 00_meta/schemas/ with the FULL current schema set (AC#3)", async () => {
    await scaffoldVault({ vaultDir });

    const expected = (await readdir(SCHEMA_SRC_DIR)).filter((f) => f.endsWith(".json"));
    const shipped = await readdir(join(vaultDir, "00_meta/schemas"));
    expect(shipped.sort()).toEqual(expected.sort());
    expect(shipped).toHaveLength(19);

    // Not the reference vault's stale subset / naming.
    expect(shipped).toContain("customer.json");
    expect(shipped).toContain("skill.json");
    expect(shipped).not.toContain("note.schema.json");

    const note = JSON.parse(
      await readFile(join(vaultDir, "00_meta/schemas/note.json"), "utf8"),
    );
    expect(note.$id).toBe("lokyy://frontmatter/note");
  }, 30_000);

  it("installs the pre-commit hook, executable and ACTIVE via core.hooksPath (AC#4)", async () => {
    await scaffoldVault({ vaultDir });

    const hook = join(vaultDir, VAULT_HOOK_PATH);
    expect(existsSync(hook)).toBe(true);
    expect((await stat(hook)).mode & 0o111).toBeGreaterThan(0);
    expect(await g(vaultDir, ["config", "core.hooksPath"])).toBe(VAULT_HOOKS_DIR);
    expect(await g(vaultDir, ["ls-files"])).toContain(VAULT_HOOK_PATH);
  }, 30_000);

  it("ships SPEC.md + templates and leaves nothing uncommitted (AC#5)", async () => {
    await scaffoldVault({ vaultDir });

    expect(existsSync(join(vaultDir, "00_meta/SPEC.md"))).toBe(true);
    const templates = await readdir(join(vaultDir, "00_meta/templates"));
    expect(templates.sort()).toEqual([
      "capture.md",
      "decision.md",
      "note.md",
      "project.md",
      "task.md",
    ]);
    expect(await g(vaultDir, ["status", "--porcelain"])).toBe("");
  }, 30_000);

  it("is idempotent — a re-run touches nothing and never overwrites user edits", async () => {
    const first = await scaffoldVault({ vaultDir });
    expect(first.created.length).toBeGreaterThan(0);
    expect(first.committed).toBe(true);

    const specPath = join(vaultDir, "00_meta/SPEC.md");
    await writeFile(specPath, "# Meine eigene SPEC\n", "utf8");
    await exec("git", ["-C", vaultDir, "commit", "-am", "user edit"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "u",
        GIT_AUTHOR_EMAIL: "u@localhost",
        GIT_COMMITTER_NAME: "u",
        GIT_COMMITTER_EMAIL: "u@localhost",
      },
    });

    const second = await scaffoldVault({ vaultDir });
    expect(second.created).toEqual([]);
    expect(second.committed).toBe(false);
    expect(await readFile(specPath, "utf8")).toBe("# Meine eigene SPEC\n");
  }, 30_000);

  it("leaves the seeded skills committable — the hook does not lock out our own writes", async () => {
    await scaffoldVault({ vaultDir });

    // seedSkills' real content, written + committed through the hooked repo.
    const results = await seedSkills({
      vaultDir,
      writer: async (relPath, content) => {
        const abs = join(vaultDir, relPath);
        await mkdir(join(vaultDir, "70_pai/skills"), { recursive: true });
        await writeFile(abs, content, "utf8");
        await exec("git", ["-C", vaultDir, "add", "--", relPath]);
        await exec("git", ["-C", vaultDir, "commit", "-m", `seed ${relPath}`], {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "s",
            GIT_AUTHOR_EMAIL: "s@localhost",
            GIT_COMMITTER_NAME: "s",
            GIT_COMMITTER_EMAIL: "s@localhost",
            LC_ALL: "C",
          },
        });
      },
    });

    expect(results.every((r) => r.status === "created")).toBe(true);
    expect(await g(vaultDir, ["ls-files", "70_pai/skills"])).toContain(
      "70_pai/skills/wochenrueckblick.md",
    );
  }, 30_000);

  it("rejects a SPEC-violating write once scaffolded (the hook is genuinely live)", async () => {
    await scaffoldVault({ vaultDir });

    await writeFile(join(vaultDir, "20_notes/kaputt.md"), "kein frontmatter\n", "utf8");
    await exec("git", ["-C", vaultDir, "add", "-A"]);
    await expect(
      exec("git", ["-C", vaultDir, "commit", "-m", "should fail"], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "x",
          GIT_AUTHOR_EMAIL: "x@localhost",
          GIT_COMMITTER_NAME: "x",
          GIT_COMMITTER_EMAIL: "x@localhost",
          LC_ALL: "C",
        },
      }),
    ).rejects.toBeTruthy();
  }, 30_000);

  it("writes a real skill note that passes the hook (frontmatter round-trip)", async () => {
    await scaffoldVault({ vaultDir });

    const seed = seedSkillDefinitions[0];
    const content = serializeFrontmatter(buildSkillFrontmatter(seed), seed.body);
    await writeFile(join(vaultDir, "70_pai/skills", `${seed.slug}.md`), content, "utf8");
    await exec("git", ["-C", vaultDir, "add", "-A"]);
    await exec("git", ["-C", vaultDir, "commit", "-m", "skill"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "x",
        GIT_AUTHOR_EMAIL: "x@localhost",
        GIT_COMMITTER_NAME: "x",
        GIT_COMMITTER_EMAIL: "x@localhost",
        LC_ALL: "C",
      },
    });
    expect(await g(vaultDir, ["ls-files", "70_pai/skills"])).toContain(seed.slug);
  }, 30_000);
});
