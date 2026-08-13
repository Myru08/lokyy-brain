import { describe, it, expect, beforeEach, afterAll } from "vitest";

import {
  validateGitBranch,
  GitBranchValidationError,
  initCore,
  coreConfig,
  withCoreConfig,
  vaultConfigFor,
  vaultWorkingCopyPath,
  vaultsRoot,
  indexVaultId,
  invalidateActiveVaultId,
  setCachedActiveVaultId,
  getCachedActiveVaultId,
} from "./coreConfig.js";

describe("validateGitBranch (Story 10.6 AC#1)", () => {
  it("accepts a clean single-token branch", () => {
    expect(validateGitBranch("main")).toBe("main");
    expect(validateGitBranch("feature/foo")).toBe("feature/foo");
    expect(validateGitBranch("release-1.2")).toBe("release-1.2");
  });

  it("trims surrounding whitespace down to the token", () => {
    expect(validateGitBranch("  main  ")).toBe("main");
    expect(validateGitBranch("\tmain\n")).toBe("main");
  });

  it("rejects an internal-whitespace value (would emit two refspecs)", () => {
    // This is the exact shape that produced
    // `fatal: Cannot rebase onto multiple branches`.
    expect(() => validateGitBranch("main feature")).toThrow(
      GitBranchValidationError,
    );
    expect(() => validateGitBranch("main\tother")).toThrow(
      GitBranchValidationError,
    );
  });

  it("rejects empty / whitespace-only input", () => {
    expect(() => validateGitBranch("")).toThrow(GitBranchValidationError);
    expect(() => validateGitBranch("   ")).toThrow(GitBranchValidationError);
  });

  it("rejects git-illegal ref characters", () => {
    for (const bad of ["ma:in", "ma~in", "ma^in", "ma?in", "ma*in", "ma[in"]) {
      expect(() => validateGitBranch(bad)).toThrow(GitBranchValidationError);
    }
  });

  it("rejects a leading dash (would be read as a git flag)", () => {
    expect(() => validateGitBranch("-rf")).toThrow(GitBranchValidationError);
  });
});

describe("initCore validates gitBranch at the injection boundary (AC#1)", () => {
  it("normalizes a whitespace-padded branch on inject", () => {
    initCore({
      vaultDir: "/tmp/x",
      gitRemote: "",
      gitBranch: "  main ",
      gitAuthorName: "t",
      gitAuthorEmail: "t@localhost",
    });
    expect(coreConfig().gitBranch).toBe("main");
  });

  it("throws when injected with a multi-token branch", () => {
    expect(() =>
      initCore({
        vaultDir: "/tmp/x",
        gitRemote: "",
        gitBranch: "main other",
        gitAuthorName: "t",
        gitAuthorEmail: "t@localhost",
      }),
    ).toThrow(GitBranchValidationError);
  });
});

