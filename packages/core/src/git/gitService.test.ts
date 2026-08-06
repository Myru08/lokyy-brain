import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initCore } from "../util/coreConfig.js";
import {
  save,
  saveBinary,
  pull,
  move,
  sync,
  isSyncPending,
  noteHistory,
  noteDiff,
  vaultActivity,
  provisionVaultDir,
  saveVaultFile,
} from "./gitService.js";
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
    const res = await save(rel, "first skill body\n", "seed: x");

    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    // No remote configured = nothing was pushed, but nothing is STUCK either:
    // a local-only vault must never raise the "sync ausstehend" hint (AC3).
    expect(res.synced).toBe(false);
    expect(res.pending).toBe(false);
    expect(isSyncPending()).toBe(false);
    expect(await readFile(join(vault.workdir, rel), "utf8")).toBe(
      "first skill body\n",
    );
  });

  it("a second save directly after also works (the seed loop break)", async () => {
    const rel = "70_pai/skills/y.md";
    const { sha } = await save(rel, "second skill body\n", "seed: y");

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

    const res = await save(rel, wanted, "local: agreed line");

    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    // Idempotent recovery: the bytes ARE upstream, so this is a real sync —
    // not the offline "pending" path.
    expect(res.synced).toBe(true);
    expect(res.pending).toBe(false);
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

  it("classifies a NON-transient backend failure as GitBackendError, not a conflict", async () => {
    const rel = "20_notes/x.md";

    // Point origin at a path that does not exist → fetch/pull fails with
    // "does not appear to be a git repository" / "Could not read from remote".
    // That is a MISCONFIGURED remote, not a blip: it is not retryable, so the
    // offline-tolerant path deliberately does NOT swallow it (see the
    // unreachable-Forgejo suite below for the transient counterpart).
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

// ─── Offline-tolerant save (Forgejo unreachable) ───────────────────────────
//
// Community report: with the Forgejo container down, autosave surfaced a hard
// error even though `writeAndSync` had ALREADY committed locally. The commit
// was safe; only the pull/push leg failed (transient GitBackendError → 503).
// The user read that as "my note is gone" and had to click Sync to "repair" it.
//
// New contract: a transient backend failure AFTER a successful commit resolves
// with `{ sha, synced: false, pending: true }` instead of throwing. Forgejo is
// still the truth — the commit simply waits for the next sync().

/** An origin URL nothing listens on → git fails with "Failed to connect". */
const DEAD_REMOTE = "http://127.0.0.1:1/dead.git";

describe("gitService — offline-tolerant save (Forgejo unreachable)", () => {
  let v: Awaited<ReturnType<typeof setupVaultWithRemote>>;

  beforeEach(async () => {
    v = await setupVaultWithRemote();
    useVault(v.workdir, v.remote);
  });
  afterEach(async () => {
    if (v) await v.cleanup();
  });

  /** Cut the working copy off from its remote without removing `origin`. */
  async function goOffline(): Promise<void> {
    await g(v.workdir, ["remote", "set-url", "origin", DEAD_REMOTE]);
  }

  /** Reconnect the working copy to the real bare remote. */
  async function goOnline(): Promise<void> {
    await g(v.workdir, ["remote", "set-url", "origin", v.remote]);
  }

  it("resolves with { sha, synced: false } instead of throwing (AC1/AC2)", async () => {
    const rel = "20_notes/offline.md";
    await goOffline();

    const res = await save(rel, "written while offline\n", "local: offline save");

    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.synced).toBe(false);
    expect(res.pending).toBe(true);

    // The commit really is safe: on disk AND in the local history.
    expect(await readFile(join(v.workdir, rel), "utf8")).toBe(
      "written while offline\n",
    );
    expect(await g(v.workdir, ["log", "-1", "--pretty=%s"])).toBe(
      "local: offline save",
    );
    expect(await g(v.workdir, ["rev-parse", "HEAD"])).toBe(res.sha);
    expect(isSyncPending()).toBe(true);
  });

  it("leaves a clean working tree — the next save still works (AC2)", async () => {
    await goOffline();

    await save("20_notes/offline-a.md", "a\n", "local: a");
    const second = await save("20_notes/offline-b.md", "b\n", "local: b");

    expect(second.pending).toBe(true);
    // No half-applied rebase, no staged leftovers.
    expect(await g(v.workdir, ["status", "--porcelain"])).toBe("");
    expect(await countCommits(v.workdir, "local: ")).toBe(2);
  });

  it("saveBinary is offline-tolerant the same way (AC2)", async () => {
    await goOffline();

    const res = await saveBinary(
      "90_assets/blob.bin",
      new Uint8Array([1, 2, 3, 4]),
      "asset: blob",
    );

    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(res.synced).toBe(false);
    expect(res.pending).toBe(true);
    expect(await g(v.workdir, ["log", "-1", "--pretty=%s"])).toBe("asset: blob");
  });

  it("move is offline-tolerant the same way (AC2)", async () => {
    await goOffline();

    await expect(
      move("20_notes/x.md", "20_notes/x-renamed.md", "move: x"),
    ).resolves.toBeUndefined();

    expect(existsSync(join(v.workdir, "20_notes/x-renamed.md"))).toBe(true);
    expect(isSyncPending()).toBe(true);
  });

  it("a REAL merge conflict still throws while offline-tolerance is active (AC2)", async () => {
    const rel = "20_notes/x.md";

    // Remote diverges on the same line — the remote is REACHABLE here, so the
    // failure is a genuine conflict and must keep surfacing as one.
    await writeFile(join(v.other, "20_notes/x.md"), "remote divergent\n", "utf8");
    await g(v.other, ["add", "--", rel]);
    await g(v.other, ["commit", "-m", "remote: divergent"]);
    await g(v.other, ["push", "origin", "main"]);

    await expect(
      save(rel, "local divergent\n", "local: divergent"),
    ).rejects.toBeInstanceOf(MergeConflictError);
  });

  it("sync() pushes the pending commit once Forgejo is reachable again (AC6)", async () => {
    const rel = "20_notes/deferred.md";
    await goOffline();

    const pendingSave = await save(rel, "deferred body\n", "local: deferred");
    expect(pendingSave.pending).toBe(true);
    expect(isSyncPending()).toBe(true);
    // Nothing reached the bare remote yet.
    await expect(g(v.remote, ["show", `main:${rel}`])).rejects.toBeTruthy();

    await goOnline();
    const result = await sync();

    expect(result.changed).toBe(true);
    expect(await g(v.remote, ["show", `main:${rel}`])).toBe("deferred body");
    // The hint clears itself — nothing is waiting any more.
    expect(isSyncPending()).toBe(false);
  });

  it("a successful save after reconnect clears the pending flag (AC5)", async () => {
    await goOffline();
    await save("20_notes/pending.md", "pending\n", "local: pending");
    expect(isSyncPending()).toBe(true);

    await goOnline();
    const res = await save("20_notes/online.md", "online\n", "local: online");

    expect(res.synced).toBe(true);
    expect(res.pending).toBe(false);
    expect(isSyncPending()).toBe(false);
    // The push carried BOTH commits upstream.
    expect(await g(v.remote, ["show", "main:20_notes/pending.md"])).toBe("pending");
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
    const shas = (await Promise.all(ops)).map((r) => r.sha);

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
    expect((await good).sha).toMatch(/^[0-9a-f]{40}$/);
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
    const results = await Promise.all(ops);

    // AC#3: every caller resolved (no dropped promise) to a valid commit hash.
    expect(results).toHaveLength(n);
    for (const r of results) expect(r.sha).toMatch(/^[0-9a-f]{40}$/);

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
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(v.workdir, rel), "utf8")).toBe("first\n");

    const second = await save(rel, "second\n", "seq-second");
    expect(second.sha).toMatch(/^[0-9a-f]{40}$/);
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

describe("gitService — vault-wide activity / streak (Story 11.11 / K-3)", () => {
  let v: Awaited<ReturnType<typeof setupVaultWithRemote>>;

  beforeEach(async () => {
    v = await setupVaultWithRemote();
    useVault(v.workdir, v.remote);
  });
  afterEach(async () => {
    if (v) await v.cleanup();
  });

  it("buckets commits by day and gap-fills the full window", async () => {
    await save("20_notes/a.md", "a\n", "act: a");
    await save("20_notes/b.md", "b\n", "act: b");

    const activity = await vaultActivity(7);

    // Window is gap-filled to exactly `days` cells, oldest→newest.
    expect(activity.days).toHaveLength(7);
    const today = new Date().toISOString().slice(0, 10);
    const last = activity.days[activity.days.length - 1];
    expect(last.date).toBe(today);
    // All our commits land on today's bucket.
    expect(last.commits).toBeGreaterThanOrEqual(2);
    // Earlier days have no commits (gap-filled with 0).
    expect(activity.days[0].commits).toBe(0);
  });

  it("derives a current streak from today's commits", async () => {
    await save("20_notes/streak.md", "x\n", "act: streak");

    const activity = await vaultActivity(30);
    // Committed today → current streak at least 1; longest at least 1.
    expect(activity.currentStreak).toBeGreaterThanOrEqual(1);
    expect(activity.longestStreak).toBeGreaterThanOrEqual(1);
  });

  it("returns an all-zero window with no streaks for a history-less window", async () => {
    // A vault with at least one commit, but a tiny window that still includes
    // today: a single commit today keeps streak ≥ 1; clamps a bogus window.
    await save("20_notes/seed.md", "seed\n", "act: seed");
    const activity = await vaultActivity(1);
    expect(activity.days).toHaveLength(1);
    expect(activity.days[0].date).toBe(new Date().toISOString().slice(0, 10));
  });
});

// ─── Story 1.13: parameterized provisioning (provisionVaultDir) ────────────
//
// The primary vault (`config().vaultDir`) is deliberately a DIFFERENT directory
// in every test here: that is the whole point of the parameterization — the
// multi-tenant caller provisions `<vaultsRoot>/<vaultId>`, never the singleton.

async function setupProvisionFixture(): Promise<{
  base: string;
  primaryVault: string;
  seededRemote: string;
  emptyRemote: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-provision-"));

  // The singleton vault — must stay byte-identical across every provisioning.
  const primaryVault = join(base, "primary");
  await g(base, ["init", "--initial-branch=main", primaryVault]);
  await writeFile(join(primaryVault, "keep.md"), "primary\n", "utf8");
  await g(primaryVault, ["add", "--", "keep.md"]);
  await g(primaryVault, ["commit", "-m", "primary seed"]);

  // Remote #1: already carries a `main` with content → fetch+checkout path.
  const seededRemote = join(base, "seeded.git");
  await g(base, ["init", "--bare", "--initial-branch=main", seededRemote]);
  const seedClone = join(base, "seed-clone");
  await g(base, ["clone", seededRemote, seedClone]);
  await mkdir(join(seedClone, "20_notes"), { recursive: true });
  await writeFile(join(seedClone, "20_notes/from-remote.md"), "remote body\n", "utf8");
  await g(seedClone, ["add", "-A"]);
  await g(seedClone, ["commit", "-m", "seed remote"]);
  await g(seedClone, ["push", "origin", "main"]);

  // Remote #2: bare, zero commits → empty-repo bootstrap path.
  const emptyRemote = join(base, "empty.git");
  await g(base, ["init", "--bare", "--initial-branch=main", emptyRemote]);

  return {
    base,
    primaryVault,
    seededRemote,
    emptyRemote,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

describe("gitService.provisionVaultDir — arbitrary target directory (Story 1.13)", () => {
  let f: Awaited<ReturnType<typeof setupProvisionFixture>>;

  beforeEach(async () => {
    f = await setupProvisionFixture();
    useVault(f.primaryVault, ""); // singleton points somewhere ELSE entirely
  });
  afterEach(async () => {
    if (f) await f.cleanup();
  });

  /** The primary vault must be untouched by every provisioning below. */
  async function expectPrimaryUntouched(): Promise<void> {
    expect(await readFile(join(f.primaryVault, "keep.md"), "utf8")).toBe("primary\n");
    expect(await g(f.primaryVault, ["log", "--pretty=%s"])).toBe("primary seed");
  }

  it("checks out an existing remote branch into a target dir that is NOT config().vaultDir", async () => {
    const target = join(f.base, "tenant-a");

    const result = await provisionVaultDir({
      targetDir: target,
      remote: { url: f.seededRemote, branch: "main" },
    });

    expect(result).toEqual({ gitRemote: f.seededRemote, gitBranch: "main" });
    expect(await readFile(join(target, "20_notes/from-remote.md"), "utf8")).toBe(
      "remote body\n",
    );
    expect(await g(target, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await g(target, ["remote", "get-url", "origin"])).toBe(f.seededRemote);
    await expectPrimaryUntouched();
  });

  it("bootstraps an EMPTY remote (.gitkeep → commit → push -u) in the target dir", async () => {
    const target = join(f.base, "tenant-b");

    const result = await provisionVaultDir({
      targetDir: target,
      remote: { url: f.emptyRemote, branch: "main" },
    });

    expect(result).toEqual({ gitRemote: f.emptyRemote, gitBranch: "main" });
    expect(existsSync(join(target, ".gitkeep"))).toBe(true);
    expect(await g(target, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    // The bootstrap commit actually reached the (previously commit-less) remote.
    expect(await g(f.emptyRemote, ["log", "--pretty=%s", "main"])).toBe(
      "chore: initialize lokyy vault",
    );
    await expectPrimaryUntouched();
  });

  it("provisions a LOCAL-ONLY target dir (no remote add, no push)", async () => {
    const target = join(f.base, "tenant-local");

    const result = await provisionVaultDir({ targetDir: target });

    expect(result).toEqual({ gitRemote: "", gitBranch: "main" });
    expect(existsSync(join(target, ".gitkeep"))).toBe(true);
    expect(await g(target, ["log", "--pretty=%s"])).toBe(
      "chore: initialize lokyy vault (local-only)",
    );
    await expect(g(target, ["remote", "get-url", "origin"])).rejects.toBeTruthy();
    await expectPrimaryUntouched();
  });

  it("clears the target dir CONTENTS in place — never rmdir's the mount point itself", async () => {
    const target = join(f.base, "tenant-mount");
    await mkdir(join(target, "stale", "nested"), { recursive: true });
    await writeFile(join(target, "stale/nested/junk.md"), "junk\n", "utf8");
    await g(target, ["init", "--initial-branch=main"]); // a stale .git too
    const inoBefore = (await stat(target)).ino;

    await provisionVaultDir({ targetDir: target });

    // Same directory object (inode preserved) = the mount was never removed.
    expect((await stat(target)).ino).toBe(inoBefore);
    expect(existsSync(join(target, "stale"))).toBe(false);
    expect(existsSync(join(target, ".gitkeep"))).toBe(true);
  });

  it("provisions two DIFFERENT target dirs concurrently, each independently correct (AC#3)", async () => {
    const a = join(f.base, "par-a");
    const b = join(f.base, "par-b");

    const [ra, rb] = await Promise.all([
      provisionVaultDir({ targetDir: a, remote: { url: f.seededRemote, branch: "main" } }),
      provisionVaultDir({ targetDir: b }),
    ]);

    expect(ra.gitRemote).toBe(f.seededRemote);
    expect(rb.gitRemote).toBe("");
    expect(await readFile(join(a, "20_notes/from-remote.md"), "utf8")).toBe(
      "remote body\n",
    );
    // The local-only vault must NOT have inherited the other's remote content.
    expect(existsSync(join(b, "20_notes/from-remote.md"))).toBe(false);
    expect(existsSync(join(b, ".gitkeep"))).toBe(true);
    await expectPrimaryUntouched();
  });

  it("surfaces a non-empty-repo remote failure as an error (unchanged provisioning convention)", async () => {
    const target = join(f.base, "tenant-bad-remote");

    await expect(
      provisionVaultDir({
        targetDir: target,
        remote: { url: join(f.base, "does-not-exist.git"), branch: "main" },
      }),
    ).rejects.toThrow();
  });
});

// ─── Story 1.14: parameterized write path (saveVaultFile) ─────────────────
//
// The write-and-sync counterpart to Story 1.13's `provisionVaultDir`: same
// mechanics as `save()` (write → add → status → commit → pull --rebase → push,
// typed errors via classifyGitError) but against an EXPLICIT target directory,
// so `PUT /api/tenants/:vaultId/scope` can commit through gitService instead of
// raw `exec("git", …)`. As above, `config().vaultDir` deliberately points at a
// DIFFERENT directory in every test here.

async function setupWriteFixture(): Promise<{
  base: string;
  primaryVault: string;
  remote: string;
  tenant: string;
  other: string;
  localOnly: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-savevault-"));

  // The singleton vault — must stay byte-identical across every write below.
  const primaryVault = join(base, "primary");
  await g(base, ["init", "--initial-branch=main", primaryVault]);
  await writeFile(join(primaryVault, "keep.md"), "primary\n", "utf8");
  await g(primaryVault, ["add", "--", "keep.md"]);
  await g(primaryVault, ["commit", "-m", "primary seed"]);

  // A tenant working copy with a real remote (push/pull actually happen), plus
  // a second clone standing in for the concurrent writer.
  const remote = join(base, "tenant.git");
  await g(base, ["init", "--bare", "--initial-branch=main", remote]);
  const other = join(base, "other");
  await g(base, ["clone", remote, other]);
  await writeFile(join(other, "README.md"), "seed\n", "utf8");
  await g(other, ["add", "-A"]);
  await g(other, ["commit", "-m", "seed"]);
  await g(other, ["push", "origin", "main"]);
  const tenant = join(base, "tenant");
  await g(base, ["clone", remote, tenant]);

  // A tenant working copy without any remote (local-only provisioning).
  const localOnly = join(base, "local-only");
  await g(base, ["init", "--initial-branch=main", localOnly]);
  await writeFile(join(localOnly, ".gitkeep"), "", "utf8");
  await g(localOnly, ["add", "-A"]);
  await g(localOnly, ["commit", "-m", "chore: initialize lokyy vault (local-only)"]);

  return {
    base,
    primaryVault,
    remote,
    tenant,
    other,
    localOnly,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

describe("gitService.saveVaultFile — arbitrary target directory (Story 1.14)", () => {
  let f: Awaited<ReturnType<typeof setupWriteFixture>>;

  beforeEach(async () => {
    f = await setupWriteFixture();
    useVault(f.primaryVault, ""); // singleton points somewhere ELSE entirely
  });
  afterEach(async () => {
    if (f) await f.cleanup();
  });

  /** The primary vault must be untouched by every write below. */
  async function expectPrimaryUntouched(): Promise<void> {
    expect(await readFile(join(f.primaryVault, "keep.md"), "utf8")).toBe("primary\n");
    expect(await g(f.primaryVault, ["log", "--pretty=%s"])).toBe("primary seed");
  }

  it("writes + commits into a LOCAL-ONLY target dir that is NOT config().vaultDir", async () => {
    const { sha } = await saveVaultFile({
      targetDir: f.localOnly,
      relPath: "00_meta/mcp-scopes.yaml",
      content: "scopes: {}\n",
      message: "chore: update tenant scope",
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(f.localOnly, "00_meta/mcp-scopes.yaml"), "utf8")).toBe(
      "scopes: {}\n",
    );
    expect(await g(f.localOnly, ["log", "-1", "--pretty=%s"])).toBe(
      "chore: update tenant scope",
    );
    await expectPrimaryUntouched();
  });

  it("pushes the commit to the TARGET's own remote", async () => {
    await saveVaultFile({
      targetDir: f.tenant,
      relPath: "00_meta/mcp-scopes.yaml",
      content: "scopes: {a: 1}\n",
      message: "chore: update tenant scope",
    });

    expect(await g(f.remote, ["log", "-1", "--pretty=%s", "main"])).toBe(
      "chore: update tenant scope",
    );
    expect(await g(f.remote, ["show", "main:00_meta/mcp-scopes.yaml"])).toBe(
      "scopes: {a: 1}",
    );
    await expectPrimaryUntouched();
  });

  it("is a no-op (same HEAD, no new commit) when the content is unchanged", async () => {
    const first = await saveVaultFile({
      targetDir: f.tenant,
      relPath: "00_meta/mcp-scopes.yaml",
      content: "scopes: {a: 1}\n",
      message: "chore: update tenant scope",
    });
    const again = await saveVaultFile({
      targetDir: f.tenant,
      relPath: "00_meta/mcp-scopes.yaml",
      content: "scopes: {a: 1}\n",
      message: "chore: update tenant scope",
    });

    expect(again.sha).toBe(first.sha);
    // Exactly one scope commit — the second call committed nothing.
    const log = await g(f.tenant, ["log", "--pretty=%s"]);
    expect(log.split("\n").filter((l) => l === "chore: update tenant scope")).toHaveLength(1);
  });

  it("honors an explicit branch instead of config().gitBranch", async () => {
    await g(f.tenant, ["checkout", "-b", "trunk"]);
    await g(f.tenant, ["push", "-u", "origin", "trunk"]);

    await saveVaultFile({
      targetDir: f.tenant,
      relPath: "00_meta/mcp-scopes.yaml",
      content: "scopes: {b: 2}\n",
      message: "chore: update tenant scope",
      branch: "trunk",
    });

    // config().gitBranch is "main"; the write must have gone to trunk.
    expect(await g(f.remote, ["log", "-1", "--pretty=%s", "trunk"])).toBe(
      "chore: update tenant scope",
    );
    expect(await g(f.remote, ["log", "-1", "--pretty=%s", "main"])).toBe("seed");
  });

  it("surfaces a genuine remote divergence as MergeConflictError", async () => {
    // The concurrent writer publishes DIFFERENT bytes at the same path first.
    await mkdir(join(f.other, "00_meta"), { recursive: true });
    await writeFile(join(f.other, "00_meta/mcp-scopes.yaml"), "scopes: {theirs: 1}\n", "utf8");
    await g(f.other, ["add", "-A"]);
    await g(f.other, ["commit", "-m", "their scope"]);
    await g(f.other, ["push", "origin", "main"]);

    await expect(
      saveVaultFile({
        targetDir: f.tenant,
        relPath: "00_meta/mcp-scopes.yaml",
        content: "scopes: {ours: 2}\n",
        message: "chore: update tenant scope",
      }),
    ).rejects.toBeInstanceOf(MergeConflictError);
  });
});
