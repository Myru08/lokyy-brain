import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initCore } from "../util/coreConfig.js";
import { ensureRepo, save } from "../git/gitService.js";
import { findBrokenLinks } from "./graphService.js";

const exec = promisify(execFile);

/**
 * Story 10.16 — findBrokenLinks() integration test.
 *
 * Uses the same isolated bare-remote + working-copy pattern as the
 * notesService / gitService suites (Article IX: integration-first — real git,
 * real .md files on disk, no mocks). `findBrokenLinks` calls `pull()` first,
 * so every note is written through `save()` (commit+push) to keep the working
 * copy clean for the rebase.
 */
async function setupTestVault(): Promise<{
  workdir: string;
  remote: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-graph-test-"));
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
    remote,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

/** Minimal SPEC-valid frontmatter + body. */
function note(opts: {
  id: string;
  title: string;
  body?: string;
  aliases?: string[];
  forgotten?: boolean;
}): string {
  const ulid = "01JXYZABCDEFGHJKMNPQRSTVWX";
  const lines = [
    "---",
    `id: ${ulid}`,
    "type: note",
    `title: ${opts.title}`,
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
  ];
  if (opts.aliases?.length) lines.push(`aliases: [${opts.aliases.join(", ")}]`);
  if (opts.forgotten) lines.push("forgotten: true");
  lines.push("---", "", `# ${opts.title}`, "", opts.body ?? "");
  return lines.join("\n");
}

let vault: Awaited<ReturnType<typeof setupTestVault>>;

beforeAll(async () => {
  vault = await setupTestVault();
});

afterAll(async () => {
  await vault.cleanup();
});

describe("graphService.findBrokenLinks (Story 10.16)", () => {
  it("reports a wikilink whose target resolves to no note, with its source", async () => {
    // Real note + a note that links to a non-existent target.
    await save("real-note.md", note({ id: "real-note", title: "Real Note" }), "seed real");
    await save(
      "has-dead-link.md",
      note({
        id: "has-dead-link",
        title: "Has Dead Link",
        body: "This points at [[xyz]] which does not exist.",
      }),
      "seed dead",
    );

    const broken = await findBrokenLinks();
    const xyz = broken.find((b) => b.linkText === "xyz");
    expect(xyz).toBeDefined();
    expect(xyz!.sourceId).toBe("has-dead-link");
    expect(xyz!.sourceTitle).toBe("Has Dead Link");
  });

  it("does NOT report links resolvable by title", async () => {
    await save(
      "links-by-title.md",
      note({
        id: "links-by-title",
        title: "Links By Title",
        body: "See [[Real Note]] (matches the H1 title, case-insensitive: [[real note]]).",
      }),
      "seed by-title",
    );

    const broken = await findBrokenLinks();
    expect(broken.some((b) => b.sourceId === "links-by-title")).toBe(false);
  });

  it("does NOT report links resolvable by basename or full-id", async () => {
    await save(
      "folder/nested.md",
      note({ id: "folder/nested", title: "Nested Note" }),
      "seed nested",
    );
    await save(
      "links-by-path.md",
      note({
        id: "links-by-path",
        title: "Links By Path",
        // [[nested]] resolves by basename, [[folder/nested]] resolves by full id.
        body: "Basename: [[nested]]. Full id: [[folder/nested]].",
      }),
      "seed by-path",
    );

    const broken = await findBrokenLinks();
    expect(broken.some((b) => b.sourceId === "links-by-path")).toBe(false);
  });

  it("does NOT report links resolvable by alias", async () => {
    await save(
      "aliased.md",
      note({ id: "aliased", title: "Aliased Note", aliases: ["AKA"] }),
      "seed aliased",
    );
    await save(
      "links-by-alias.md",
      note({
        id: "links-by-alias",
        title: "Links By Alias",
        body: "Alias link: [[AKA]].",
      }),
      "seed by-alias",
    );

    const broken = await findBrokenLinks();
    expect(broken.some((b) => b.sourceId === "links-by-alias")).toBe(false);
  });

  it("treats a link to a forgotten note as broken (graph parity)", async () => {
    await save(
      "ghost.md",
      note({ id: "ghost", title: "Ghost Note", forgotten: true }),
      "seed ghost",
    );
    await save(
      "links-to-ghost.md",
      note({
        id: "links-to-ghost",
        title: "Links To Ghost",
        body: "Points at a forgotten note: [[Ghost Note]].",
      }),
      "seed to-ghost",
    );

    const broken = await findBrokenLinks();
    const hit = broken.find(
      (b) => b.sourceId === "links-to-ghost" && b.linkText === "Ghost Note",
    );
    expect(hit).toBeDefined();
  });

  it("strips the alias part — [[Target|label]] reports the target, not the label", async () => {
    await save(
      "aliased-dead.md",
      note({
        id: "aliased-dead",
        title: "Aliased Dead",
        body: "Piped dead link: [[nope-target|friendly label]].",
      }),
      "seed aliased-dead",
    );

    const broken = await findBrokenLinks();
    const hit = broken.find((b) => b.sourceId === "aliased-dead");
    expect(hit).toBeDefined();
    expect(hit!.linkText).toBe("nope-target");
  });
});
