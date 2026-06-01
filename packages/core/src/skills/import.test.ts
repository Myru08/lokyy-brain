import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initCore } from "../util/coreConfig.js";
import { ensureRepo } from "../git/gitService.js";
import { parseFrontmatter, validateFrontmatter } from "../frontmatter/index.js";
import { importSkill, slugifySkillName } from "./import.js";
import { listSkillNotes } from "./index.js";

const exec = promisify(execFile);

/**
 * Story 12.3 — `importSkill` integration test. Anthropic Agent Skills ship
 * WITHOUT vault frontmatter; the import must inject SPEC-valid frontmatter for
 * `.md` files (skill / reference) and write non-`.md` templates verbatim, all
 * through the real gitService write path against an isolated bare-remote vault.
 */

/** Isolated bare-remote + working-copy pair (mirrors notesService.test.ts). */
async function setupTestVault(): Promise<{
  workdir: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-import-test-"));
  const remote = join(base, "remote");
  const workdir = join(base, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);

  const seed = join(base, "seed");
  const seedEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "lokyy-test",
    GIT_AUTHOR_EMAIL: "test@localhost",
    GIT_COMMITTER_NAME: "lokyy-test",
    GIT_COMMITTER_EMAIL: "test@localhost",
  };
  await exec("git", ["init", "--initial-branch=main", seed]);
  await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"], {
    env: seedEnv,
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

/** An Anthropic-format skill, NO frontmatter anywhere. */
const SKILL_MD_NO_FM = `# Dashboard Builder

Build a project dashboard from the bundled template.
Consult the reference docs as needed.
`;

const REFERENCE_FOO_NO_FM = `# Layout Guidelines

Use a 12-column responsive grid.
`;

const TEMPLATE_JSX = `export const Dashboard = () => {
  return null;
};
`;

describe("slugifySkillName", () => {
  it("lowercases, kebabs and strips junk to match ^[a-z0-9-]+$", () => {
    expect(slugifySkillName("Dashboard Builder")).toBe("dashboard-builder");
    expect(slugifySkillName("  Weird__Name!! ")).toBe("weird-name");
    expect(slugifySkillName("Café Crème")).toBe("cafe-creme");
    expect(slugifySkillName("***")).toBe("skill"); // never empty
  });
});

