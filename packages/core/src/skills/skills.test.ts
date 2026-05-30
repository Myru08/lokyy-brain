import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSkill,
  renderPrompt,
  listSkillNotes,
  validateSkillInput,
  getSkillSchema,
} from "./index.js";
import { validateFrontmatter, parseFrontmatter } from "../frontmatter/index.js";
import { FrontmatterValidationError } from "../errors/FrontmatterValidationError.js";

/**
 * A schema-valid skill note with an `input_schema` carrying a `days` param
 * (default 7) plus a free-form `topic` param, and a prompt that references
 * built-ins + params + an intentionally unknown token.
 */
const VALID_SKILL = `---
id: 01JXYZABCDEFGHJKMNPQRSTVWX
type: skill
title: Weekly Review
skill_name: weekly-review
description: Summarize the last N days of notes.
execution: client
allowed_tools:
  - search_vault
  - read_note
input_schema:
  properties:
    days:
      type: integer
      default: 7
    topic:
      type: string
output:
  folder: 70_pai/sessions
  type: note
created: "2026-05-24T10:00:00.000Z"
updated: "2026-05-24T10:00:00.000Z"
---
Hi {{user}}, today is {{today}} in {{vault_root}}.
Review the last {{days}} days about {{topic}}.
Unknown {{not_a_real_token}} stays.
Literal braces {{ }} survive too.
`;

const BROKEN_SKILL = `---
id: not-a-valid-ulid
type: skill
title: Broken
skill_name: BROKEN UPPER
description: ""
---
Body that never validates.
`;

describe("parseSkill", () => {
  it("parses a valid skill into a typed SkillDef", () => {
    const skill = parseSkill(VALID_SKILL);
    expect(skill.skill_name).toBe("weekly-review");
    expect(skill.title).toBe("Weekly Review");
    expect(skill.description).toBe("Summarize the last N days of notes.");
    expect(skill.execution).toBe("client");
    expect(skill.allowed_tools).toEqual(["search_vault", "read_note"]);
    expect(skill.input_schema).toBeDefined();
    expect(skill.output).toEqual({ folder: "70_pai/sessions", type: "note" });
    expect(skill.prompt).toContain("Review the last {{days}} days");
    // prompt is the body BELOW the frontmatter — no `---` block.
    expect(skill.prompt).not.toContain("skill_name:");
  });

  it("defaults execution to 'client' when omitted", () => {
    const raw = VALID_SKILL.replace("execution: client\n", "");
    expect(parseSkill(raw).execution).toBe("client");
  });

  it("throws a typed FrontmatterValidationError on broken frontmatter", () => {
    expect(() => parseSkill(BROKEN_SKILL)).toThrow(FrontmatterValidationError);
  });
});

describe("renderPrompt", () => {
  it("fills {{user}}, {{today}} and {{days}}", () => {
    const skill = parseSkill(VALID_SKILL);
    const out = renderPrompt(skill, {
      user: "Oliver",
      vault_root: "/vault",
      days: 30,
      topic: "AI",
    });
    expect(out).toContain("Hi Oliver");
    expect(out).toMatch(/today is \d{4}-\d{2}-\d{2} in \/vault/);
    expect(out).toContain("Review the last 30 days about AI");
  });

  it("applies the input_schema default for days when omitted", () => {
    const skill = parseSkill(VALID_SKILL);
    const out = renderPrompt(skill, { topic: "AI" });
    expect(out).toContain("Review the last 7 days about AI");
  });

  it("leaves an unknown token verbatim", () => {
    const skill = parseSkill(VALID_SKILL);
    const out = renderPrompt(skill, { topic: "AI" });
    expect(out).toContain("Unknown {{not_a_real_token}} stays.");
  });

  it("leaves literal {{ }} (no key) verbatim", () => {
    const skill = parseSkill(VALID_SKILL);
    const out = renderPrompt(skill, { topic: "AI" });
    expect(out).toContain("Literal braces {{ }} survive too.");
  });

  it("renders built-in today as YYYY-MM-DD", () => {
    const skill = parseSkill(VALID_SKILL);
    const expected = new Date().toISOString().slice(0, 10);
    expect(renderPrompt(skill, { topic: "x" })).toContain(`today is ${expected}`);
  });

  it("falls back user/vault_root to empty string when absent", () => {
    const skill = parseSkill(VALID_SKILL);
    const out = renderPrompt(skill, { topic: "x" });
    expect(out).toContain("Hi , today is");
  });
});

