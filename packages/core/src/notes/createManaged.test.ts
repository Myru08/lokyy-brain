import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DOC_TYPES } from "../frontmatter/types.js";
import { initCore } from "../util/coreConfig.js";
import { ensureRepo } from "../git/gitService.js";
import { parseFrontmatter } from "../frontmatter/index.js";
import {
  createManaged,
  resolveManagedCreate,
  slugifyTitle,
} from "./createManaged.js";

const exec = promisify(execFile);

/**
 * Story 13.1 / ADR-004 — `createManaged` is THE single sanctioned write path
 * for new notes, shared by the MCP `notes.create_managed` tool and the HTTP
 * POST /api/notes/create-managed route. These tests pin the load-bearing
 * guarantees:
 *   - the path is DERIVED from `type` (never a client-supplied path);
 *   - captures land in a DATED folder;
 *   - an unknown type is REJECTED without writing;
 *   - a real createNote write produces SPEC-valid frontmatter (ULID/created/
 *     updated) in the type's canonical folder.
 */

/* ------------------------------------------------------------------ *
 *  Pure resolver — no DB/git needed.
 * ------------------------------------------------------------------ */
describe("resolveManagedCreate — type-derived path (no client path)", () => {
  const FIXED = new Date("2026-05-31T12:00:00.000Z");

  it("derives a plain canonical path from type+title", () => {
    const res = resolveManagedCreate({ title: "My Big Insight", type: "note" }, FIXED);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.type).toBe("note");
      expect(res.path).toBe("20_notes/my-big-insight");
      expect(res.title).toBe("My Big Insight");
    }
  });

  it("derives a DATED path for captures (no client path involved)", () => {
    const res = resolveManagedCreate({ title: "Cool Video", type: "capture" }, FIXED);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("30_captures/2026-05-31-cool-video");
  });

  it("accepts EVERY DOC_TYPE 1:1 (full enum is a superset of ADR-004 NoteType)", () => {
    for (const type of DOC_TYPES) {
      const res = resolveManagedCreate({ title: "T", type }, FIXED);
      expect(res.ok, `type "${type}" accepted`).toBe(true);
      if (res.ok) expect(res.type).toBe(type);
    }
  });

  it("rejects an unknown type (never coerces to note)", () => {
    const res = resolveManagedCreate({ title: "T", type: "wizard" }, FIXED);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.error).toBe("invalid-type");
  });

  it("requires a non-empty title", () => {
    const res = resolveManagedCreate({ type: "note", title: "   " }, FIXED);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.error).toBe("missing-title");
  });

  it("honors folder_hint ONLY when under the type's canonical folder", () => {
    const ok = resolveManagedCreate(
      { title: "YT Clip", type: "capture", folder_hint: "30_captures/youtube" },
      FIXED,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.path).toBe("30_captures/youtube/2026-05-31-yt-clip");
  });

  it("IGNORES a folder_hint that escapes the type's canonical folder", () => {
    const res = resolveManagedCreate(
      { title: "Sneaky", type: "note", folder_hint: "99_archive/_trash" },
      FIXED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("20_notes/sneaky");
  });

  // SECURITY (path traversal): a hint like `20_notes/../50_decisions` PASSES a
  // naive startsWith("20_notes/") check but collapses (via path.join) to a
  // folder OUTSIDE the type's home. It must NOT resolve into 50_decisions —
  // the canonical path stands instead.
  it("REJECTS a folder_hint with a `..` segment that would escape the type folder", () => {
    const res = resolveManagedCreate(
      { title: "Evil", type: "note", folder_hint: "20_notes/../50_decisions" },
      FIXED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toBe("20_notes/evil"); // canonical — NOT 50_decisions
      expect(res.path).not.toContain("50_decisions");
      expect(res.path).not.toContain("..");
    }
  });

  it("REJECTS a folder_hint with enough `..` to escape the vault root", () => {
    const res = resolveManagedCreate(
      { title: "Escape", type: "note", folder_hint: "20_notes/../../../etc" },
      FIXED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toBe("20_notes/escape"); // canonical — never escapes
      expect(res.path).not.toContain("..");
    }
  });

  it("collects string tags and drops non-string entries", () => {
    const res = resolveManagedCreate(
      { title: "Tagged", type: "note", tags: ["ai", 42, "pkm", null] },
      FIXED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tags).toEqual(["ai", "pkm"]);
  });
});

describe("slugifyTitle", () => {
  it("kebab-cases and folds diacritics", () => {
    expect(slugifyTitle("Über Café Notizen!")).toBe("uber-cafe-notizen");
  });
  it("falls back to 'note' for an all-symbol title", () => {
    expect(slugifyTitle("!!! ???")).toBe("note");
  });
});

/* ------------------------------------------------------------------ *
 *  Orchestrator — real createNote write against an isolated vault.
 * ------------------------------------------------------------------ */
async function setupTestVault(): Promise<{ workdir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-cm-test-"));
  const remote = join(base, "remote");
  const workdir = join(base, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);

  const seed = join(base, "seed");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "lokyy-test",
    GIT_AUTHOR_EMAIL: "test@localhost",
    GIT_COMMITTER_NAME: "lokyy-test",
    GIT_COMMITTER_EMAIL: "test@localhost",
  };
  await exec("git", ["init", "--initial-branch=main", seed]);
  await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"], { env: gitEnv });
  await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
  await exec("git", ["-C", seed, "push", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });

  initCore({ vaultDir: workdir, gitRemote: remote, gitBranch: "main" });
  await ensureRepo();
  return {
    workdir,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

describe("createManaged — shared write path (real git)", () => {
  let vault: { workdir: string; cleanup: () => Promise<void> };

  beforeAll(async () => {
    vault = await setupTestVault();
  }, 30_000);

  afterAll(async () => {
    await vault.cleanup();
  });

  it("writes a note to the type-derived canonical folder with SPEC frontmatter", async () => {
    const res = await createManaged({
      title: "Session Recap",
      body: "# Recap\n\nstuff",
      type: "note",
      tags: ["ai"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Path was derived from `type`, not supplied by the caller.
    expect(res.note.path).toBe("20_notes/session-recap.md");

    const abs = join(vault.workdir, "20_notes", "session-recap.md");
    await expect(stat(abs)).resolves.toBeDefined();

    const { data } = parseFrontmatter(res.note.body);
    expect(data.type).toBe("note");
    expect(data.title).toBe("Session Recap");
    expect(typeof data.id).toBe("string");
    expect((data.id as string).length).toBe(26); // ULID
    expect(data.created).toBeDefined();
    expect(data.updated).toBeDefined();
    expect(data.tags).toEqual(["ai"]);
  });

  it("derives a DATED path for captures (slug from title)", async () => {
    const res = await createManaged({ title: "YT Clip", body: "x", type: "capture" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.note.path).toMatch(/^30_captures\/\d{4}-\d{2}-\d{2}-yt-clip\.md$/);
    }
  });

  it("rejects an unknown type WITHOUT writing", async () => {
    const res = await createManaged({
      title: "Nope",
      body: "x",
      type: "wizard" as never,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.error).toBe("invalid-type");
    // No file should have been created under any folder for this title.
    const abs = join(vault.workdir, "20_notes", "nope.md");
    await expect(stat(abs)).rejects.toThrow();
  });
});
