import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initCore } from "../util/coreConfig.js";
import { save, pull, move, noteHistory, noteDiff } from "./gitService.js";
import { MergeConflictError, GitBackendError } from "../errors/GitError.js";

const exec = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "lokyy-test",
  GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "lokyy-test",
  GIT_COMMITTER_EMAIL: "test@localhost",
  LC_ALL: "C",
  LANG: "C",
};

/** Runs git in `cwd` with the test identity + C locale. */
async function g(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

/**
 * Points the shared core config at `workdir`. Because `gitService` reads a
 * module-level singleton, every suite re-asserts its own vault before running
 * (suites in one file share that singleton).
 */
function useVault(workdir: string, gitRemote: string): void {
  initCore({
    vaultDir: workdir,
    gitRemote,
    gitBranch: "main",
    gitAuthorName: "lokyy-test",
    gitAuthorEmail: "test@localhost",
  });
}

// ─── No-remote vault (pre-setup state, Story 9-5 seed loop) ────────────────

async function setupRemotelessVault(): Promise<{
  workdir: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-noremote-"));
  const workdir = join(base, "work");
  await exec("git", ["init", "--initial-branch=main", workdir], { env: GIT_ENV });
  return {
    workdir,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

describe("gitService.save — remote-aware (no-remote vault, Story 9-5 seed loop)", () => {
  let vault: Awaited<ReturnType<typeof setupRemotelessVault>>;

  beforeAll(async () => {
    vault = await setupRemotelessVault();
  });
  afterAll(async () => {
    await vault.cleanup();
  });
  beforeEach(() => {
    useVault(vault.workdir, ""); // wizard not run yet
  });

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

    const { stdout } = await exec("git", ["-C", vault.workdir, "log", "--oneline"], {
      env: GIT_ENV,
    });
    expect(stdout).toContain("seed: x");
    expect(stdout).toContain("seed: y");
  });
});

// ─── Real bare remote — idempotency + classification (Story 10.6 AC#2/#3) ──

/**
 * Bare remote + working-copy clone + a separate `other` clone (the second
 * concurrent writer). Re-seeded fresh per test so each scenario is isolated.
 */
async function setupVaultWithRemote(): Promise<{
  workdir: string;
  remote: string;
  other: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-remote-"));
  const remote = join(base, "remote.git");
  const workdir = join(base, "work");
  const other = join(base, "other");

  await g(base, ["init", "--bare", "--initial-branch=main", remote]);

  // Seed the remote with a base commit via the `other` clone.
  await g(base, ["clone", remote, other]);
  await mkdir(join(other, "20_notes"), { recursive: true });
  await writeFile(join(other, "20_notes/x.md"), "base\n", "utf8");
  await g(other, ["add", "--", "20_notes/x.md"]);
  await g(other, ["commit", "-m", "seed"]);
  await g(other, ["push", "origin", "main"]);

  // Our working copy.
  await g(base, ["clone", remote, workdir]);

  return {
    workdir,
    remote,
    other,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

describe("gitService.save — idempotency + classification on pull failure (Story 10.6 AC#2/#3)", () => {
  let v: Awaited<ReturnType<typeof setupVaultWithRemote>>;

  beforeEach(async () => {
    v = await setupVaultWithRemote();
    useVault(v.workdir, v.remote);
  });
  afterEach(async () => {
    if (v) await v.cleanup();
  });

  it("treats a benign race (remote already has the intended content) as success", async () => {
    const rel = "20_notes/x.md";
    const wanted = "agreed line\n";

    // The other writer pushes the SAME content we are about to save. Our local
    // commit then can't replay cleanly, so `pull --rebase` fails — but the
    // remote ALREADY carries exactly the bytes the user wanted. The idempotency
    // probe (origin/main:rel == intended) recovers it: no throw.
    await writeFile(join(v.other, "20_notes/x.md"), wanted, "utf8");
    await g(v.other, ["add", "--", rel]);
    await g(v.other, ["commit", "-m", "remote: agreed line"]);
    await g(v.other, ["push", "origin", "main"]);

    const sha = await save(rel, wanted, "local: agreed line");

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(v.workdir, rel), "utf8")).toBe(wanted);
  });

  it("still throws MergeConflictError on a genuine divergent conflict", async () => {
    const rel = "20_notes/x.md";

    // Remote moves the line one way…
    await writeFile(join(v.other, "20_notes/x.md"), "remote divergent\n", "utf8");
    await g(v.other, ["add", "--", rel]);
    await g(v.other, ["commit", "-m", "remote: divergent"]);
    await g(v.other, ["push", "origin", "main"]);

    // …we move the SAME line a DIFFERENT way. origin/main:rel != our intended
    // content → real conflict, surfaced as a typed MergeConflictError.
    await expect(
      save(rel, "local divergent\n", "local: divergent"),
    ).rejects.toBeInstanceOf(MergeConflictError);
  });

  it("classifies an unreachable remote as a (transient) GitBackendError, not a conflict", async () => {
    const rel = "20_notes/x.md";

    // Point origin at a path that does not exist → fetch/pull fails with a
    // backend error. We still have a local commit; the idempotency probe can't
    // find origin/main, so it falls through to classification.
    await g(v.workdir, [
      "remote",
      "set-url",
      "origin",
      join(v.workdir, "..", "does-not-exist.git"),
    ]);

    await expect(
      save(rel, "offline edit\n", "local: offline"),
    ).rejects.toBeInstanceOf(GitBackendError);
  });
});

// ─── Story 10.12: FIFO serialization + same-note coalescing ────────────────

/** Like `useVault`, but lets a test toggle the AC#2 coalescing switch. */
function useVaultCoalesce(
  workdir: string,
  gitRemote: string,
  coalesceSameNoteSaves: boolean,
): void {
  initCore({
    vaultDir: workdir,
    gitRemote,
    gitBranch: "main",
    gitAuthorName: "lokyy-test",
    gitAuthorEmail: "test@localhost",
    coalesceSameNoteSaves,
  });
}

/** Count commits whose subject mentions `needle`. */
async function countCommits(workdir: string, needle: string): Promise<number> {
  const { stdout } = await exec(
    "git",
    ["-C", workdir, "log", "--pretty=%s"],
    { env: GIT_ENV },
  );
  return stdout.split("\n").filter((l) => l.includes(needle)).length;
}

describe("gitService — FIFO serialization (Story 10.12 AC#1)", () => {
  let vault: Awaited<ReturnType<typeof setupRemotelessVault>>;

  beforeAll(async () => {
    vault = await setupRemotelessVault();
  });
  afterAll(async () => {
    await vault.cleanup();
  });
  beforeEach(() => {
    // Coalescing OFF so EACH save is its own observable op — this isolates the
    // serialization (ordering) guarantee from the coalescing behavior.
    useVaultCoalesce(vault.workdir, "", false);
  });

  it("runs concurrently-issued saves to DIFFERENT notes strictly in order", async () => {
    // Fire 8 saves without awaiting between them. With a real FIFO lock each
    // git op fully completes before the next begins, so the commit log appears
    // in exactly submission order (no interleaving / lost commit).
    const n = 8;
    const dir = "20_notes/serial";
    const ops = Array.from({ length: n }, (_, i) =>
      save(`${dir}/n${i}.md`, `body ${i}\n`, `serial-${i}`),
    );
    const shas = await Promise.all(ops);

    // All resolved to a real commit hash, all distinct (each its own commit).
    expect(new Set(shas).size).toBe(n);

    const { stdout } = await exec(
      "git",
      ["-C", vault.workdir, "log", "--pretty=%s", "--reverse"],
      { env: GIT_ENV },
    );
    const subjects = stdout.split("\n").filter((s) => s.startsWith("serial-"));
    expect(subjects).toEqual(
      Array.from({ length: n }, (_, i) => `serial-${i}`),
    );

    // Every file landed with its intended content.
    for (let i = 0; i < n; i++) {
      expect(await readFile(join(vault.workdir, dir, `n${i}.md`), "utf8")).toBe(
        `body ${i}\n`,
      );
    }
  });

  it("does not starve a read (pull) issued amid a write batch — fairness", async () => {
    // Interleave a pull() in the middle of a write burst. The shared FIFO lock
    // must let the pull take its slot and resolve; it must not hang behind an
    // unbounded write backlog. (Remoteless pull is a fast no-op, which is
    // exactly what we want to prove: the read gets its turn promptly.)
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 5; i++) {
      ops.push(save(`20_notes/fair/w${i}.md`, `w${i}\n`, `fair-w-${i}`));
    }
    const readPromise = pull(); // queued amid the writes
    for (let i = 5; i < 10; i++) {
      ops.push(save(`20_notes/fair/w${i}.md`, `w${i}\n`, `fair-w-${i}`));
    }

    // The read resolves (does not hang) and all writes land.
    await expect(readPromise).resolves.toBeUndefined();
    await Promise.all(ops);
    expect(await countCommits(vault.workdir, "fair-w-")).toBe(10);
  });

  it("a failing op does not cancel the next queued op (lock stays alive)", async () => {
    // `move` of a nonexistent path rejects. The save queued right after it must
    // still run — a poisoned predecessor must never break the FIFO chain.
    const bad = move("does/not/exist.md", "20_notes/moved.md", "bad-move");
    const good = save("20_notes/after-fail.md", "ok\n", "after-fail");

    await expect(bad).rejects.toBeTruthy();
    await expect(good).resolves.toMatch(/^[0-9a-f]{40}$/);
    expect(
      await readFile(join(vault.workdir, "20_notes/after-fail.md"), "utf8"),
    ).toBe("ok\n");
  });
});