describe("validateSkillInput", () => {
  it("applies defaults and reports ok", () => {
    const skill = parseSkill(VALID_SKILL);
    const res = validateSkillInput(skill, { topic: "AI" });
    expect(res.ok).toBe(true);
    expect(res.value.days).toBe(7);
    expect(res.value.topic).toBe("AI");
  });

  it("flags a wrong primitive type", () => {
    const skill = parseSkill(VALID_SKILL);
    const res = validateSkillInput(skill, { days: "seven" });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]).toMatch(/days/);
  });

  it("reports a missing required field", () => {
    const raw = VALID_SKILL.replace(
      "  properties:",
      "  required:\n    - topic\n  properties:",
    );
    const skill = parseSkill(raw);
    const res = validateSkillInput(skill, {});
    expect(res.ok).toBe(false);
    expect(res.errors?.some((e) => e.includes("topic"))).toBe(true);
  });
});

describe("listSkillNotes", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lokyy-skills-"));
    const skillsDir = join(root, "70_pai", "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, "weekly-review.md"), VALID_SKILL, "utf8");
    await writeFile(join(skillsDir, "broken.md"), BROKEN_SKILL, "utf8");
    // A non-skill note must be ignored entirely.
    await writeFile(
      join(skillsDir, "plain.md"),
      `---
id: 01JXYZABCDEFGHJKMNPQRSTVWX
type: note
title: Not a skill
created: 2026-05-24T10:00:00.000Z
updated: 2026-05-24T10:00:00.000Z
---
body
`,
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns valid skills and skips broken ones without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const skills = await listSkillNotes(root);
    expect(skills.map((s) => s.skill_name)).toEqual(["weekly-review"]);
    expect(warn).toHaveBeenCalled(); // the broken skill logged a warning
    warn.mockRestore();
  });

  it("returns an empty array for a vault root with no skills", async () => {
    const empty = await mkdtemp(join(tmpdir(), "lokyy-skills-empty-"));
    try {
      expect(await listSkillNotes(empty)).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("populates basePath as the note path for a single-note skill (Epic 12)", async () => {
    const skills = await listSkillNotes(root);
    const single = skills.find((s) => s.skill_name === "weekly-review");
    expect(single?.basePath).toBe("70_pai/skills/weekly-review.md");
    // Single-note skills carry no folder companions.
    expect(single?.references ?? []).toEqual([]);
    expect(single?.templates ?? []).toEqual([]);
  });
});

/**
 * Epic 12 / Story 12.1 — folder-skills (Anthropic Agent Skills format).
 * A `<name>/SKILL.md` (type:skill) is ONE skill; its `references/*.md` and
 * `templates/*` companions are collected. Single-note skills stay valid.
 */
const FOLDER_SKILL = `---
id: 01JFABCDEFGHJKMNPQRSTVWXYZ
type: skill
title: Dashboard Builder
skill_name: dashboard-builder
description: Build a dashboard from a template.
execution: client
allowed_tools:
  - read_note
created: "2026-05-30T10:00:00.000Z"
updated: "2026-05-30T10:00:00.000Z"
---
Build the dashboard. Consult the reference docs as needed.
`;

const REFERENCE_DOC = `---
id: 01JREFAAAAAAAAAAAAAAAAAAAA
type: reference
title: Layout Guidelines
created: "2026-05-30T10:00:00.000Z"
updated: "2026-05-30T10:00:00.000Z"
---
Use a 12-column grid.
`;

const REFERENCE_DOC_NO_TITLE = `---
id: 01JREFBBBBBBBBBBBBBBBBBBBB
type: reference
title: " "
created: "2026-05-30T10:00:00.000Z"
updated: "2026-05-30T10:00:00.000Z"
---
Misc notes.
`;

describe("listSkillNotes — folder skills (Story 12.1)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lokyy-folderskills-"));
    const skillsDir = join(root, "70_pai", "skills");
    // 1) A folder-skill with references/ + templates/.
    const folderDir = join(skillsDir, "dashboard-builder");
    await mkdir(join(folderDir, "references"), { recursive: true });
    await mkdir(join(folderDir, "templates"), { recursive: true });
    await writeFile(join(folderDir, "SKILL.md"), FOLDER_SKILL, "utf8");
    await writeFile(join(folderDir, "references", "foo.md"), REFERENCE_DOC, "utf8");
    await writeFile(
      join(folderDir, "references", "bar.md"),
      REFERENCE_DOC_NO_TITLE,
      "utf8",
    );
    await writeFile(
      join(folderDir, "templates", "bar.jsx"),
      "export const Dashboard = () => null;\n",
      "utf8",
    );
    // 2) A single-note skill alongside it (regression / backward-compat).
    await writeFile(join(skillsDir, "weekly-review.md"), VALID_SKILL, "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads the folder as ONE skill with references/templates + basePath", async () => {
    const skills = await listSkillNotes(root);
    const folder = skills.find((s) => s.skill_name === "dashboard-builder");
    expect(folder).toBeDefined();
    expect(folder?.basePath).toBe("70_pai/skills/dashboard-builder");
    // references collected (title from frontmatter, else filename), sorted by
    // discovery order — assert set membership to stay order-independent.
    const refPaths = (folder?.references ?? []).map((r) => r.path).sort();
    expect(refPaths).toEqual([
      "70_pai/skills/dashboard-builder/references/bar.md",
      "70_pai/skills/dashboard-builder/references/foo.md",
    ]);
    const fooRef = folder?.references?.find((r) => r.path.endsWith("foo.md"));
    expect(fooRef?.title).toBe("Layout Guidelines"); // from frontmatter title
    const barRef = folder?.references?.find((r) => r.path.endsWith("bar.md"));
    expect(barRef?.title).toBe("bar"); // blank title → filename fallback
    // templates collected (any extension).
    expect((folder?.templates ?? []).map((t) => t.path)).toEqual([
      "70_pai/skills/dashboard-builder/templates/bar.jsx",
    ]);
  });

  it("does NOT surface SKILL.md or reference docs as extra skills", async () => {
    const skills = await listSkillNotes(root);
    // Exactly two skills: the folder-skill + the single-note skill.
    expect(skills.map((s) => s.skill_name).sort()).toEqual([
      "dashboard-builder",
      "weekly-review",
    ]);
    // No skill is named "SKILL" or accidentally carries the reference title.
    expect(skills.some((s) => s.skill_name === "SKILL")).toBe(false);
  });

  it("REGRESSION: single-note skill stays valid with empty structure (backwardCompat)", async () => {
    const skills = await listSkillNotes(root);
    const single = skills.find((s) => s.skill_name === "weekly-review");
    expect(single).toBeDefined();
    expect(single?.title).toBe("Weekly Review");
    expect(single?.basePath).toBe("70_pai/skills/weekly-review.md");
    expect(single?.references ?? []).toEqual([]);
    expect(single?.templates ?? []).toEqual([]);
  });
});

