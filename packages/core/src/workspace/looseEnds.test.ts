import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initCore } from "../util/coreConfig.js";
import { ensureRepo } from "../git/gitService.js";
import { looseEnds } from "./looseEnds.js";

const exec = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "lokyy-test",
  GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "lokyy-test",
  GIT_COMMITTER_EMAIL: "test@localhost",
};

/** Bare-remote + working-copy pair (same pattern as menuConfig.test.ts). */
async function setupTestVault(): Promise<{
  workdir: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-loose-ends-"));
  const remote = join(base, "remote");
  const workdir = join(base, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);

  const seed = join(base, "seed");
  await exec("git", ["init", "--initial-branch=main", seed]);
  await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"], {
    env: GIT_ENV,
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

/** Write a `.md` file at `rel` under the working copy and commit it. */
async function writeNote(workdir: string, rel: string, content: string): Promise<void> {
  const abs = join(workdir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
  await exec("git", ["-C", workdir, "add", "--", rel], { env: GIT_ENV });
  await exec("git", ["-C", workdir, "commit", "-m", `add ${rel}`], { env: GIT_ENV });
}

describe("looseEnds (Story 11.11 / O-4)", () => {
  let v: Awaited<ReturnType<typeof setupTestVault>>;

  beforeEach(async () => {
    v = await setupTestVault();
  });
  afterEach(async () => {
    if (v) await v.cleanup();
  });

  it("finds open checkboxes AND #todo tags, ignoring checked boxes", async () => {
    await writeNote(
      v.workdir,
      "20_notes/work.md",
      [
        "---",
        "id: 01J0000000000000000000000A",
        "type: note",
        "title: Work",
        "created: 2026-01-01T00:00:00Z",
        "updated: 2026-01-01T00:00:00Z",
        "---",
        "- [ ] open task one",
        "- [x] done task (ignored)",
        "* [ ] open task two",
        "Some line with #todo inline.",
        "Plain line, nothing here.",
      ].join("\n"),
    );

    const result = await looseEnds(50);

    // 2 open checkboxes + 1 #todo line = 3 (checked box ignored).
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
    const texts = result.items.map((i) => i.text);
    expect(texts).toContain("- [ ] open task one");
    expect(texts).toContain("* [ ] open task two");
    expect(texts.some((t) => t.includes("#todo"))).toBe(true);
    for (const item of result.items) {
      expect(item.noteId).toBe("20_notes/work");
      expect(item.title).toBe("Work");
      expect(item.line).toBeGreaterThan(0);
    }
  });

  it("does NOT match #todone / #todos (word boundary)", async () => {
    await writeNote(
      v.workdir,
      "20_notes/fp.md",
      [
        "---",
        "id: 01J0000000000000000000000B",
        "type: note",
        "title: FP",
        "created: 2026-01-01T00:00:00Z",
        "updated: 2026-01-01T00:00:00Z",
        "---",
        "I am #todone with this and have #todos elsewhere.",
      ].join("\n"),
    );

    const result = await looseEnds(50);
    expect(result.total).toBe(0);
  });

  it("excludes 30_captures from the scan", async () => {
    await writeNote(
      v.workdir,
      "30_captures/urls/cap.md",
      [
        "---",
        "id: 01J0000000000000000000000C",
        "type: capture",
        "title: Cap",
        "created: 2026-01-01T00:00:00Z",
        "updated: 2026-01-01T00:00:00Z",
        "---",
        "- [ ] stray todo in a capture (ignored)",
      ].join("\n"),
    );

    const result = await looseEnds(50);
    expect(result.total).toBe(0);
  });

  it("honors the limit while reporting the true total", async () => {
    const lines = ["---", "id: 01J0000000000000000000000D", "type: note", "title: Many", "created: 2026-01-01T00:00:00Z", "updated: 2026-01-01T00:00:00Z", "---"];
    for (let i = 0; i < 10; i++) lines.push(`- [ ] task ${i}`);
    await writeNote(v.workdir, "20_notes/many.md", lines.join("\n"));

    const result = await looseEnds(3);
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(10);
  });
});
