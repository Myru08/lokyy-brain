import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initCore } from "../util/coreConfig.js";
import { ensureRepo } from "../git/gitService.js";
import { createNote, saveNote } from "./notesService.js";
import { parseFrontmatter, validateFrontmatter } from "../frontmatter/index.js";
import { FrontmatterValidationError } from "../errors/FrontmatterValidationError.js";

const exec = promisify(execFile);

/**
 * Sets up an isolated bare-remote + working-copy pair for vault tests.
 * Returns the abs path to the working copy (which is registered as
 * VAULT_DIR via initCore).
 */
async function setupTestVault(): Promise<{
  workdir: string;
  remote: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-test-"));
  const remote = join(base, "remote");
  const workdir = join(base, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);

  // Seed remote with an initial commit so `clone --branch main` works.
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

let vault: Awaited<ReturnType<typeof setupTestVault>>;

beforeAll(async () => {
  vault = await setupTestVault();
});

afterAll(async () => {
  await vault.cleanup();
});

describe("notesService.createNote — SPEC-valid frontmatter (Story 1.6)", () => {
  it("emits all 5 base frontmatter fields with valid shapes", async () => {
    const note = await createNote("test-1");
    expect(note.id).toBe("test-1");

    const raw = await readFile(join(vault.workdir, "test-1.md"), "utf8");
    const { data, body } = parseFrontmatter(raw);

    expect(data.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(data.type).toBe("note");
    expect(data.title).toBe("test-1");
    expect(typeof data.created).toBe("string");
    expect(typeof data.updated).toBe("string");
    expect(data.created).toBe(data.updated);

    expect(validateFrontmatter(data, "note").valid).toBe(true);
    expect(body).toContain("# test-1");
  });

  it("preserves a caller-supplied ULID and title", async () => {
    const fixedUlid = "01JXYZABCDEFGHJKMNPQRSTVWX";
    const note = await createNote("test-2", "## Custom body\n", {
      id: fixedUlid,
      title: "My Custom Title",
    });

    const raw = await readFile(join(vault.workdir, "test-2.md"), "utf8");
    const { data, body } = parseFrontmatter(raw);

    expect(data.id).toBe(fixedUlid);
    expect(data.title).toBe("My Custom Title");
    expect(body).toContain("## Custom body");
  });

  it("supports doc types beyond the default 'note'", async () => {
    const note = await createNote("captures/y1", "transcript body", {
      type: "capture",
      title: "Imported Video",
      extra: { source: "youtube", url: "https://youtu.be/x" },
    });

    const raw = await readFile(join(vault.workdir, "captures/y1.md"), "utf8");
    const { data } = parseFrontmatter(raw);

    expect(data.type).toBe("capture");
    expect(data.source).toBe("youtube");
    expect(validateFrontmatter(data, "capture").valid).toBe(true);
  });

  it("throws FrontmatterValidationError if an explicit id is malformed", async () => {
    await expect(
      createNote("test-bad", undefined, { id: "NOT-A-ULID" }),
    ).rejects.toBeInstanceOf(FrontmatterValidationError);
  });

  it("throws if the note already exists (legacy behavior preserved)", async () => {
    await expect(createNote("test-1")).rejects.toThrow(/existiert bereits/);
  });
});

describe("notesService.saveNote — preserves id/created, bumps updated (Story 1.7)", () => {
  it("round-trip preserves id/created and bumps updated", async () => {
    await createNote("rt-1");
    const initialRaw = await readFile(join(vault.workdir, "rt-1.md"), "utf8");
    const initial = parseFrontmatter(initialRaw).data;

    // Wait so updated timestamp clearly differs.
    await new Promise((r) => setTimeout(r, 10));
    await saveNote("rt-1", "new body\n");

    const afterRaw = await readFile(join(vault.workdir, "rt-1.md"), "utf8");
    const after = parseFrontmatter(afterRaw).data;

    expect(after.id).toBe(initial.id);
    expect(after.created).toBe(initial.created);
    expect(after.updated).not.toBe(initial.updated);
    expect(typeof after.updated).toBe("string");
  });

  it("body without frontmatter reuses all on-disk frontmatter", async () => {
    await createNote("rt-2", undefined, { title: "Original" });
    const before = parseFrontmatter(
      await readFile(join(vault.workdir, "rt-2.md"), "utf8"),
    ).data;

    await new Promise((r) => setTimeout(r, 10));
    await saveNote(
      "rt-2",
      "## just markdown body, no frontmatter\n",
    );

    const afterRaw = await readFile(join(vault.workdir, "rt-2.md"), "utf8");
    const { data: after, body } = parseFrontmatter(afterRaw);

    expect(after.title).toBe("Original");
    expect(after.id).toBe(before.id);
    expect(after.type).toBe(before.type);
    expect(body).toContain("## just markdown body");
  });

  it("body with new title in frontmatter updates title but keeps id/created", async () => {
    await createNote("rt-3", undefined, { title: "First Title" });
    const before = parseFrontmatter(
      await readFile(join(vault.workdir, "rt-3.md"), "utf8"),
    ).data;

    const newBody = `---
id: 01JXYZABCDEFGHJKMNPQRSTVWX
type: note
title: New Title
created: 2020-01-01T00:00:00.000Z
updated: 2020-01-01T00:00:00.000Z
---
body
`;
    await saveNote("rt-3", newBody);

    const after = parseFrontmatter(
      await readFile(join(vault.workdir, "rt-3.md"), "utf8"),
    ).data;

    expect(after.title).toBe("New Title");
    expect(after.id).toBe(before.id); // on-disk id wins
    expect(after.created).toBe(before.created); // on-disk created wins
    expect(after.updated).not.toBe("2020-01-01T00:00:00.000Z"); // updated overridden to now
  });

  it("rejects malformed body frontmatter with FrontmatterValidationError", async () => {
    const badBody = `---
id: NOT-A-ULID
type: note
title: Bad
created: 2025-05-24T10:00:00.000Z
updated: 2025-05-24T10:00:00.000Z
---
body
`;
    // Existing note rt-1 has a valid on-disk id, which will win over NOT-A-ULID.
    // So this test creates a fresh note path where no on-disk id exists.
    await expect(saveNote("rt-bad", badBody)).rejects.toBeInstanceOf(
      FrontmatterValidationError,
    );
  });
});