describe("getSkillSchema (Story 10.5)", () => {
  it("returns the real skill.json schema, an example, and field docs", () => {
    const info = getSkillSchema();
    // schema is the live JSON-Schema (const type:"skill", ULID pattern, etc.)
    expect((info.schema as { $id?: string }).$id).toBe("lokyy://frontmatter/skill");
    const props = (info.schema as { properties: Record<string, unknown> }).properties;
    expect(props.skill_name).toBeDefined();
    expect(props.execution).toBeDefined();
    // fieldDocs cover the required + key optional fields.
    const fields = info.fieldDocs.map((f) => f.field);
    for (const f of ["id", "type", "title", "skill_name", "description", "created", "updated"]) {
      expect(fields).toContain(f);
    }
    expect(fields).toContain("execution");
    expect(fields).toContain("input_schema");
    // The {{var}} substitution note (renderPrompt) is reflected in fieldDocs.
    const inputSchemaDoc = info.fieldDocs.find((f) => f.field === "input_schema");
    expect(inputSchemaDoc?.description).toMatch(/\{\{/);
  });

  it("the example validates against the schema and parses as a real skill (AC#3)", () => {
    const info = getSkillSchema();
    // The example body is BELOW the frontmatter — validate its frontmatter.
    const { data } = parseFrontmatter(info.example);
    expect(validateFrontmatter(data, "skill").valid).toBe(true);
    // And it round-trips through parseSkill without throwing.
    const skill = parseSkill(info.example);
    expect(skill.skill_name).toBe("weekly-review");
    expect(skill.execution).toBe("client");
  });

  it("the example actually renders {{var}} tokens via renderPrompt", () => {
    const info = getSkillSchema();
    const skill = parseSkill(info.example);
    const out = renderPrompt(skill, { topic: "AI", days: 14 });
    expect(out).toContain("Review the last 14 days of notes about AI");
    expect(out).toMatch(/today is \d{4}-\d{2}-\d{2}/);
  });
});
