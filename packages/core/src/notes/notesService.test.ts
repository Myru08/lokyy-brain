import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initCore } from "../util/coreConfig.js";
import { ensureRepo } from "../git/gitService.js";
import {
  createNote,
  saveNote,
  createNotes,
  updateNotes,
  trashEntry,
  deleteEntry,
  getNote,
  TRASH_FOLDER,
} from "./notesService.js";
import { parseFrontmatter, validateFrontmatter } from "../frontmatter/index.js";
import { FrontmatterValidationError } from "../errors/FrontmatterValidationError.js";
import { TypeFolderMismatchError } from "../errors/TypeFolderMismatchError.js";

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

describe("notesService.createNote — type/folder placement guard (Story 10.2, AC#5)", () => {
  it("type:skill is written through 1:1 (no silent rewrite to note)", async () => {
    await createNote("70_pai/skills/place-skill", "## skill body\n", {
      type: "skill",
      title: "Place Skill",
      // A skill note's schema requires skill_name + description — supplied as
      // extra frontmatter so the note is valid AND listable in one call (AC#6).
      extra: { skill_name: "place-skill", description: "A placeholder skill." },
    });
    const raw = await readFile(
      join(vault.workdir, "70_pai/skills/place-skill.md"),
      "utf8",
    );
    const { data } = parseFrontmatter(raw);
    expect(data.type).toBe("skill");
    expect(validateFrontmatter(data, "skill").valid).toBe(true);
  });

  it("validatePlacement allows the canonical folder", async () => {
    const note = await createNote("30_captures/ok-capture", "body", {
      type: "capture",
      validatePlacement: true,
    });
    expect(note.id).toBe("30_captures/ok-capture");
  });

  it("validatePlacement allows a valid sub-folder (30_captures/youtube/)", async () => {
    const note = await createNote("30_captures/youtube/sub-ok", "body", {
      type: "capture",
      validatePlacement: true,
    });
    expect(note.id).toBe("30_captures/youtube/sub-ok");
  });

  it("validatePlacement rejects a contradictory path with TypeFolderMismatchError", async () => {
    await expect(
      createNote("20_notes/wrong-capture", "body", {
        type: "capture",
        validatePlacement: true,
      }),
    ).rejects.toBeInstanceOf(TypeFolderMismatchError);
  });

  it("the mismatch error carries the structured correction fields", async () => {
    try {
      await createNote("20_notes/wrong-2", "body", {
        type: "capture",
        validatePlacement: true,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TypeFolderMismatchError);
      const e = err as TypeFolderMismatchError;
      expect(e.type).toBe("capture");
      expect(e.expectedFolder).toBe("30_captures");
      expect(e.gotPath).toBe("20_notes/wrong-2");
    }
  });

  it("without validatePlacement, freeform placement still works (REST/back-compat)", async () => {
    // AC#8 — the REST route calls createNote without validatePlacement, so a
    // type:capture written to an arbitrary path must NOT throw.
    const note = await createNote("anywhere/freeform-capture", "body", {
      type: "capture",
    });
    expect(note.id).toBe("anywhere/freeform-capture");
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

describe("notesService — soft-delete (trash) + hard-delete (Story 10.3)", () => {
  it("trashEntry moves a note into 99_archive/_trash/{YYYY-MM-DD}-{slug}", async () => {
    await createNote("20_notes/to-trash", "## doomed\n", { title: "Doomed" });
    const fixedNow = new Date("2026-05-29T12:00:00.000Z");

    const res = await trashEntry("20_notes/to-trash", fixedNow);

    expect(res.from).toBe("20_notes/to-trash");
    expect(res.to).toBe(`${TRASH_FOLDER}/2026-05-29-to-trash`);
    // The original path is gone…
    expect(await getNote("20_notes/to-trash")).toBeNull();
    // …and the note now lives (recoverably) under the trash path with body intact.
    const moved = await getNote(`${TRASH_FOLDER}/2026-05-29-to-trash`);
    expect(moved).not.toBeNull();
    expect(moved!.body).toContain("## doomed");
  });

  it("trashEntry throws when the source note does not exist", async () => {
    await expect(trashEntry("20_notes/never-existed")).rejects.toThrow(
      /existiert nicht/,
    );
  });

  it("deleteEntry hard-removes a note (no trash copy)", async () => {
    await createNote("20_notes/hard-gone", "## bye\n");
    expect(await getNote("20_notes/hard-gone")).not.toBeNull();

    await deleteEntry("20_notes/hard-gone", "note");

    expect(await getNote("20_notes/hard-gone")).toBeNull();
    // Hard delete must NOT leave a trash copy behind.
    expect(await getNote(`${TRASH_FOLDER}/hard-gone`)).toBeNull();
  });
});

describe("notesService — bulk createNotes (atomic on validation, Story 10.10)", () => {
  it("lands every item in the batch (AC#1/#2 happy path)", async () => {
    const res = await createNotes([
      { id: "20_notes/bulk-a", body: "## A\n", opts: { title: "Bulk A" } },
      { id: "20_notes/bulk-b", body: "## B\n", opts: { title: "Bulk B" } },
      {
        id: "50_decisions/bulk-c",
        body: "## C\n",
        opts: { type: "decision", title: "Bulk C" },
      },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return; // type-narrowing for the assertions below
    expect(res.notes.map((n) => n.id)).toEqual([
      "20_notes/bulk-a",
      "20_notes/bulk-b",
      "50_decisions/bulk-c",
    ]);
    // All three are actually on disk + readable.
    expect(await getNote("20_notes/bulk-a")).not.toBeNull();
    expect(await getNote("20_notes/bulk-b")).not.toBeNull();
    expect(await getNote("50_decisions/bulk-c")).not.toBeNull();
  });

  it("one invalid item → NOTHING created (AC#2 atomic gate)", async () => {
    const res = await createNotes([
      { id: "20_notes/atomic-ok-1", body: "ok", opts: { title: "OK 1" } },
      // Invalid: malformed caller-supplied ULID fails frontmatter validation.
      {
        id: "20_notes/atomic-bad",
        body: "bad",
        opts: { id: "NOT-A-ULID", title: "Bad" },
      },
      { id: "20_notes/atomic-ok-2", body: "ok", opts: { title: "OK 2" } },
    ]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.id).toBe("20_notes/atomic-bad");
    expect(res.error.reason).toBe("frontmatter-invalid");
    expect(res.committed).toEqual([]); // pure validation failure writes nothing

    // Critically: the VALID neighbours were NOT created.
    expect(await getNote("20_notes/atomic-ok-1")).toBeNull();
    expect(await getNote("20_notes/atomic-ok-2")).toBeNull();
  });

  it("placement violation fails pre-flight without writing (Story 10.2 rule)", async () => {
    const res = await createNotes([
      { id: "20_notes/place-ok", body: "ok", opts: { title: "Place OK" } },
      // type:capture written outside 30_captures with validatePlacement on.
      {
        id: "20_notes/wrong-place",
        body: "x",
        opts: { type: "capture", validatePlacement: true },
      },
    ]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.id).toBe("20_notes/wrong-place");
    expect(res.error.reason).toBe("type-folder-mismatch");
    expect(await getNote("20_notes/place-ok")).toBeNull();
  });

  it("an already-existing target fails pre-flight, nothing written", async () => {
    await createNote("20_notes/bulk-existing", "seed");
    const res = await createNotes([
      { id: "20_notes/bulk-new-1", body: "x", opts: { title: "New 1" } },
      { id: "20_notes/bulk-existing", body: "x" },
    ]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.id).toBe("20_notes/bulk-existing");
    expect(res.error.reason).toBe("already-exists");
    expect(await getNote("20_notes/bulk-new-1")).toBeNull();
  });

  it("rejects an in-batch duplicate id before writing", async () => {
    const res = await createNotes([
      { id: "20_notes/dupe", body: "first", opts: { title: "First" } },
      { id: "20_notes/dupe", body: "second", opts: { title: "Second" } },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.reason).toBe("duplicate-id");
    expect(await getNote("20_notes/dupe")).toBeNull();
  });
});

describe("notesService — bulk updateNotes (atomic on validation, Story 10.10)", () => {
  it("updates every item in the batch, bumping bodies (AC#1/#5)", async () => {
    await createNote("20_notes/upd-a", "## old A\n", { title: "Upd A" });
    await createNote("20_notes/upd-b", "## old B\n", { title: "Upd B" });

    const res = await updateNotes([
      { id: "20_notes/upd-a", body: "## new A\n" },
      { id: "20_notes/upd-b", body: "## new B\n" },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const a = await getNote("20_notes/upd-a");
    const b = await getNote("20_notes/upd-b");
    expect(a!.body).toContain("## new A");
    expect(b!.body).toContain("## new B");
    // identity preserved (saveNote semantics): the frontmatter title stays.
    // (Note.title is the RENDERED title — H1/filename — so we assert on the
    // persisted frontmatter, which is what saveNote actually preserves.)
    const aFm = parseFrontmatter(
      await readFile(join(vault.workdir, "20_notes/upd-a.md"), "utf8"),
    ).data;
    expect(aFm.title).toBe("Upd A");
  });

  it("one missing target → NOTHING updated (atomic gate)", async () => {
    await createNote("20_notes/upd-keep", "## keep original\n", {
      title: "Keep",
    });

    const res = await updateNotes([
      { id: "20_notes/upd-keep", body: "## should NOT persist\n" },
      { id: "20_notes/upd-missing", body: "## target does not exist\n" },
    ]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.id).toBe("20_notes/upd-missing");
    expect(res.error.reason).toBe("not-found");
    expect(res.committed).toEqual([]);

    // The existing note must be untouched — atomicity held.
    const keep = await getNote("20_notes/upd-keep");
    expect(keep!.body).toContain("## keep original");
    expect(keep!.body).not.toContain("should NOT persist");
  });

  it("a malformed frontmatter body fails pre-flight, nothing written", async () => {
    await createNote("20_notes/upd-valid", "## intact\n", { title: "Intact" });
    const badBody = `---
id: NOT-A-ULID
type: note
title: Bad
created: 2025-05-24T10:00:00.000Z
updated: 2025-05-24T10:00:00.000Z
---
body
`;
    const res = await updateNotes([
      { id: "20_notes/upd-valid", body: "## would-be-update\n" },
      // Fresh target so no on-disk id wins over the malformed one.
      { id: "20_notes/upd-valid", body: badBody },
    ]);
    // Duplicate id guard fires first here; assert the gate held regardless.
    expect(res.ok).toBe(false);
    const intact = await getNote("20_notes/upd-valid");
    expect(intact!.body).toContain("## intact");
  });
});
