import { describe, it, expect, beforeEach } from "vitest";

import {
  validateGitBranch,
  GitBranchValidationError,
  initCore,
  coreConfig,
  withCoreConfig,
  vaultConfigFor,
  vaultWorkingCopyPath,
  vaultsRoot,
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
