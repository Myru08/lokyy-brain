import { describe, it, expect } from "vitest";

import {
  validateGitBranch,
  GitBranchValidationError,
  initCore,
  coreConfig,
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
