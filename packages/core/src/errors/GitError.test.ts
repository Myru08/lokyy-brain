import { describe, it, expect } from "vitest";

import {
  classifyGitError,
  PreCommitHookError,
  MergeConflictError,
  GitBackendError,
} from "./GitError.js";

/** Mimics an `execFile` rejection: an Error carrying `stderr`/`stdout`. */
function gitErr(stderr: string): Error & { stderr: string } {
  const e = new Error("Command failed: git pull") as Error & { stderr: string };
  e.stderr = stderr;
  return e;
}

describe("classifyGitError (Story 10.6 AC#3) — three distinct cases", () => {
  it("classifies a pre-commit-hook (frontmatter) rejection as PreCommitHookError", () => {
    const stderr = [
      "[ERROR] 00_meta/hooks/pre-commit: frontmatter validation failed",
      "  20_notes/x.md: missing required field 'id'",
      "error: hook declined to update refs",
    ].join("\n");

    const out = classifyGitError(gitErr(stderr), "20_notes/x.md");
    expect(out).toBeInstanceOf(PreCommitHookError);
    expect(out.stderr).toContain("frontmatter");
    // NEVER a blanket merge conflict.
    expect(out).not.toBeInstanceOf(MergeConflictError);
  });

  it("classifies a real rebase conflict as MergeConflictError", () => {
    const stderr = [
      "Auto-merging 20_notes/x.md",
      "CONFLICT (content): Merge conflict in 20_notes/x.md",
      "error: could not apply a1b2c3d... edit x",
    ].join("\n");

    const out = classifyGitError(gitErr(stderr), "20_notes/x.md");
    expect(out).toBeInstanceOf(MergeConflictError);
    expect((out as MergeConflictError).relPath).toBe("20_notes/x.md");
  });

  it("classifies a transient network failure as a retryable GitBackendError", () => {
    const out = classifyGitError(
      gitErr("fatal: unable to access 'https://forgejo/...': Could not resolve host: forgejo"),
    );
    expect(out).toBeInstanceOf(GitBackendError);
    expect((out as GitBackendError).transient).toBe(true);
  });

  it("classifies an auth failure as a non-transient GitBackendError", () => {
    const out = classifyGitError(
      gitErr("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://forgejo/x.git'"),
    );
    expect(out).toBeInstanceOf(GitBackendError);
    expect((out as GitBackendError).transient).toBe(false);
  });

  it("classifies the multi-branch refspec fatal as a GitBackendError (not a conflict)", () => {
    const out = classifyGitError(
      gitErr("fatal: Cannot rebase onto multiple branches"),
    );
    expect(out).toBeInstanceOf(GitBackendError);
    expect(out).not.toBeInstanceOf(MergeConflictError);
  });

  it("falls back to a non-transient GitBackendError for unrecognized stderr (never a blanket conflict)", () => {
    const out = classifyGitError(gitErr("something totally unexpected happened"));
    expect(out).toBeInstanceOf(GitBackendError);
    expect((out as GitBackendError).transient).toBe(false);
  });
});
