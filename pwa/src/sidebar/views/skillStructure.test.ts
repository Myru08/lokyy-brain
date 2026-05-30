import { describe, expect, it } from "vitest";
import type { TreeNode } from "@lokyy/shared";
import { deriveSkillStructures } from "./skillStructure.js";

/**
 * Story 12.2 — Struktur-Ableitung (PFLICHT-Test).
 *
 * Pinnt den Vertrag von `deriveSkillStructures`: aus dem auf den Skills-Root
 * gescopeden Tree entstehen genau die richtigen Skill-Kandidaten —
 * Ordner-Skills (Ordner mit `SKILL.md`) vs. Einzel-Note-Skills (lose `.md`),
 * mit korrekt gruppierten `references/`/`templates/` und OHNE Doppelung.
 *
 * Lehre der Vorgänger-Stories: Build-grün allein fängt Loading-/Ableitungs-
 * Bugs nicht — die reine Ableitungslogik wird hier hart geprüft.
 */

/** Helper: Note-Knoten (TreeNode.path bei Notes = id ohne ".md"). */
function note(path: string): TreeNode {
  return {
    type: "note",
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    children: [],
  };
}

/** Helper: Ordner-Knoten. */
function folder(path: string, children: TreeNode[]): TreeNode {
  return {
    type: "folder",
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    children,
  };
}

const ROOT = "70_pai/skills";

describe("deriveSkillStructures", () => {
  it("erkennt einen Ordner mit SKILL.md als EINEN folder-skill", () => {
    const tree: TreeNode[] = [
      folder(`${ROOT}/weekly-review`, [
        note(`${ROOT}/weekly-review/SKILL`),
      ]),
    ];
    const out = deriveSkillStructures(tree);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "folder-skill",
      name: "weekly-review",
      mainPath: `${ROOT}/weekly-review/SKILL`,
    });
    expect(out[0]?.references).toEqual([]);
    expect(out[0]?.templates).toEqual([]);
  });

  it("gruppiert references/ und templates/ korrekt und ohne Doppelung", () => {
    const tree: TreeNode[] = [
      folder(`${ROOT}/content-engine`, [
        note(`${ROOT}/content-engine/SKILL`),
        folder(`${ROOT}/content-engine/references`, [
          note(`${ROOT}/content-engine/references/tone-of-voice`),
          note(`${ROOT}/content-engine/references/examples`),
        ]),
        folder(`${ROOT}/content-engine/templates`, [
          note(`${ROOT}/content-engine/templates/post`),
        ]),
      ]),
    ];
    const out = deriveSkillStructures(tree);

    // GENAU ein Eintrag — SKILL.md + Begleiter dürfen NICHT je eigene
    // Kandidaten werden (Doppel-Erkennung vermeiden).
    expect(out).toHaveLength(1);
    const skill = out[0]!;
    expect(skill.kind).toBe("folder-skill");
    expect(skill.name).toBe("content-engine");

    // references/ alphabetisch.
    expect(skill.references.map((r) => r.name)).toEqual([
      "examples",
      "tone-of-voice",
    ]);
    expect(skill.references[0]).toMatchObject({
      id: `${ROOT}/content-engine/references/examples`,
      path: `${ROOT}/content-engine/references/examples.md`,
      isMarkdown: true,
    });

    // templates/.
    expect(skill.templates.map((t) => t.name)).toEqual(["post"]);
    expect(skill.templates[0]?.id).toBe(`${ROOT}/content-engine/templates/post`);

    // KEIN Begleit-File darf als eigener Skill-Kandidat existieren.
    const ids = out.map((s) => s.mainPath);
    expect(ids).not.toContain(`${ROOT}/content-engine/references/tone-of-voice`);
    expect(ids).not.toContain(`${ROOT}/content-engine/templates/post`);
  });

  it("behandelt lose `.md` direkt unter dem Root als single-note-Skill", () => {
    const tree: TreeNode[] = [note(`${ROOT}/skill-creator`)];
    const out = deriveSkillStructures(tree);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "single-note",
      name: "skill-creator",
      mainPath: `${ROOT}/skill-creator`,
      references: [],
      templates: [],
    });
  });

  it("mischt Ordner-Skills und Einzel-Note-Skills, alphabetisch sortiert", () => {
    const tree: TreeNode[] = [
      note(`${ROOT}/zebra-note`),
      folder(`${ROOT}/alpha-folder`, [note(`${ROOT}/alpha-folder/SKILL`)]),
      note(`${ROOT}/mid-note`),
    ];
    const out = deriveSkillStructures(tree);
    expect(out.map((s) => s.name)).toEqual([
      "alpha-folder",
      "mid-note",
      "zebra-note",
    ]);
    expect(out.map((s) => s.kind)).toEqual([
      "folder-skill",
      "single-note",
      "single-note",
    ]);
  });

  it("ignoriert Ordner OHNE SKILL.md (kein Skill, keine Begleiter-Leaks)", () => {
    const tree: TreeNode[] = [
      folder(`${ROOT}/just-docs`, [
        note(`${ROOT}/just-docs/readme`),
        note(`${ROOT}/just-docs/notes`),
      ]),
    ];
    const out = deriveSkillStructures(tree);
    // Kein SKILL.md → der Ordner ist kein Skill; seine `.md` lecken NICHT als
    // Einzel-Note-Skills durch (sie liegen nicht direkt unter dem Root).
    expect(out).toEqual([]);
  });

  it("erkennt SKILL.md anhand des Dateinamens, nicht der Verschachtelungstiefe", () => {
    // Ein references-Unterordner, der zufällig eine Datei `SKILL` enthält,
    // wird NICHT zu einem zweiten Skill — nur das DIREKTE Kind des
    // Skill-Ordners zählt als Eingangstür.
    const tree: TreeNode[] = [
      folder(`${ROOT}/nested`, [
        note(`${ROOT}/nested/SKILL`),
        folder(`${ROOT}/nested/references`, [
          note(`${ROOT}/nested/references/deep`),
        ]),
      ]),
    ];
    const out = deriveSkillStructures(tree);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("folder-skill");
    expect(out[0]?.references.map((r) => r.name)).toEqual(["deep"]);
  });

  it("liefert bei leerem Tree eine leere Liste", () => {
    expect(deriveSkillStructures([])).toEqual([]);
  });
});
