import { describe, it, expect } from "vitest";

import {
  classifyGitError,
  HookExecutionError,
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

describe("AC4 — ein NICHT AUSFÜHRBARER Hook ist kein Frontmatter-Fehler", () => {
  // Die Signatur aus dem echten Windows-CRLF-Fall, verifiziert gegen git 2.43:
  // ein CRLF-Shebang lässt den Kernel `/bin/sh\r` suchen.
  const SIGNATURES = [
    "fatal: cannot exec '.githooks/pre-commit': No such file or directory",
    "error: cannot run .githooks/pre-commit: No such file or directory",
    "error: cannot spawn .git/hooks/pre-commit: Exec format error",
  ];

  it.each(SIGNATURES)("klassifiziert %s als HookExecutionError", (stderr) => {
    const out = classifyGitError(gitErr(stderr), "20_notes/x.md");
    expect(out).toBeInstanceOf(HookExecutionError);
    // Das ist der eigentliche Bug: die Meldung enthält „pre-commit" und wurde
    // deshalb als „ungültige Frontmatter" gemeldet — falsche Fährte.
    expect(out).not.toBeInstanceOf(PreCommitHookError);
    expect(out).not.toBeInstanceOf(MergeConflictError);
  });

  it("erklärt dem User, was zu tun ist (Reparatur beim nächsten Start)", () => {
    const out = classifyGitError(
      gitErr("fatal: cannot exec '.githooks/pre-commit': No such file or directory"),
    );
    expect(out.message).toContain("beschädigt");
    expect(out.message).toContain("neu starten");
    expect(out.message).not.toContain("Frontmatter");
  });

  it("lässt eine ECHTE Frontmatter-Ablehnung unverändert PreCommitHookError", () => {
    const out = classifyGitError(
      gitErr(
        [
          "FAIL 20_notes/x.md",
          "     missing required frontmatter field(s): id",
          "",
          "1 file(s) violate the vault SPEC. Commit aborted.",
        ].join("\n"),
      ),
      "20_notes/x.md",
    );
    expect(out).toBeInstanceOf(PreCommitHookError);
    expect(out).not.toBeInstanceOf(HookExecutionError);
  });

  // Abgrenzung: das Verb allein reicht nicht — nach „cannot run" muss auch der
  // Hook-Pfad stehen. Sonst würde eine Hook-AUSGABE, die zufällig „cannot run"
  // enthält, als Infrastruktur-Defekt gemeldet und die echte Ursache
  // (kaputte Frontmatter) verschwinden.
  it("stuft eine Hook-Ausgabe mit dem Wort „cannot run\" weiter als PreCommitHookError ein", () => {
    const out = classifyGitError(
      gitErr("pre-commit: cannot run the checks on this file — frontmatter missing"),
    );
    expect(out).toBeInstanceOf(PreCommitHookError);
    expect(out).not.toBeInstanceOf(HookExecutionError);
  });
});
