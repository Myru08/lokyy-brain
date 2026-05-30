import { describe, it, expect } from "vitest";
import {
  SKILLS_FOLDER,
  slugifySkillName,
  validateSkillInput,
  skillPath,
  defaultSkillBody,
  buildSkillNoteMarkdown,
  type NewSkillInput,
} from "./skillTemplate.js";

/**
 * Vitest für die Vorlagen-/Frontmatter-Generierung (PFLICHT). Prüft auf
 * Funktions-Ebene (kein E2E): Slugify, Pflichtfeld-Validierung und vor allem,
 * dass aus den Eingaben ein SPEC-valides `type: skill`-Frontmatter + Body
 * entsteht. Die Lehre der Session: Build-grün allein reicht nicht — die
 * Generierungslogik wird hier hart geprüft.
 */

/** Mini-Frontmatter-Parser für den Test — KEINE Prod-Abhängigkeit. */
function parseFrontmatter(md: string): {
  fmRaw: string;
  data: Record<string, unknown>;
  body: string;
} {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  if (!m) throw new Error("kein Frontmatter-Block gefunden");
  const fmRaw = m[1] as string;
  const body = m[2] as string;
  const data: Record<string, unknown> = {};
  const lines = fmRaw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const km = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1] as string;
    const rest = (km[2] ?? "").trim();
    if (rest === "") {
      // Block-Liste auf den Folgezeilen sammeln.
      const list: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const lm = /^\s*-\s+(.*)$/.exec(lines[j] as string);
        if (!lm) break;
        list.push(unquote((lm[1] as string).trim()));
      }
      i = j - 1;
      data[key] = list;
    } else {
      data[key] = unquote(rest);
    }
  }
  return { fmRaw, data, body };
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

const REQUIRED_FM_KEYS = ["type", "title", "skill_name", "description"];

describe("slugifySkillName", () => {
  it("macht aus einem Titel lowercase-kebab", () => {
    expect(slugifySkillName("Weekly Review")).toBe("weekly-review");
  });

  it("entfernt Diakritika und Sonderzeichen", () => {
    expect(slugifySkillName("Köln — Tägliche Zusammenfassung!")).toBe(
      "koln-tagliche-zusammenfassung",
    );
  });

  it("kollabiert Mehrfach- und Rand-Bindestriche", () => {
    expect(slugifySkillName("  --Foo   &&  Bar--  ")).toBe("foo-bar");
  });

  it("ergibt nur erlaubte Zeichen (^[a-z0-9-]+$)", () => {
    expect(slugifySkillName("Skill #1 (v2.0)")).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("validateSkillInput", () => {
  const base: NewSkillInput = {
    title: "Mein Skill",
    skillName: "mein-skill",
    description: "Tut etwas Nützliches.",
    body: "Body",
  };

  it("akzeptiert valide Eingaben (keine Fehler)", () => {
    expect(validateSkillInput(base)).toEqual({});
  });

  it("meldet fehlenden Titel", () => {
    expect(validateSkillInput({ ...base, title: "   " }).title).toBeTruthy();
  });

  it("meldet leeren skill_name", () => {
    expect(validateSkillInput({ ...base, skillName: "" }).skillName).toBeTruthy();
  });

  it("meldet ungültigen skill_name (Großbuchstaben/Spaces)", () => {
    expect(validateSkillInput({ ...base, skillName: "Mein Skill" }).skillName).toBeTruthy();
  });

  it("meldet fehlende Beschreibung", () => {
    expect(validateSkillInput({ ...base, description: "" }).description).toBeTruthy();
  });
});

describe("skillPath", () => {
  it("legt unter 70_pai/skills/<name> ab", () => {
    expect(skillPath("weekly-review")).toBe(`${SKILLS_FOLDER}/weekly-review`);
    expect(SKILLS_FOLDER).toBe("70_pai/skills");
  });
});

describe("buildSkillNoteMarkdown", () => {
  const input: NewSkillInput = {
    title: "Weekly Review",
    skillName: "weekly-review",
    description: "Fasst die letzten N Tage zusammen.",
    body: "# Weekly Review\n\nReview {{topic}}.\n",
    allowedTools: ["search_vault", "read_note"],
  };

  it("erzeugt einen Frontmatter-Block mit allen Pflichtfeldern", () => {
    const md = buildSkillNoteMarkdown(input);
    const { data } = parseFrontmatter(md);
    for (const key of REQUIRED_FM_KEYS) {
      expect(data[key], `Pflichtfeld ${key} fehlt`).toBeDefined();
    }
  });

  it("setzt type=skill, execution=client und die Eingabe-Werte", () => {
    const { data } = parseFrontmatter(buildSkillNoteMarkdown(input));
    expect(data.type).toBe("skill");
    expect(data.execution).toBe("client");
    expect(data.title).toBe("Weekly Review");
    expect(data.skill_name).toBe("weekly-review");
    expect(data.description).toBe("Fasst die letzten N Tage zusammen.");
  });

  it("serialisiert allowed_tools als YAML-Block-Liste", () => {
    const { data } = parseFrontmatter(buildSkillNoteMarkdown(input));
    expect(data.allowed_tools).toEqual(["search_vault", "read_note"]);
  });

  it("lässt allowed_tools weg, wenn keine Tools angegeben sind", () => {
    const md = buildSkillNoteMarkdown({ ...input, allowedTools: [] });
    expect(md).not.toContain("allowed_tools");
  });

  it("INJIZIERT KEINE id/created/updated (Server-Verantwortung)", () => {
    const md = buildSkillNoteMarkdown(input);
    const { data } = parseFrontmatter(md);
    expect(data.id).toBeUndefined();
    expect(data.created).toBeUndefined();
    expect(data.updated).toBeUndefined();
  });

  it("übernimmt den Body und behält {{token}} bei", () => {
    const { body } = parseFrontmatter(buildSkillNoteMarkdown(input));
    expect(body).toContain("Review {{topic}}.");
  });

  it("füllt einen leeren Body mit dem Vorlagen-Gerüst", () => {
    const { body } = parseFrontmatter(
      buildSkillNoteMarkdown({ ...input, body: "   " }),
    );
    expect(body).toContain("# Weekly Review");
    expect(body).toContain("{{topic}}");
  });

  it("quotet Beschreibungen mit YAML-kritischen Zeichen sicher", () => {
    const md = buildSkillNoteMarkdown({
      ...input,
      description: 'Mit: Doppelpunkt und "Quotes".',
    });
    // Muss wieder sauber parsebar sein.
    const { data } = parseFrontmatter(md);
    expect(data.description).toBe('Mit: Doppelpunkt und "Quotes".');
  });

  it("endet mit genau einem Newline", () => {
    const md = buildSkillNoteMarkdown(input);
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });
});

describe("defaultSkillBody", () => {
  it("nutzt den Titel als H1 und zeigt das Token-Muster", () => {
    const body = defaultSkillBody("Mein Tolles Tool");
    expect(body).toContain("# Mein Tolles Tool");
    expect(body).toMatch(/\{\{[a-z]+\}\}/);
  });
});
