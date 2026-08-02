/**
 * Behaviour test for the ported pre-commit hook (Story 1.19 AC#4).
 *
 * Runs the REAL hook inside a real throwaway git repo scaffolded by
 * `buildVaultScaffold`, because the only thing that proves a shell hook works
 * is executing it. Uses the same `mkdtemp` throwaway-repo pattern as
 * `git/gitService.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { buildVaultScaffold, VAULT_HOOKS_DIR } from "./scaffold.js";
import { getProfileSpec } from "../frontmatter/profiles.js";
import { TYPE_FOLDER } from "../notes/folderMap.js";

const exec = promisify(execFile);

let repo: string;

async function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("git", ["-C", repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@localhost",
      LC_ALL: "C",
    },
  });
}

/** Stage `content` at `relPath` and report whether the commit survived the hook. */
async function tryCommit(relPath: string, content: string): Promise<boolean> {
  const abs = join(repo, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  await git(["add", "--", relPath]);
  try {
    await git(["commit", "-m", `test: ${relPath}`]);
    return true;
  } catch {
    await git(["reset", "--hard", "HEAD"]).catch(() => {});
    return false;
  }
}

function note(fields: Record<string, string>): string {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${fm}\n---\n\nBody.\n`;
}

const VALID = {
  id: "01HPXY9Z0000000000000000AB",
  type: "note",
  title: '"Eine Notiz"',
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-01T00:00:00.000Z",
};

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "lokyy-hook-"));
  await exec("git", ["init", "-q", repo]);

  for (const file of await buildVaultScaffold("para")) {
    const abs = join(repo, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
    if (file.executable) await chmod(abs, 0o755);
  }
  await git(["config", "core.hooksPath", VAULT_HOOKS_DIR]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "chore: scaffold"]);
}, 30_000);

afterAll(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe("scaffolded pre-commit hook", () => {
  it("lets a SPEC-valid note through", async () => {
    expect(await tryCommit("20_notes/gut.md", note(VALID))).toBe(true);
  });

  it("rejects a note with no frontmatter at all", async () => {
    expect(await tryCommit("20_notes/roh.md", "Kein Frontmatter.\n")).toBe(false);
  });

  it.each(["id", "type", "title", "created", "updated"])(
    "rejects a note missing the required field %s",
    async (field) => {
      const fields = { ...VALID } as Record<string, string>;
      delete fields[field];
      expect(await tryCommit(`20_notes/ohne-${field}.md`, note(fields))).toBe(false);
    },
  );

  it("rejects a non-ULID id", async () => {
    expect(
      await tryCommit("20_notes/keine-ulid.md", note({ ...VALID, id: "abc123" })),
    ).toBe(false);
  });

  it("rejects a type that has no schema in the vault", async () => {
    expect(
      await tryCommit("20_notes/typ.md", note({ ...VALID, type: "erfunden" })),
    ).toBe(false);
  });

  it("ignores non-markdown files and the 00_meta/ working area", async () => {
    expect(await tryCommit("20_notes/daten.csv", "a,b\n1,2\n")).toBe(true);
    expect(await tryCommit("00_meta/notiz.md", "Kein Frontmatter.\n")).toBe(true);
  });

  // The regression this story exists to prevent: the reference vault shipped 7
  // schemas, so 12 of the code's doc types would have been rejected by the very
  // hook that is supposed to protect the vault.
  it("accepts EVERY doc type the application can write", async () => {
    for (const type of getProfileSpec("para").docTypes) {
      const folder = TYPE_FOLDER[type as keyof typeof TYPE_FOLDER];
      const ok = await tryCommit(
        `${folder}/typ-${type}.md`,
        note({ ...VALID, type }),
      );
      expect(ok, `hook rejected doc type "${type}"`).toBe(true);
    }
  }, 30_000);
});
