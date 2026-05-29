import { describe, it, expect } from "vitest";
import {
  generateUlid,
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
} from "./index.js";

const VALID_NOTE = {
  id: "01JXYZABCDEFGHJKMNPQRSTVWX",
  type: "note" as const,
  title: "Test Note",
  created: "2026-05-24T10:00:00.000Z",
  updated: "2026-05-24T10:05:00.000Z",
  tags: ["alpha", "beta"],
};

describe("generateUlid", () => {
  it("returns a 26-char Crockford base32 string", () => {
    const id = generateUlid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id).toHaveLength(26);
  });

  it("produces unique values across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateUlid()));
    expect(ids.size).toBe(50);
  });
});

describe("parseFrontmatter + serializeFrontmatter", () => {
  it("round-trips a valid note without data loss", () => {
    const original = serializeFrontmatter(VALID_NOTE, "# Test Note\n\nBody.\n");
    const parsed = parseFrontmatter(original);
    expect(parsed.data).toEqual(VALID_NOTE);
    expect(parsed.body).toContain("# Test Note");
    expect(parsed.body).toContain("Body.");
  });

  it("preserves arrays and nested values", () => {
    const data = {
      ...VALID_NOTE,
      tags: ["a", "b", "c"],
      meta: { nested: { level: 2 } },
    };
    const out = serializeFrontmatter(data, "body");
    const parsed = parseFrontmatter(out);
    expect(parsed.data).toEqual(data);
  });

  it("returns empty data when no frontmatter present", () => {
    const { data, body } = parseFrontmatter("Just a body, no frontmatter.\n");
    expect(data).toEqual({});
    expect(body).toBe("Just a body, no frontmatter.\n");
  });
});

describe("validateFrontmatter — note", () => {
  it("accepts a valid note", () => {
    const result = validateFrontmatter(VALID_NOTE, "note");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects missing required id", () => {
    const { id: _id, ...without } = VALID_NOTE;
    const result = validateFrontmatter(without as never, "note");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === "required")).toBe(true);
  });

  it("rejects wrong type value", () => {
    const result = validateFrontmatter({ ...VALID_NOTE, type: "capture" }, "note");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.instancePath === "/type")).toBe(true);
  });

  it("rejects invalid ULID format (wrong length)", () => {
    const result = validateFrontmatter({ ...VALID_NOTE, id: "TOOSHORT" }, "note");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === "pattern")).toBe(true);
  });

  it("rejects invalid ULID format (forbidden chars I/L/O/U)", () => {
    const result = validateFrontmatter(
      { ...VALID_NOTE, id: "01JXYZABCDEFGHJKILUPQRSTVW" },
      "note",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === "pattern")).toBe(true);
  });

  it("rejects invalid created date-time", () => {
    const result = validateFrontmatter(
      { ...VALID_NOTE, created: "not-a-date" },
      "note",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === "format")).toBe(true);
  });

  it("rejects empty title", () => {
    const result = validateFrontmatter({ ...VALID_NOTE, title: "" }, "note");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.instancePath === "/title")).toBe(true);
  });
});

describe("validateFrontmatter — capture", () => {
  it("accepts a valid capture with source/url", () => {
    const result = validateFrontmatter(
      {
        ...VALID_NOTE,
        type: "capture",
        source: "youtube",
        url: "https://youtu.be/abc",
      },
      "capture",
    );
    expect(result.valid).toBe(true);
  });

  it("rejects invalid source enum", () => {
    const result = validateFrontmatter(
      { ...VALID_NOTE, type: "capture", source: "telegram" },
      "capture",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.instancePath === "/source")).toBe(true);
  });
});

const VALID_SKILL = {
  id: "01JXYZABCDEFGHJKMNPQRSTVWX",
  type: "skill" as const,
  title: "Summarize URL",
  skill_name: "summarize-url",
  description: "Fetch a URL and write a concise capture note.",
  execution: "client" as const,
  allowed_tools: ["read_note", "create_note"],
  created: "2026-05-24T10:00:00.000Z",
  updated: "2026-05-24T10:05:00.000Z",
};

