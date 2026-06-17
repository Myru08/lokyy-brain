import { describe, it, expect } from "vitest";

import {
  validateFrontmatter,
  serializeFrontmatter,
  parseFrontmatter,
} from "./index.js";
import {
  DOC_TYPES,
  KARPATHY_DOC_TYPES,
} from "./types.js";
import {
  VAULT_PROFILES,
  DEFAULT_VAULT_PROFILE,
  KARPATHY_TYPE_FOLDER,
  isVaultProfile,
  getProfileSpec,
  resolveVaultProfile,
} from "./profiles.js";

/* ------------------------------------------------------------------ *
 *  Story S2 / B1 — Vault-SPEC-Profil-Registry.
 * ------------------------------------------------------------------ */

describe("vault SPEC profiles (Story S2 / B1)", () => {
  it("exposes exactly the two profiles, default = para", () => {
    expect([...VAULT_PROFILES]).toEqual(["para", "karpathy"]);
    expect(DEFAULT_VAULT_PROFILE).toBe("para");
  });

  it("para profile carries the unchanged 15 PARA doc types", () => {
    const spec = getProfileSpec("para");
    expect([...spec.docTypes]).toEqual([...DOC_TYPES]);
    expect(spec.docTypes).toHaveLength(15);
  });

  it("karpathy profile carries only the three RAW/Wiki/Outputs types", () => {
    const spec = getProfileSpec("karpathy");
    expect([...spec.docTypes]).toEqual([...KARPATHY_DOC_TYPES]);
    // The two profiles are disjoint — no PARA type leaks into karpathy.
    for (const t of spec.docTypes) {
      expect(DOC_TYPES as readonly string[]).not.toContain(t);
    }
  });

  it("karpathy type→folder map is RAW/Wiki/Outputs", () => {
    expect(KARPATHY_TYPE_FOLDER).toEqual({
      "raw-source": "RAW",
      "wiki-article": "Wiki",
      "frage-report": "Outputs",
    });
  });

  it("isVaultProfile guards the closed list", () => {
    expect(isVaultProfile("para")).toBe(true);
    expect(isVaultProfile("karpathy")).toBe(true);
    expect(isVaultProfile("nope")).toBe(false);
    expect(isVaultProfile(undefined)).toBe(false);
  });

  it("getProfileSpec falls back to para for an unknown profile", () => {
    // @ts-expect-error — intentional bad input
    expect(getProfileSpec("bogus").profile).toBe("para");
  });

  describe("resolveVaultProfile", () => {
    it("defaults to para with no signal", () => {
      expect(resolveVaultProfile()).toBe("para");
      expect(resolveVaultProfile({})).toBe("para");
    });

    it("honours an explicit profile argument", () => {
      expect(resolveVaultProfile({ profile: "karpathy" })).toBe("karpathy");
      // invalid explicit value is ignored → falls through to default
      expect(resolveVaultProfile({ profile: "bogus" })).toBe("para");
    });

    it("reads the global env var", () => {
      const prev = process.env.LOKYY_VAULT_PROFILE;
      process.env.LOKYY_VAULT_PROFILE = "karpathy";
      try {
        expect(resolveVaultProfile()).toBe("karpathy");
      } finally {
        if (prev === undefined) delete process.env.LOKYY_VAULT_PROFILE;
        else process.env.LOKYY_VAULT_PROFILE = prev;
      }
    });

    it("a per-vault env var overrides the global", () => {
      const prevGlobal = process.env.LOKYY_VAULT_PROFILE;
      const key = "LOKYY_VAULT_PROFILE_PERSONAL_MSGWXNQA";
      const prevPer = process.env[key];
      process.env.LOKYY_VAULT_PROFILE = "karpathy";
      process.env[key] = "para";
      try {
        expect(resolveVaultProfile({ vaultId: "personal-msgwxnqa" })).toBe("para");
      } finally {
        if (prevGlobal === undefined) delete process.env.LOKYY_VAULT_PROFILE;
        else process.env.LOKYY_VAULT_PROFILE = prevGlobal;
        if (prevPer === undefined) delete process.env[key];
        else process.env[key] = prevPer;
      }
    });
  });
});

/* ------------------------------------------------------------------ *
 *  Story S2 / A1 — the three new doc types + schema constraints.
 * ------------------------------------------------------------------ */

const ISO = "2026-06-16T10:00:00.000Z";
const ULID = "01JXYZABCDEFGHJKMNPQRSTVWX";