describe("gitService — same-note coalescing (Story 10.12 AC#2/#3)", () => {
  let v: Awaited<ReturnType<typeof setupVaultWithRemote>>;

  beforeEach(async () => {
    v = await setupVaultWithRemote();
  });
  afterEach(async () => {
    if (v) await v.cleanup();
  });

  it("coalesces N rapid saves to the SAME note: last content wins, fewer pushes, every caller resolves", async () => {
    useVaultCoalesce(v.workdir, v.remote, true);
    const rel = "20_notes/typing.md";
    const n = 12;

    // Fire a keystroke storm without awaiting between calls. Saves that arrive
    // while an earlier one is still queued coalesce into a single push.
    const ops = Array.from({ length: n }, (_, i) =>
      save(rel, `keystroke ${i}\n`, `type-${i}`),
    );
    const shas = await Promise.all(ops);

    // AC#3: every caller resolved (no dropped promise) to a valid commit hash.
    expect(shas).toHaveLength(n);
    for (const sha of shas) expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // AC#2: the LAST issued content is what is persisted on disk + upstream.
    expect(await readFile(join(v.workdir, rel), "utf8")).toBe(
      `keystroke ${n - 1}\n`,
    );
    const remoteContent = await exec(
      "git",
      ["-C", v.workdir, "show", `origin/main:${rel}`],
      { env: GIT_ENV },
    );
    expect(remoteContent.stdout).toBe(`keystroke ${n - 1}\n`);

    // AC#2: coalescing collapsed the storm — strictly fewer commits than calls.
    // (One leader runs first; the rest pile into the next single op, so we
    // expect roughly 2, never N. Assert the structural property: < n.)
    const commits = await countCommits(v.workdir, "type-");
    expect(commits).toBeGreaterThanOrEqual(1);
    expect(commits).toBeLessThan(n);
  });

  it("with coalescing OFF, every same-note save is its own commit (last still wins)", async () => {
    useVaultCoalesce(v.workdir, v.remote, false);
    const rel = "20_notes/typing.md";
    const n = 5;

    const ops = Array.from({ length: n }, (_, i) =>
      save(rel, `v${i}\n`, `nocoalesce-${i}`),
    );
    await Promise.all(ops);

    expect(await readFile(join(v.workdir, rel), "utf8")).toBe(`v${n - 1}\n`);
    // No coalescing → one commit per content change (all 5 differ).
    expect(await countCommits(v.workdir, "nocoalesce-")).toBe(n);
  });

  it("saves to DIFFERENT notes are never coalesced — all land independently", async () => {
    useVaultCoalesce(v.workdir, v.remote, true);
    const n = 6;

    const ops = Array.from({ length: n }, (_, i) =>
      save(`20_notes/d${i}.md`, `distinct ${i}\n`, `distinct-${i}`),
    );
    await Promise.all(ops);

    for (let i = 0; i < n; i++) {
      expect(
        await readFile(join(v.workdir, `20_notes/d${i}.md`), "utf8"),
      ).toBe(`distinct ${i}\n`);
    }
    expect(await countCommits(v.workdir, "distinct-")).toBe(n);
  });

  it("does not coalesce a save that arrives AFTER the in-flight op started", async () => {
    // First save starts executing (its registry entry is cleared on start). A
    // save issued strictly after that must open a fresh window and persist its
    // own content — proving in-flight bytes are never swapped out (AC#3).
    useVaultCoalesce(v.workdir, v.remote, true);
    const rel = "20_notes/sequenced.md";

    const first = await save(rel, "first\n", "seq-first"); // fully awaited
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(v.workdir, rel), "utf8")).toBe("first\n");

    const second = await save(rel, "second\n", "seq-second");
    expect(second).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(v.workdir, rel), "utf8")).toBe("second\n");

    // Two separate windows → two commits.
    expect(await countCommits(v.workdir, "seq-")).toBe(2);
  });
});