describe("validateFrontmatter — skill", () => {
  it("accepts a valid client skill and round-trips it", () => {
    const result = validateFrontmatter(VALID_SKILL, "skill");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);

    const serialized = serializeFrontmatter(VALID_SKILL, "# Summarize URL\n");
    const reparsed = parseFrontmatter(serialized);
    expect(reparsed.data).toEqual(VALID_SKILL);
    expect(validateFrontmatter(reparsed.data, "skill").valid).toBe(true);
  });

  it("rejects skill_name with uppercase letters", () => {
    const result = validateFrontmatter(
      { ...VALID_SKILL, skill_name: "Summarize-URL" },
      "skill",
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.instancePath === "/skill_name" && e.keyword === "pattern",
      ),
    ).toBe(true);
  });

  it("rejects skill_name with spaces", () => {
    const result = validateFrontmatter(
      { ...VALID_SKILL, skill_name: "summarize url" },
      "skill",
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.instancePath === "/skill_name" && e.keyword === "pattern",
      ),
    ).toBe(true);
  });

  it("rejects missing description", () => {
    const { description: _description, ...without } = VALID_SKILL;
    const result = validateFrontmatter(without as never, "skill");
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.keyword === "required" && e.params.missingProperty === "description",
      ),
    ).toBe(true);
  });

  it("accepts execution: server at the schema layer (runtime gating is run_skill's job)", () => {
    const result = validateFrontmatter(
      { ...VALID_SKILL, execution: "server" },
      "skill",
    );
    expect(result.valid).toBe(true);
  });

  it("round-trips an output block", () => {
    const withOutput = {
      ...VALID_SKILL,
      output: {
        folder: "30_captures/urls",
        type: "capture",
        path_pattern: "{folder}/{YYYY-MM-DD}-{slug}",
      },
    };
    expect(validateFrontmatter(withOutput, "skill").valid).toBe(true);

    const serialized = serializeFrontmatter(withOutput, "# Summarize URL\n");
    const reparsed = parseFrontmatter(serialized);
    expect(reparsed.data).toEqual(withOutput);
    expect(validateFrontmatter(reparsed.data, "skill").valid).toBe(true);
  });
});

describe("validateFrontmatter — extended type enum (Story 10.15)", () => {
  // tool / resource / reference mirror note.json (plus optional `url`).
  for (const type of ["tool", "resource", "reference"] as const) {
    describe(`type: ${type}`, () => {
      const valid = {
        ...VALID_NOTE,
        type,
        title: `A ${type}`,
      };

      it("accepts a minimal valid record", () => {
        const result = validateFrontmatter(valid, type);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });

      it("accepts an optional url field and round-trips it", () => {
        const withUrl = { ...valid, url: "https://example.com/x" };
        expect(validateFrontmatter(withUrl, type).valid).toBe(true);

        const serialized = serializeFrontmatter(withUrl, `# A ${type}\n`);
        const reparsed = parseFrontmatter(serialized);
        expect(reparsed.data).toEqual(withUrl);
        expect(validateFrontmatter(reparsed.data, type).valid).toBe(true);
      });

      it("rejects a mismatched type const", () => {
        const result = validateFrontmatter({ ...valid, type: "note" }, type);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.instancePath === "/type")).toBe(true);
      });

      it("rejects missing required id", () => {
        const { id: _id, ...without } = valid;
        const result = validateFrontmatter(without as never, type);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.keyword === "required")).toBe(true);
      });

      it("rejects an invalid ULID", () => {
        const result = validateFrontmatter({ ...valid, id: "TOOSHORT" }, type);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.keyword === "pattern")).toBe(true);
      });
    });
  }
});

describe("validateFrontmatter — unknown type", () => {
  it("returns a synthetic enum error for unknown type", () => {
    const result = validateFrontmatter(VALID_NOTE, "alien" as never);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/Unknown doc type/);
  });
});

describe("end-to-end: createNote-like flow", () => {
  it("generates ULID, builds valid frontmatter, serializes, parses, validates", () => {
    const id = generateUlid();
    const now = new Date().toISOString();
    const data = {
      id,
      type: "note" as const,
      title: "Just Created",
      created: now,
      updated: now,
    };

    expect(validateFrontmatter(data, "note").valid).toBe(true);

    const serialized = serializeFrontmatter(data, "# Just Created\n");
    const reparsed = parseFrontmatter(serialized);
    expect(reparsed.data).toEqual(data);
    expect(validateFrontmatter(reparsed.data, "note").valid).toBe(true);
  });
});
