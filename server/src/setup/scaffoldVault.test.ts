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
  healVaultHook,
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
let planVaultScaffold: typeof import("./scaffoldVault.js").planVaultScaffold;
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
  ({ scaffoldVault, planVaultScaffold } = await import("./scaffoldVault.js"));
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
    // 19 + learning-area.json (Modul 15_lerngebiete, ADR-015).
    expect(shipped).toHaveLength(20);

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
      // Modul 15_lerngebiete (ADR-015) — die Vorlage für ein Lerngebiet.
      "learning-area.md",
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

/**
 * Story 1.20 — retrofitting the SAME scaffold onto an already-provisioned
 * vault. The fixture above is reused verbatim: `provisionVaultDir` leaves a
 * repo that has a git history but none of the scaffold, which is precisely the
 * shape of a pre-v1.9 install.
 */
describe("scaffoldVault — retrofit onto an existing vault (Story 1.20)", () => {
  /** Recursive snapshot of every file below `dir`, excluding `.git/`. */
  async function snapshot(dir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    async function walk(rel: string): Promise<void> {
      const entries = await readdir(join(dir, rel), { withFileTypes: true });
      for (const e of entries) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (child === ".git") continue;
        if (e.isDirectory()) await walk(child);
        else out.set(child, await readFile(join(dir, child), "utf8"));
      }
    }
    await walk("");
    return out;
  }

  it("dry-run reports the plan and writes NOTHING (AC#4, AC#8a)", async () => {
    const before = await snapshot(vaultDir);
    const headBefore = await g(vaultDir, ["rev-parse", "HEAD"]);

    const plan = await scaffoldVault({ vaultDir, dryRun: true });

    expect(plan.dryRun).toBe(true);
    expect(plan.created.length).toBeGreaterThan(0);
    expect(plan.committed).toBe(false);
    expect(plan.pushed).toBe(false);
    expect(plan.hookActivated).toBe(false);

    // Nothing on disk moved…
    expect(await snapshot(vaultDir)).toEqual(before);
    // …no commit happened…
    expect(await g(vaultDir, ["rev-parse", "HEAD"])).toBe(headBefore);
    // …the working copy is clean…
    expect(await g(vaultDir, ["status", "--porcelain"])).toBe("");
    // …and the hook was NOT silently activated (AC#5).
    await expect(g(vaultDir, ["config", "core.hooksPath"])).rejects.toBeTruthy();
  }, 30_000);

  it("the dry-run plan matches what the apply run actually creates (AC#4)", async () => {
    const plan = await scaffoldVault({ vaultDir, dryRun: true });
    const applied = await scaffoldVault({ vaultDir });

    expect(applied.created).toEqual(plan.created);
    expect(applied.skipped).toEqual(plan.skipped);
    expect(applied.dryRun).toBe(false);
  }, 30_000);

  it("a partially-scaffolded vault gets only the gaps, rest reported skipped (AC#8b)", async () => {
    // Simulate a hand-migrated vault that already carries SOME of the
    // structure: the SPEC and two folders, with content the user must keep.
    const full = await planVaultScaffold(vaultDir);
    await mkdir(join(vaultDir, "00_meta"), { recursive: true });
    await writeFile(join(vaultDir, "00_meta/SPEC.md"), "# Meine SPEC\n", "utf8");
    await mkdir(join(vaultDir, "20_notes"), { recursive: true });
    await writeFile(join(vaultDir, "20_notes/.gitkeep"), "", "utf8");

    const preexisting = ["00_meta/SPEC.md", "20_notes/.gitkeep"];

    const plan = await scaffoldVault({ vaultDir, dryRun: true });
    for (const p of preexisting) {
      expect(plan.skipped, `${p} should be reported as skipped`).toContain(p);
      expect(plan.created, `${p} must not be re-created`).not.toContain(p);
    }
    expect(plan.created.length).toBe(full.created.length - preexisting.length);

    const result = await scaffoldVault({ vaultDir });
    expect(result.created).toEqual(plan.created);
    expect(result.committed).toBe(true);
    // The user's own content survived untouched.
    expect(await readFile(join(vaultDir, "00_meta/SPEC.md"), "utf8")).toBe(
      "# Meine SPEC\n",
    );
    // …and the missing pieces really landed.
    expect(existsSync(join(vaultDir, "00_meta/schemas/note.json"))).toBe(true);
  }, 30_000);

  it("leaves core.hooksPath alone unless hook activation is asked for (AC#5)", async () => {
    const result = await scaffoldVault({ vaultDir, activateHook: false });

    expect(result.committed).toBe(true);
    expect(result.hookActivated).toBe(false);
    await expect(g(vaultDir, ["config", "core.hooksPath"])).rejects.toBeTruthy();

    // The hook FILE ships regardless — only its activation is gated, so a
    // later confirmation is a pure `git config` away.
    expect(existsSync(join(vaultDir, VAULT_HOOK_PATH))).toBe(true);
  }, 30_000);

  it("activates the hook on a second, explicitly-confirmed run (AC#5)", async () => {
    await scaffoldVault({ vaultDir, activateHook: false });

    const result = await scaffoldVault({ vaultDir, activateHook: true });
    expect(result.created).toEqual([]);
    expect(result.hookActivated).toBe(true);
    expect(await g(vaultDir, ["config", "core.hooksPath"])).toBe(VAULT_HOOKS_DIR);
  }, 30_000);

  it("keeps the fresh-install default: no options means hook ON", async () => {
    const result = await scaffoldVault({ vaultDir });
    expect(result.hookActivated).toBe(true);
    expect(await g(vaultDir, ["config", "core.hooksPath"])).toBe(VAULT_HOOKS_DIR);
  }, 30_000);
});

