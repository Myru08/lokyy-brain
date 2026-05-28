import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSkill,
  renderPrompt,
  listSkillNotes,
  validateSkillInput,
} from "./index.js";
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
});
