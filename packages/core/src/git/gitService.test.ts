import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initCore } from "../util/coreConfig.js";
import { save } from "./gitService.js";

const exec = promisify(execFile);

/**
 * Sets up an isolated `git init` working copy WITHOUT a remote — the
 * documented pre-setup state (server up, setup wizard hasn't wired a Forgejo
 * repo yet). Returns the abs path to the working copy (registered as
 * VAULT_DIR via initCore) plus a cleanup hook.
 */
async function setupRemotelessVault(): Promise<{
  workdir: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-noremote-"));
  const workdir = join(base, "work");
  await exec("git", ["init", "--initial-branch=main", workdir]);

  initCore({
    vaultDir: workdir,
    gitRemote: "", // wizard not run yet
    gitBranch: "main",
    gitAuthorName: "lokyy-test",
    gitAuthorEmail: "test@localhost",
  });

  return {
    workdir,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

let vault: Awaited<ReturnType<typeof setupRemotelessVault>>;

beforeAll(async () => {
  vault = await setupRemotelessVault();
});

afterAll(async () => {
  await vault.cleanup();
});

describe("gitService.save — remote-aware (no-remote vault, Story 9-5 seed loop)", () => {
  it("commits locally and does NOT throw when there is no remote", async () => {
    const rel = "70_pai/skills/x.md";
    const sha = await save(rel, "first skill body\n", "seed: x");

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(vault.workdir, rel), "utf8")).toBe(
      "first skill body\n",
    );
  });

  it("a second save directly after also works (the seed loop break)", async () => {
    const rel = "70_pai/skills/y.md";
    const sha = await save(rel, "second skill body\n", "seed: y");

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(vault.workdir, rel), "utf8")).toBe(
      "second skill body\n",
    );

    // Both seeds are real local commits — no remote was touched.
    const { stdout } = await exec("git", ["-C", vault.workdir, "log", "--oneline"]);
    expect(stdout).toContain("seed: x");
    expect(stdout).toContain("seed: y");
  });
});