describe("multi-tenant config context (LBMT-1.2)", () => {
  beforeEach(() => {
    initCore({
      vaultDir: "/var/lokyy/vault",
      gitRemote: "https://forgejo/owner/personal.git",
      gitBranch: "main",
      gitAuthorName: "lokyy",
      gitAuthorEmail: "lokyy@localhost",
    });
  });

  it("coreConfig() returns the singleton when no context is active", () => {
    expect(coreConfig().vaultDir).toBe("/var/lokyy/vault");
  });

  it("withCoreConfig overrides config inside fn and reverts after", () => {
    const inside = withCoreConfig(
      vaultConfigFor({ vaultId: "cust-a", gitRemote: "https://forgejo/owner/a.git" }),
      () => coreConfig().vaultDir,
    );
    expect(inside).toBe("/var/lokyy/vaults/cust-a");
    // reverted outside the callback
    expect(coreConfig().vaultDir).toBe("/var/lokyy/vault");
  });

  it("context propagates across awaits in the async call tree", async () => {
    const seen = await withCoreConfig(
      vaultConfigFor({ vaultId: "cust-a", gitRemote: "https://forgejo/owner/a.git" }),
      async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        return coreConfig().vaultDir;
      },
    );
    expect(seen).toBe("/var/lokyy/vaults/cust-a");
  });

  it("nested contexts resolve to the innermost, then unwind", () => {
    const trail: string[] = [];
    withCoreConfig(
      vaultConfigFor({ vaultId: "a", gitRemote: "https://forgejo/owner/a.git" }),
      () => {
        trail.push(coreConfig().vaultDir);
        withCoreConfig(
          vaultConfigFor({ vaultId: "b", gitRemote: "https://forgejo/owner/b.git" }),
          () => {
            trail.push(coreConfig().vaultDir);
          },
        );
        trail.push(coreConfig().vaultDir);
      },
    );
    expect(trail).toEqual([
      "/var/lokyy/vaults/a",
      "/var/lokyy/vaults/b",
      "/var/lokyy/vaults/a",
    ]);
  });

  it("concurrent contexts do not bleed into each other", async () => {
    const run = (id: string) =>
      withCoreConfig(
        vaultConfigFor({ vaultId: id, gitRemote: `https://forgejo/owner/${id}.git` }),
        async () => {
          // Yield so the two contexts genuinely interleave on the event loop.
          await new Promise((r) => setTimeout(r, 2));
          return coreConfig().vaultDir;
        },
      );
    const [a, b] = await Promise.all([run("a"), run("b")]);
    expect(a).toBe("/var/lokyy/vaults/a");
    expect(b).toBe("/var/lokyy/vaults/b");
  });

  it("vaultConfigFor carries the per-vault remote + branch override", () => {
    const cfg = vaultConfigFor({
      vaultId: "cust-a",
      gitRemote: "https://forgejo/owner/a.git",
      gitBranch: "trunk",
    });
    expect(cfg.vaultDir).toBe("/var/lokyy/vaults/cust-a");
    expect(cfg.gitRemote).toBe("https://forgejo/owner/a.git");
    expect(cfg.gitBranch).toBe("trunk");
  });

  it("vaultConfigFor carries the vault's OWN id (issue #43 — index follows the switch)", () => {
    // Regression: the rebind used to leave vaultId as the singleton's, so a
    // switched request wrote the git working copy to vault A but indexed under
    // the singleton — search and index split across vaults.
    const cfg = vaultConfigFor({ vaultId: "cust-a", gitRemote: "https://forgejo/owner/a.git" });
    expect(cfg.vaultId).toBe("cust-a");
    const insideId = withCoreConfig(
      vaultConfigFor({ vaultId: "cust-b", gitRemote: "https://forgejo/owner/b.git" }),
      () => indexVaultId(),
    );
    expect(insideId).toBe("cust-b");
  });

  it("vaultsRoot defaults to a 'vaults' sibling of the singleton vaultDir", () => {
    expect(vaultsRoot()).toBe("/var/lokyy/vaults");
    expect(vaultWorkingCopyPath("xyz")).toBe("/var/lokyy/vaults/xyz");
  });

  it("vaultsRoot honors an explicit CoreConfig.vaultsRoot override", () => {
    initCore({
      vaultDir: "/var/lokyy/vault",
      vaultsRoot: "/data/customer-vaults",
      gitRemote: "",
      gitBranch: "main",
      gitAuthorName: "lokyy",
      gitAuthorEmail: "lokyy@localhost",
    });
    expect(vaultsRoot()).toBe("/data/customer-vaults");
    expect(vaultWorkingCopyPath("v1")).toBe("/data/customer-vaults/v1");
  });
});

describe("indexVaultId resolution order (issue #43)", () => {
  const prevPin = process.env.LOKYY_VAULT_ID;
  const prevDefault = process.env.LOKYY_DEFAULT_VAULT;

  beforeEach(() => {
    // No env pin — force the injected/cache/placeholder ladder.
    delete process.env.LOKYY_VAULT_ID;
    delete process.env.LOKYY_DEFAULT_VAULT;
    invalidateActiveVaultId();
  });

  afterAll(() => {
    if (prevPin === undefined) delete process.env.LOKYY_VAULT_ID;
    else process.env.LOKYY_VAULT_ID = prevPin;
    if (prevDefault === undefined) delete process.env.LOKYY_DEFAULT_VAULT;
    else process.env.LOKYY_DEFAULT_VAULT = prevDefault;
    invalidateActiveVaultId();
  });

  const baseInit = (vaultId?: string) =>
    initCore({
      vaultDir: "/var/lokyy/vault",
      gitRemote: "",
      gitBranch: "main",
      gitAuthorName: "lokyy",
      gitAuthorEmail: "lokyy@localhost",
      ...(vaultId ? { vaultId } : {}),
    });

  it("an injected vault id always wins", () => {
    baseInit("01REAL_INJECTED_VAULT_ID00");
    expect(indexVaultId()).toBe("01REAL_INJECTED_VAULT_ID00");
  });

  it("falls back to the cached deterministic id when nothing is injected", () => {
    baseInit(); // vaultId empty → initCore invalidates the cache
    setCachedActiveVaultId("01CACHED_REAL_VAULT_ID0000");
    expect(getCachedActiveVaultId()).toBe("01CACHED_REAL_VAULT_ID0000");
    expect(indexVaultId()).toBe("01CACHED_REAL_VAULT_ID0000");
  });

  it("falls back to the 'default' placeholder only when nothing is injected AND nothing is cached", () => {
    baseInit();
    invalidateActiveVaultId(); // ensure the cache is empty
    // No DB is initialized here, so the background primer kicked off inside
    // indexVaultId() resolves to nothing (swallowed) — the sync return is the
    // placeholder.
    expect(indexVaultId()).toBe("default");
  });

  it("honors LOKYY_DEFAULT_VAULT as the placeholder override", () => {
    process.env.LOKYY_DEFAULT_VAULT = "legacy-placeholder";
    baseInit();
    invalidateActiveVaultId();
    expect(indexVaultId()).toBe("legacy-placeholder");
  });
});