describe("validateFrontmatter — karpathy profile (Story S2 / A1)", () => {
  describe("raw-source", () => {
    const valid = {
      id: ULID,
      type: "raw-source" as const,
      title: "Karpathy on RAG",
      created: ISO,
      updated: ISO,
      author: "Andrej Karpathy",
      source_url: "https://example.com/karpathy",
      date_added: "2026-06-16",
      date_published: "2026-01-15",
      source_type: "article",
    };

    it("accepts a valid raw-source", () => {
      const r = validateFrontmatter(valid, "raw-source", "karpathy");
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it("accepts `author`/`source_url` set to \"unbekannt\"", () => {
      const r = validateFrontmatter(
        { ...valid, author: "unbekannt", source_url: "unbekannt" },
        "raw-source",
        "karpathy",
      );
      expect(r.valid).toBe(true);
    });

    it("accepts date_published = \"unbekannt\" (Pflicht-Feld, Wert darf unbekannt sein)", () => {
      const r = validateFrontmatter(
        { ...valid, date_published: "unbekannt" },
        "raw-source",
        "karpathy",
      );
      expect(r.valid).toBe(true);
    });

    it("rejects an invalid source_type value", () => {
      const r = validateFrontmatter(
        { ...valid, source_type: "tweet" },
        "raw-source",
        "karpathy",
      );
      expect(r.valid).toBe(false);
      expect(
        r.errors.some((e) => e.instancePath === "/source_type" && e.keyword === "enum"),
      ).toBe(true);
    });

    it("rejects a non-date `date_added`", () => {
      const r = validateFrontmatter(
        { ...valid, date_added: "gestern" },
        "raw-source",
        "karpathy",
      );
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.instancePath === "/date_added")).toBe(true);
    });

    for (const field of [
      "author",
      "source_url",
      "date_added",
      "date_published",
      "source_type",
    ] as const) {
      it(`rejects a raw-source missing \`${field}\``, () => {
        const { [field]: _omit, ...without } = valid;
        const r = validateFrontmatter(without as never, "raw-source", "karpathy");
        expect(r.valid).toBe(false);
        expect(
          r.errors.some(
            (e) => e.keyword === "required" && e.params.missingProperty === field,
          ),
        ).toBe(true);
      });
    }
  });

  describe("wiki-article", () => {
    const base = {
      id: ULID,
      type: "wiki-article" as const,
      title: "Retrieval Augmented Generation",
      created: ISO,
      updated: ISO,
      stand: "2026-06-16",
    };

    it("accepts a gesichert article WITH sources (Klartext-RAW-Dateinamen)", () => {
      const r = validateFrontmatter(
        { ...base, status: "gesichert", sources: ["rag-paper.md"] },
        "wiki-article",
        "karpathy",
      );
      expect(r.valid).toBe(true);
    });

    it("accepts an `im Aufbau` article WITH sources", () => {
      const r = validateFrontmatter(
        { ...base, status: "im Aufbau", sources: ["rag-paper.md"] },
        "wiki-article",
        "karpathy",
      );
      expect(r.valid).toBe(true);
    });

    it("accepts a These article WITHOUT sources (persönliche Notiz ohne Beleg)", () => {
      const r = validateFrontmatter(
        { ...base, status: "These" },
        "wiki-article",
        "karpathy",
      );
      expect(r.valid).toBe(true);
    });

    it("accepts a These article with an EMPTY sources list", () => {
      const r = validateFrontmatter(
        { ...base, status: "These", sources: [] },
        "wiki-article",
        "karpathy",
      );
      expect(r.valid).toBe(true);
    });

    it("rejects a wiki-article with NO status", () => {
      const r = validateFrontmatter(base, "wiki-article", "karpathy");
      expect(r.valid).toBe(false);
      expect(
        r.errors.some(
          (e) => e.keyword === "required" && e.params.missingProperty === "status",
        ),
      ).toBe(true);
    });

    it("rejects a wiki-article with NO stand", () => {
      const { stand: _st, ...noStand } = base;
      const r = validateFrontmatter(
        { ...noStand, status: "These" },
        "wiki-article",
        "karpathy",
      );
      expect(r.valid).toBe(false);
      expect(
        r.errors.some(
          (e) => e.keyword === "required" && e.params.missingProperty === "stand",
        ),
      ).toBe(true);
    });

    it("rejects status=gesichert WITHOUT sources (conditional source-pflicht)", () => {
      const r = validateFrontmatter(
        { ...base, status: "gesichert" },
        "wiki-article",
        "karpathy",
      );
      expect(r.valid).toBe(false);
      expect(
        r.errors.some(
          (e) => e.keyword === "required" && e.params.missingProperty === "sources",
        ),
      ).toBe(true);
    });

    it("rejects status=`im Aufbau` WITHOUT sources (im Aufbau = eine Quelle)", () => {
      const r = validateFrontmatter(
        { ...base, status: "im Aufbau" },
        "wiki-article",
        "karpathy",
      );
      expect(r.valid).toBe(false);
      expect(
        r.errors.some(
          (e) => e.keyword === "required" && e.params.missingProperty === "sources",
        ),
      ).toBe(true);
    });

    it("rejects status=gesichert with an EMPTY sources list (minItems)", () => {
      const r = validateFrontmatter(
        { ...base, status: "gesichert", sources: [] },
        "wiki-article",
        "karpathy",
      );
      expect(r.valid).toBe(false);
      expect(
        r.errors.some((e) => e.instancePath === "/sources" && e.keyword === "minItems"),
      ).toBe(true);
    });

    it("rejects status=`im Aufbau` with an EMPTY sources list (minItems)", () => {
      const r = validateFrontmatter(
        { ...base, status: "im Aufbau", sources: [] },
        "wiki-article",
        "karpathy",
      );
      expect(r.valid).toBe(false);
      expect(
        r.errors.some((e) => e.instancePath === "/sources" && e.keyword === "minItems"),
      ).toBe(true);
    });

    it("rejects an invalid status value", () => {
      const r = validateFrontmatter(
        { ...base, status: "draft" },
        "wiki-article",
        "karpathy",
      );
      expect(r.valid).toBe(false);
      expect(
        r.errors.some((e) => e.instancePath === "/status" && e.keyword === "enum"),
      ).toBe(true);
    });

    it("round-trips a valid article through serialize/parse", () => {
      const note = {
        ...base,
        status: "gesichert",
        sources: ["rag-paper.md", "karpathy-talk.md"],
      };
      const reparsed = parseFrontmatter(serializeFrontmatter(note, "# RAG\n"));
      expect(reparsed.data).toEqual(note);
      expect(validateFrontmatter(reparsed.data, "wiki-article", "karpathy").valid).toBe(
        true,
      );
    });
  });

  describe("frage-report", () => {
    const valid = {
      id: ULID,
      type: "frage-report" as const,
      title: "Was ist RAG?",
      created: ISO,
      updated: ISO,
      question: "Was ist Retrieval Augmented Generation?",
      sources: ["rag-paper.md", "retrieval-augmented-generation.md"],
    };

    it("accepts a valid frage-report", () => {
      const r = validateFrontmatter(valid, "frage-report", "karpathy");
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it("accepts an optional `stand` date and round-trips it", () => {
      const withStand = { ...valid, stand: "2026-06-16" };
      const r = validateFrontmatter(withStand, "frage-report", "karpathy");
      expect(r.valid).toBe(true);
      const reparsed = parseFrontmatter(serializeFrontmatter(withStand, "# Antwort\n"));
      expect(reparsed.data).toEqual(withStand);
    });

    it("rejects a frage-report missing `question`", () => {
      const { question: _q, ...without } = valid;
      const r = validateFrontmatter(without as never, "frage-report", "karpathy");
      expect(r.valid).toBe(false);
      expect(
        r.errors.some(
          (e) => e.keyword === "required" && e.params.missingProperty === "question",
        ),
      ).toBe(true);
    });

    it("rejects a frage-report missing `sources`", () => {
      const { sources: _s, ...without } = valid;
      const r = validateFrontmatter(without as never, "frage-report", "karpathy");
      expect(r.valid).toBe(false);
      expect(
        r.errors.some(
          (e) => e.keyword === "required" && e.params.missingProperty === "sources",
        ),
      ).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ *
 *  Story S2 / B1 — backward-compat: PARA default profile unchanged.
 * ------------------------------------------------------------------ */

describe("PARA default profile stays valid (Story S2 backward-compat)", () => {
  const PARA_NOTE = {
    id: ULID,
    type: "project" as const,
    title: "Existing PARA note",
    created: ISO,
    updated: ISO,
  };

  it("an existing PARA note validates under the DEFAULT profile (no profile arg)", () => {
    // This is the exact legacy call shape used by server/mcp — unchanged.
    expect(validateFrontmatter(PARA_NOTE, "project").valid).toBe(true);
  });

  it("the same note validates when para is passed explicitly", () => {
    expect(validateFrontmatter(PARA_NOTE, "project", "para").valid).toBe(true);
  });

  it("a karpathy type is UNKNOWN under the para profile (profiles are real boundaries)", () => {
    const r = validateFrontmatter(
      {
        id: ULID,
        type: "wiki-article",
        title: "x",
        created: ISO,
        updated: ISO,
        status: "These",
      },
      "wiki-article" as never,
      "para",
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.message).toMatch(/Unknown doc type.*para/);
  });

  it("a PARA type is UNKNOWN under the karpathy profile", () => {
    const r = validateFrontmatter(PARA_NOTE, "project" as never, "karpathy");
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.message).toMatch(/Unknown doc type.*karpathy/);
  });
});
