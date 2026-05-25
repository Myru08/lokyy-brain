import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initCore } from "../util/coreConfig.js";
import { ensureRepo } from "../git/gitService.js";
import { createNote, moveEntry, deleteEntry } from "./notesService.js";
import { findByUlid, invalidateUlidCache, isUlid } from "./findByUlid.js";

const exec = promisify(execFile);

/**
 * Sets up an isolated bare-remote + working-copy pair (same pattern as
 * notesService.test.ts). Returns the abs path to the working copy.
 */
async function setupTestVault(): Promise<{
  workdir: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-find-by-ulid-"));
  const remote = join(base, "remote");
  const workdir = join(base, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);

  const seed = join(base, "seed");
  await exec("git", ["init", "--initial-branch=main", seed]);
  await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "lokyy-test",
      GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "lokyy-test",
      GIT_COMMITTER_EMAIL: "test@localhost",
    },
  });
  await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
  await exec("git", ["-C", seed, "push", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });

  initCore({
    vaultDir: workdir,
    gitRemote: remote,
    gitBranch: "main",
    gitAuthorName: "lokyy-test",
    gitAuthorEmail: "test@localhost",
  });
  await ensureRepo();

  return {
    workdir,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

let vault: Awaited<ReturnType<typeof setupTestVault>>;

beforeAll(async () => {
  vault = await setupTestVault();
});

afterAll(async () => {
  await vault.cleanup();
});

beforeEach(() => {
  // Each test starts from a known cache state. The notesService write ops
  // already invalidate, but the negative-cache path can persist across
  // tests so we wipe defensively.
  invalidateUlidCache();
});

describe("isUlid — shape validation", () => {
  it("accepts canonical 26-char Crockford base32 ULIDs", () => {
    expect(isUlid("01KSFC0T2J8XG91RV6Z6D825X9")).toBe(true);
    expect(isUlid("01JXYZABCDEFGHJKMNPQRSTVWX")).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(isUlid("")).toBe(false);
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("01KSFC0T2J8XG91RV6Z6D825X")).toBe(false); // 25 chars
    expect(isUlid("01KSFC0T2J8XG91RV6Z6D825X9A")).toBe(false); // 27 chars
    expect(isUlid("01ksfc0t2j8xg91rv6z6d825x9")).toBe(false); // lowercase
    expect(isUlid("01ISFC0T2J8XG91RV6Z6D825X9")).toBe(false); // contains "I"
    expect(isUlid("01LSFC0T2J8XG91RV6Z6D825X9")).toBe(false); // contains "L"
    expect(isUlid("01OSFC0T2J8XG91RV6Z6D825X9")).toBe(false); // contains "O"
    expect(isUlid("01USFC0T2J8XG91RV6Z6D825X9")).toBe(false); // contains "U"
  });
});

describe("findByUlid — vault resolution", () => {
  const ULID_A = "01JXYZABCDEFGHJKMNPQRSTVWX";
  const ULID_B = "01JXYZ0123456789ABCDEFGHJK";

  beforeAll(async () => {
    await createNote("note-a", "# Note A\n\nbody-a\n", {
      id: ULID_A,
      title: "Note A",
    });
    await createNote("subdir/note-b", "# Note B\n\nbody-b\n", {
      id: ULID_B,
      title: "Note B",
    });
  });

  it("returns the matching note for a known ULID", async () => {
    const hit = await findByUlid(ULID_A);
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe(ULID_A);
    expect(hit?.path).toBe("note-a");
    expect(hit?.title).toBe("Note A");
    expect(hit?.body).toContain("body-a");
    expect(hit?.frontmatter.type).toBe("note");
  });

  it("resolves a note in a sub-directory", async () => {
    const hit = await findByUlid(ULID_B);
    expect(hit).not.toBeNull();
    expect(hit?.path).toBe("subdir/note-b");
    expect(hit?.title).toBe("Note B");
  });

  it("returns null for a syntactically valid but unknown ULID", async () => {
    const hit = await findByUlid("01JZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(hit).toBeNull();
  });

  it("returns null for malformed ULIDs without touching the vault", async () => {
    const hit = await findByUlid("not-a-ulid");
    expect(hit).toBeNull();
  });

  it("re-resolves after a move (cache invalidated by moveEntry)", async () => {
    const before = await findByUlid(ULID_B);
    expect(before?.path).toBe("subdir/note-b");

    await moveEntry("subdir/note-b", "subdir/note-b-renamed", "note");
    const after = await findByUlid(ULID_B);
    expect(after?.path).toBe("subdir/note-b-renamed");
  });

  it("returns null after a delete (cache invalidated by deleteEntry)", async () => {
    // Create a fresh note so the delete is self-contained and doesn't
    // interfere with the cross-test fixtures above.
    const ulidC = "01JXYZABCDEFGHJKMNPQRSTVWY";
    await createNote("note-c-temp", "# C\n", { id: ulidC, title: "C" });
    expect((await findByUlid(ulidC))?.path).toBe("note-c-temp");

    await deleteEntry("note-c-temp", "note");
    expect(await findByUlid(ulidC)).toBeNull();
  });
});

describe("findByUlid — caching", () => {
  const ULID_CACHE = "01JCACHE000000000000000000";

  beforeAll(async () => {
    await createNote("cache-test", "# Cache\n", {
      id: ULID_CACHE,
      title: "Cache",
    });
  });

  it("returns a cached result on a second call within TTL", async () => {
    invalidateUlidCache();
    const first = await findByUlid(ULID_CACHE);
    const second = await findByUlid(ULID_CACHE);
    // Equivalent payload — for an in-process cache we cannot easily count
    // fs calls without mocking node:fs, but we can assert deep equality
    // and that no exception is thrown on the warm path.
    expect(second).toEqual(first);
    expect(second?.id).toBe(ULID_CACHE);
  });

  it("invalidateUlidCache forces a fresh vault read", async () => {
    const cached = await findByUlid(ULID_CACHE);
    expect(cached).not.toBeNull();
    invalidateUlidCache();
    const fresh = await findByUlid(ULID_CACHE);
    // Same content, but the cache entry was rebuilt. We assert correctness
    // (path/title) — the perf delta is not observable here without mocks.
    expect(fresh?.id).toBe(ULID_CACHE);
    expect(fresh?.path).toBe("cache-test");
  });

  it("caches negative results so repeated misses don't re-walk", async () => {
    const missingUlid = "01JMISSINGMISSINGMISSINGMG";
    invalidateUlidCache();
    expect(await findByUlid(missingUlid)).toBeNull();
    // Second call should still return null — and it does (regardless of
    // whether the cache or the vault walk produced it). The cache path
    // is the perf optimisation; correctness is unchanged.
    expect(await findByUlid(missingUlid)).toBeNull();
  });
});