/**
 * Windows-CRLF-Blocker — der Weg durch den ECHTEN Installationspfad.
 *
 * `packages/core/src/vault/hookHealth.test.ts` prüft Normalisierung und
 * Self-Heal isoliert. Hier geht es um die Verdrahtung: dass `scaffoldVault`
 * (der Installer) den Hook wirklich LF + ausführbar ablegt, und dass der
 * Startup-Aufruf `healVaultHook()` OHNE Argumente — genau so, wie
 * `server/src/index.ts` ihn macht — den konfigurierten Vault findet und
 * repariert.
 */
describe("Pre-Commit-Hook: CRLF-Normalisierung + Self-Heal", () => {
  async function commit(message: string, args: string[] = []): Promise<void> {
    await exec("git", ["-C", vaultDir, "commit", ...args, "-m", message], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "w",
        GIT_AUTHOR_EMAIL: "w@localhost",
        GIT_COMMITTER_NAME: "w",
        GIT_COMMITTER_EMAIL: "w@localhost",
        LC_ALL: "C",
      },
    });
  }

  /** Eine SPEC-valide Notiz committen; `false` = der Hook hat abgebrochen. */
  async function commitNote(relPath: string): Promise<boolean> {
    const fm = {
      id: "01HPXY9Z0000000000000000AB",
      type: "note" as const,
      title: "Eine Notiz",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(join(vaultDir, relPath), serializeFrontmatter(fm, "Body.\n"), "utf8");
    await exec("git", ["-C", vaultDir, "add", "--", relPath]);
    try {
      await commit(`test: ${relPath}`);
      return true;
    } catch {
      await exec("git", ["-C", vaultDir, "reset", "--", relPath]).catch(() => {});
      return false;
    }
  }

  it("AC2 — der installierte Hook trägt kein einziges CR und ist ausführbar", async () => {
    await scaffoldVault({ vaultDir });

    const raw = await readFile(join(vaultDir, VAULT_HOOK_PATH), "utf8");
    expect(raw).not.toContain("\r");
    expect((await stat(join(vaultDir, VAULT_HOOK_PATH))).mode & 0o111).toBe(0o111);
    expect(await commitNote("20_notes/frisch.md")).toBe(true);
  }, 30_000);

  it("AC3 — ein versionierter CRLF-Hook blockiert alles und wird beim Start geheilt", async () => {
    await scaffoldVault({ vaultDir });

    // Zustand aus dem Feld nachstellen: Image aus einem Windows-Checkout.
    // `--no-verify`, weil mit scharfem CRLF-Hook auch dieser Commit stürbe.
    const hookAbs = join(vaultDir, VAULT_HOOK_PATH);
    await writeFile(hookAbs, (await readFile(hookAbs, "utf8")).replace(/\n/g, "\r\n"), "utf8");
    await exec("git", ["-C", vaultDir, "add", "--", VAULT_HOOK_PATH]);
    await commit("chore: hook aus Windows-Checkout", ["--no-verify"]);

    expect(await commitNote("20_notes/blockiert.md")).toBe(false);

    // Exakt der Aufruf aus `server/src/index.ts`: ohne Argumente, also über
    // `coreConfig().vaultDir`.
    const heal = await healVaultHook();

    expect(heal.status).toBe("healed");
    expect(heal.lineEndingsFixed).toBe(true);
    expect(heal.committed).toBe(true);
    expect(heal.error).toBeNull();
    expect(await readFile(hookAbs, "utf8")).not.toContain("\r");
    expect(await g(vaultDir, ["show", `HEAD:${VAULT_HOOK_PATH}`])).not.toContain("\r");
    expect(await commitNote("20_notes/wieder-frei.md")).toBe(true);
  }, 30_000);

  it("AC3 — ein gesunder Vault übersteht den Start-Heal ohne jede Änderung", async () => {
    await scaffoldVault({ vaultDir });
    const head = await g(vaultDir, ["rev-parse", "HEAD"]);

    const heal = await healVaultHook();

    expect(heal.status).toBe("ok");
    expect(heal.committed).toBe(false);
    expect(await g(vaultDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(await g(vaultDir, ["status", "--porcelain"])).toBe("");
  }, 30_000);
});