// ─── Story 10.17: READ-ONLY history / diff helpers ─────────────────────────

describe("gitService — read-only history/diff (Story 10.17)", () => {
  let v: Awaited<ReturnType<typeof setupVaultWithRemote>>;

  beforeEach(async () => {
    v = await setupVaultWithRemote();
    useVault(v.workdir, v.remote);
  });
  afterEach(async () => {
    if (v) await v.cleanup();
  });

  it("noteHistory returns the commits that touched a file, newest first", async () => {
    const rel = "20_notes/hist.md";
    await save(rel, "v1\n", "hist: v1");
    await save(rel, "v2\n", "hist: v2");
    await save(rel, "v3\n", "hist: v3");

    const history = await noteHistory(rel);

    // One entry per content-changing commit, newest first.
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.message)).toEqual([
      "hist: v3",
      "hist: v2",
      "hist: v1",
    ]);
    for (const entry of history) {
      expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
      // ISO-8601 committer date.
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("noteHistory honors the limit and clamps a bogus limit to the default", async () => {
    const rel = "20_notes/limited.md";
    for (let i = 0; i < 5; i++) await save(rel, `body ${i}\n`, `lim-${i}`);

    expect(await noteHistory(rel, 2)).toHaveLength(2);
    // Non-positive / non-finite limits fall back to the default (>= our 5).
    expect((await noteHistory(rel, 0)).length).toBe(5);
    expect((await noteHistory(rel, -3)).length).toBe(5);
    expect((await noteHistory(rel, Number.NaN)).length).toBe(5);
  });

  it("noteHistory returns [] for a file with no history (untracked / missing)", async () => {
    expect(await noteHistory("20_notes/never-existed.md")).toEqual([]);
  });

  it("noteDiff(sha) shows the change a commit introduced for the file", async () => {
    const rel = "20_notes/diffme.md";
    await save(rel, "original line\n", "diff: original");
    await save(rel, "changed line\n", "diff: changed");

    const [latest] = await noteHistory(rel);
    const result = await noteDiff(rel, latest.sha);

    expect(result.sha).toBe(latest.sha);
    expect(result.diff).toContain("-original line");
    expect(result.diff).toContain("+changed line");
  });

  it("noteDiff() without a sha returns the uncommitted working-tree diff (sha: null)", async () => {
    const rel = "20_notes/wt.md";
    await save(rel, "committed\n", "wt: committed");

    // Mutate the working tree WITHOUT committing — pure read of the dirty state.
    await writeFile(join(v.workdir, rel), "edited in place\n", "utf8");

    const result = await noteDiff(rel);
    expect(result.sha).toBeNull();
    expect(result.diff).toContain("-committed");
    expect(result.diff).toContain("+edited in place");
  });

  it("noteDiff() returns an empty diff for an unchanged / missing file (graceful)", async () => {
    const result = await noteDiff("20_notes/never-existed.md");
    expect(result.sha).toBeNull();
    expect(result.diff).toBe("");
  });

  it("noteDiff(badSha) surfaces a typed git error, never mutating the tree", async () => {
    const rel = "20_notes/diffme.md";
    await save(rel, "x\n", "diff: seed");

    await expect(noteDiff(rel, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).rejects.toBeInstanceOf(
      GitBackendError,
    );
  });
});