describe("importSkill (Story 12.3)", () => {
  const files = [
    { relPath: "SKILL.md", content: SKILL_MD_NO_FM },
    { relPath: "references/foo.md", content: REFERENCE_FOO_NO_FM },
    { relPath: "templates/bar.jsx", content: TEMPLATE_JSX },
  ];

  it("writes all files with injected frontmatter where required", async () => {
    const res = await importSkill({ skillName: "Dashboard Builder", files });

    expect(res.skillName).toBe("dashboard-builder");
    expect(res.written).toEqual([
      "70_pai/skills/dashboard-builder/SKILL.md",
      "70_pai/skills/dashboard-builder/references/foo.md",
      "70_pai/skills/dashboard-builder/templates/bar.jsx",
    ]);
    expect(res.skipped).toEqual([]);

    // ── SKILL.md → valid type:skill ──────────────────────────────────────
    const skillRaw = await readFile(
      join(vault.workdir, "70_pai/skills/dashboard-builder/SKILL.md"),
      "utf8",
    );
    const skillFm = parseFrontmatter(skillRaw);
    expect(skillFm.data.type).toBe("skill");
    expect(skillFm.data.skill_name).toBe("dashboard-builder");
    expect(skillFm.data.title).toBe("Dashboard Builder"); // from H1
    expect(skillFm.data.execution).toBe("client");
    expect(typeof skillFm.data.id).toBe("string");
    expect(skillFm.data.created).toBeDefined();
    expect(skillFm.data.updated).toBeDefined();
    expect(validateFrontmatter(skillFm.data, "skill").valid).toBe(true);
    // Body preserved below the injected frontmatter.
    expect(skillFm.body).toContain("Build a project dashboard");

    // ── references/foo.md → valid type:reference ─────────────────────────
    const refRaw = await readFile(
      join(vault.workdir, "70_pai/skills/dashboard-builder/references/foo.md"),
      "utf8",
    );
    const refFm = parseFrontmatter(refRaw);
    expect(refFm.data.type).toBe("reference");
    expect(refFm.data.title).toBe("Layout Guidelines"); // from H1
    expect(validateFrontmatter(refFm.data, "reference").valid).toBe(true);
    expect(refFm.body).toContain("12-column responsive grid");

    // ── templates/bar.jsx → verbatim (no frontmatter) ────────────────────
    const jsxRaw = await readFile(
      join(vault.workdir, "70_pai/skills/dashboard-builder/templates/bar.jsx"),
      "utf8",
    );
    expect(jsxRaw).toBe(TEMPLATE_JSX); // byte-for-byte, no frontmatter added
  });

  it("surfaces the imported skill via listSkillNotes as ONE folder-skill", async () => {
    const skills = await listSkillNotes(vault.workdir);
    const folder = skills.find((s) => s.skill_name === "dashboard-builder");
    expect(folder).toBeDefined();
    expect(folder?.basePath).toBe("70_pai/skills/dashboard-builder");
    expect((folder?.references ?? []).map((r) => r.path)).toContain(
      "70_pai/skills/dashboard-builder/references/foo.md",
    );
    expect((folder?.templates ?? []).map((t) => t.path)).toContain(
      "70_pai/skills/dashboard-builder/templates/bar.jsx",
    );
    // The reference doc is NOT surfaced as its own skill (type:reference).
    expect(skills.some((s) => s.skill_name === "SKILL")).toBe(false);
  });

  it("is idempotent — a second import upserts without error", async () => {
    // Capture the id/created assigned on the first import.
    const before = parseFrontmatter(
      await readFile(
        join(vault.workdir, "70_pai/skills/dashboard-builder/SKILL.md"),
        "utf8",
      ),
    ).data;

    const res = await importSkill({ skillName: "Dashboard Builder", files });
    expect(res.written).toHaveLength(3);

    const after = parseFrontmatter(
      await readFile(
        join(vault.workdir, "70_pai/skills/dashboard-builder/SKILL.md"),
        "utf8",
      ),
    ).data;

    // Identity is stable on re-import (on-disk id/created preserved).
    expect(after.id).toBe(before.id);
    expect(after.created).toBe(before.created);
    expect(validateFrontmatter(after, "skill").valid).toBe(true);
  });

  it("preserves an existing valid type:skill block, only forcing skill_name + updated", async () => {
    const withFm = [
      {
        relPath: "SKILL.md",
        content: `---
id: 01JFABCDEFGHJKMNPQRSTVWXYZ
type: skill
title: Preset Title
skill_name: old-name
description: A preset description.
execution: client
created: "2020-01-01T00:00:00.000Z"
updated: "2020-01-01T00:00:00.000Z"
---
Preset body.
`,
      },
    ];
    const res = await importSkill({ skillName: "Preset Skill", files: withFm });
    const fm = parseFrontmatter(
      await readFile(join(vault.workdir, res.written[0]), "utf8"),
    ).data;
    expect(fm.id).toBe("01JFABCDEFGHJKMNPQRSTVWXYZ"); // preserved
    expect(fm.title).toBe("Preset Title"); // preserved
    expect(fm.description).toBe("A preset description."); // preserved
    expect(fm.created).toBe("2020-01-01T00:00:00.000Z"); // immutable
    expect(fm.skill_name).toBe("preset-skill"); // forced to import slug
    expect(fm.updated).not.toBe("2020-01-01T00:00:00.000Z"); // refreshed
    expect(validateFrontmatter(fm, "skill").valid).toBe(true);
  });

  it("throws when no SKILL.md is present", async () => {
    await expect(
      importSkill({
        skillName: "no-manifest",
        files: [{ relPath: "references/foo.md", content: "# x\nbody" }],
      }),
    ).rejects.toThrow(/SKILL\.md is required/);
  });

  // SECURITY (path traversal): a rel_path is later joined as
  // `${SKILLS_ROOT}/${slug}/${rel}` and written via save() → path.join, which
  // collapses `..`. A `../`-bearing rel must be REJECTED before any write so it
  // cannot escape the skills dir (e.g. into 50_decisions) or the vault root.
  it("throws on a `../`-bearing rel_path (path traversal rejected)", async () => {
    await expect(
      importSkill({
        skillName: "Evil Skill",
        files: [
          { relPath: "SKILL.md", content: SKILL_MD_NO_FM },
          {
            relPath: "../../../50_decisions/evil.md",
            content: "# Evil\nshould never be written",
          },
        ],
      }),
    ).rejects.toThrow(/path traversal|illegal relPath/i);

    // The traversal target must NOT have been written.
    await expect(
      readFile(join(vault.workdir, "50_decisions/evil.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("throws when the SKILL.md manifest itself carries a `..` segment", async () => {
    await expect(
      importSkill({
        skillName: "Traversal Manifest",
        files: [{ relPath: "../SKILL.md", content: SKILL_MD_NO_FM }],
      }),
    ).rejects.toThrow(/path traversal|illegal relPath|SKILL\.md is required/i);
  });
});
