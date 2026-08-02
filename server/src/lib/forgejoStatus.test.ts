import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Story 1.17 — the System tab reported Forgejo as permanently disconnected on
 * wizard-based installs because `GET /api/admin/status` probed `GIT_REMOTE`
 * (empty by design there) instead of the `vaults` row.
 *
 * Two things are asserted, and the second is the actual regression guard:
 *   1. Target resolution prefers the vault row over the env var (AC#1).
 *   2. The System tab (`/api/admin/status`) and the Diagnostics tab
 *      (`/api/diagnostics`) report the SAME verdict for the same underlying
 *      state (AC#3, AC#4) — including the broken-remote case, so a fix that
 *      just always reports "connected" fails here.
 *
 * No database and no network: resolution is tested through the pure
 * `pickForgejoTarget`, connectivity through real local bare repos.
 */

// `server/src/config.ts` reads process.env at module-import time and throws
// without DATABASE_URL — so the env must be set before the dynamic import.
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

// Type-only — erased at compile time, so it does not pull the module (and its
// env-reading `config` import) in before the guard above has run.
import type { ForgejoVerdict } from "./forgejoStatus.js";

type Mod = typeof import("./forgejoStatus.js");
let mod: Mod;

describe("pickForgejoTarget — which remote the probe uses (AC#1)", () => {
  beforeAll(async () => {
    mod = await import("./forgejoStatus.js");
  });

  const row = {
    gitRemote: "https://forgejo.example.com/oliver/vault.git",
    gitBranch: "main",
    ownerId: "01JOWNER00000000000000000",
  };

  it("uses the vault row's remote when GIT_REMOTE is empty (the reported bug)", () => {
    const target = mod.pickForgejoTarget(row, { gitRemote: "", gitBranch: "main" });

    expect(target).toEqual({
      gitRemote: row.gitRemote,
      gitBranch: "main",
      ownerId: row.ownerId,
    });
  });

  it("prefers the vault row over a stale GIT_REMOTE", () => {
    const target = mod.pickForgejoTarget(row, {
      gitRemote: "https://legacy.example.com/old/vault.git",
      gitBranch: "master",
    });

    expect(target?.gitRemote).toBe(row.gitRemote);
    expect(target?.gitBranch).toBe("main");
  });

  it("still honours GIT_REMOTE for legacy env-only deployments (no vault row)", () => {
    const target = mod.pickForgejoTarget(undefined, {
      gitRemote: "https://legacy.example.com/old/vault.git",
      gitBranch: "master",
    });

    expect(target).toEqual({
      gitRemote: "https://legacy.example.com/old/vault.git",
      gitBranch: "master",
      // No vault row → no owner → anonymous probe.
      ownerId: null,
    });
  });

  it("returns null when neither the vault row nor the env has a remote", () => {
    expect(mod.pickForgejoTarget(undefined, { gitRemote: "", gitBranch: "main" })).toBeNull();
    expect(
      mod.pickForgejoTarget({ ...row, gitRemote: "" }, { gitRemote: "", gitBranch: "main" }),
    ).toBeNull();
  });
});

describe("Forgejo verdict — System tab and Diagnostics tab agree (AC#3, AC#4)", () => {
  let base: string;
  let reachableRemote: string;

  beforeAll(async () => {
    mod = await import("./forgejoStatus.js");
    base = await mkdtemp(join(tmpdir(), "lokyy-forgejo-status-"));
    // A real bare repo stands in for a reachable Forgejo remote — `ls-remote`
    // behaves identically over a local path, without needing a server.
    reachableRemote = join(base, "vault.git");
    await exec("git", ["init", "--bare", "--initial-branch=main", reachableRemote]);
    const seed = join(base, "seed");
    await exec("git", ["clone", reachableRemote, seed]);
    await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "seed"], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "lokyy-test",
        GIT_AUTHOR_EMAIL: "test@localhost",
        GIT_COMMITTER_NAME: "lokyy-test",
        GIT_COMMITTER_EMAIL: "test@localhost",
      },
    });
    await exec("git", ["-C", seed, "push", "origin", "main"]);
  }, 60_000);

  afterAll(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  /** The two tabs' renderings of one and the same verdict. */
  const bothTabs = (verdict: ForgejoVerdict) => ({
    system: mod.toStatusEntry(verdict),
    diagnostics: mod.toDiagnosticFields(verdict),
  });

  it("reports connected for a reachable vault remote — while GIT_REMOTE is empty", async () => {
    const verdict = await mod.checkForgejoTarget({
      gitRemote: reachableRemote,
      gitBranch: "main",
      ownerId: null,
    });

    expect(verdict.ok).toBe(true);
    const { system, diagnostics } = bothTabs(verdict);
    expect(system.ok).toBe(true);
    expect(diagnostics.ok).toBe(true);
    expect(system.severity).toBe(diagnostics.severity);
  });

  it("still reports a genuinely unreachable remote as an error", async () => {
    const verdict = await mod.checkForgejoTarget({
      gitRemote: join(base, "does-not-exist.git"),
      gitBranch: "main",
      ownerId: null,
    });

    // The guard against a fix that just paints the tab green.
    expect(verdict.ok).toBe(false);
    expect(verdict.severity).toBe("error");
    const { system, diagnostics } = bothTabs(verdict);
    expect(system.ok).toBe(false);
    expect(diagnostics.ok).toBe(false);
    expect(system.severity).toBe(diagnostics.severity);
    expect(system.error).toBe(diagnostics.detail);
  });

  it("treats 'no vault row yet' as info, not an error, on both tabs", async () => {
    const verdict = await mod.checkForgejoTarget(null);

    expect(verdict.ok).toBe(false);
    expect(verdict.severity).toBe("info");
    const { system, diagnostics } = bothTabs(verdict);
    expect(system.severity).toBe("info");
    expect(diagnostics.severity).toBe("info");
    // Same operator-facing sentence in both places.
    expect(system.error).toBe(diagnostics.detail);
    expect(system.error).toContain("Setup-Wizard");
  });

  it("keeps the OAuth token out of the error surfaced to the client", async () => {
    const token = "s3cret-oauth-token";
    const message = `fatal: could not read from https://oauth2:${token}@forgejo.example.com/o/v.git`;

    const safe = mod.stripTokenFromMessage(message, token);

    expect(safe).not.toContain(token);
    expect(safe).toContain("oauth2:***@");
  });
});
