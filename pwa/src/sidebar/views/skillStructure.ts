import type { TreeNode } from "@lokyy/shared";

/**
 * Struktur-Ableitung für die SkillsView (Story 12.2).
 *
 * Epic 12 führt **Ordner-Skills** (Anthropic-Format) ein: ein Skill kann ein
 * ORDNER `70_pai/skills/<name>/` sein mit einer `SKILL.md` (`type: skill`) als
 * Eingangstür plus Begleit-Files unter `references/*.md` und `templates/*`.
 * Daneben existieren weiter **Einzel-Note-Skills** (`<name>.md` direkt unter
 * dem Skills-Root) — rückwärtskompatibel (Phase-1-Skills wie skill-creator).
 *
 * Diese Datei kapselt die **rein synchrone** Ableitung der Skill-Struktur aus
 * dem Datei-Baum (`api.tree()`-Ausgabe, auf den Skills-Root gescoped). Sie
 * arbeitet ausschließlich auf Pfaden/Namen — KEIN Frontmatter-Wissen, KEIN
 * Async. Damit ist sie hart testbar (vitest) und entkoppelt von der
 * eigentlichen `type: skill`-Bestätigung, die erst nach dem Laden der
 * `SKILL.md`/Einzel-Note-Bodies erfolgt.
 *
 * Vertrag der Ableitung:
 * - Ordner mit `SKILL.md`-Kind → EIN `folder-skill`-Kandidat; `mainPath` ist
 *   die SKILL.md (deren Body bestätigt `type: skill`). Begleit-Files werden in
 *   `references` (alle `.md` unter `<dir>/references/`) und `templates` (ALLE
 *   Dateien unter `<dir>/templates/`, auch non-`.md`) gruppiert.
 * - `.md` DIREKT unter dem Root, das KEIN `SKILL.md` eines Ordners ist →
 *   `single-note`-Kandidat (`mainPath` = die Note selbst).
 * - **Keine Doppelung:** Begleit-Files eines Ordner-Skills tauchen NICHT als
 *   eigene Kandidaten auf. Auch eine `SKILL.md` selbst ist nie ein
 *   `single-note`-Kandidat.
 *
 * [Source: epic-12-ordner-skills.md — Stories 12.1/12.2]
 */

/** Dateiname der Skill-Eingangstür im Ordner-Skill-Format. */
export const SKILL_FILE = "SKILL.md";

/** Begleit-Datei eines Ordner-Skills (reference oder template). */
export interface CompanionFile {
  /** Note-id bzw. Pfad ohne ".md" (TreeNode.path) — an `onOpenNote`. */
  id: string;
  /** Anzeigename (Dateiname, z.B. "dashboard.jsx" oder "tone-of-voice"). */
  name: string;
  /** Vault-relativer Originalpfad inkl. Endung (für non-`.md` sichtbar). */
  path: string;
  /** true, wenn der Pfad auf `.md` endet (öffenbar im Editor). */
  isMarkdown: boolean;
}

/**
 * Ein Skill-Kandidat aus der reinen Tree-Ableitung. Ob er wirklich ein Skill
 * ist (`type: skill`), bestätigt erst das Laden des `mainPath`-Bodys.
 */
export interface SkillStructure {
  /** "folder-skill" = Ordner mit SKILL.md; "single-note" = lose `.md`. */
  kind: "folder-skill" | "single-note";
  /**
   * Name des Skills. Bei Ordner-Skills der Ordnername, bei Einzel-Notes der
   * Dateiname (ohne ".md"). Dient als stabile Sortier-/Dedup-Schlüssel.
   */
  name: string;
  /** Note-id der Haupt-Note (SKILL.md bzw. die Einzel-Note). */
  mainPath: string;
  /** Begleit-`.md` unter `references/` (leer bei single-note). */
  references: CompanionFile[];
  /** Begleit-Dateien (auch non-`.md`) unter `templates/` (leer bei single-note). */
  templates: CompanionFile[];
}

/** Letztes Pfadsegment ohne ".md"-Endung. */
function baseName(path: string): string {
  const seg = path.slice(path.lastIndexOf("/") + 1);
  return seg.endsWith(".md") ? seg.slice(0, -3) : seg;
}

/** Sammelt rekursiv ALLE Knoten (Notes + Ordner-Blätter) unter `nodes`. */
function flattenFiles(nodes: TreeNode[]): CompanionFile[] {
  const out: CompanionFile[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.type === "note") {
        // TreeNode.path bei Notes = id (ohne ".md"). Für die Anzeige des
        // echten Dateinamens hängen wir die Endung wieder an.
        out.push({
          id: node.path,
          name: baseName(node.path),
          path: `${node.path}.md`,
          isMarkdown: true,
        });
      } else if (node.children.length > 0) {
        walk(node.children);
      } else {
        // Leerer Ordner — irrelevant für Begleit-Files.
      }
    }
  };
  walk(nodes);
  return out;
}

/**
 * Sammelt Begleit-Dateien unter einem benannten Unterordner (`references` /
 * `templates`) eines Ordner-Skills. Für `templates` zählen AUCH non-`.md`
 * (z.B. `dashboard.jsx`); der Tree liefert non-`.md` allerdings nur, wenn der
 * Server sie ausliefert — wir behandeln jeden Note-Knoten als Markdown und
 * lassen Nicht-Markdown-Knoten (falls je vorhanden) defensiv durch.
 */
function collectCompanions(
  folderChildren: TreeNode[],
  subDir: string,
): CompanionFile[] {
  const dir = folderChildren.find(
    (c) => c.type === "folder" && baseName(c.path) === subDir,
  );
  if (!dir) return [];
  return flattenFiles(dir.children).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Leitet aus dem auf den Skills-Root gescopeden Tree die Skill-Struktur ab.
 *
 * `scopedTree` sind die KINDER des Skills-Root (z.B. die Kinder von
 * `70_pai/skills`). Liefert eine Liste von Kandidaten — Ordner-Skills und
 * Einzel-Note-Skills — frei von Doppelungen.
 */
export function deriveSkillStructures(scopedTree: TreeNode[]): SkillStructure[] {
  const out: SkillStructure[] = [];

  for (const node of scopedTree) {
    if (node.type === "folder") {
      // Ordner-Skill genau dann, wenn ein direktes Kind `SKILL.md` ist.
      const skillFile = node.children.find(
        (c) => c.type === "note" && `${baseName(c.path)}.md` === SKILL_FILE,
      );
      if (skillFile) {
        out.push({
          kind: "folder-skill",
          name: baseName(node.path),
          mainPath: skillFile.path,
          references: collectCompanions(node.children, "references"),
          templates: collectCompanions(node.children, "templates"),
        });
      }
      // Ordner OHNE SKILL.md: kein Skill. Wir steigen bewusst NICHT tiefer ein
      // — Skills liegen eine Ebene unter dem Root (Anthropic-Konvention).
      // (Verschachtelte Einzel-Note-Skills werden hier nicht erkannt; das ist
      // das gewünschte v1-Verhalten — flach unter dem Root.)
    } else if (node.type === "note") {
      // Lose `.md` direkt unter dem Root → Einzel-Note-Skill. Eine `SKILL.md`
      // direkt im Root (ohne umschließenden Ordner) ist KEIN Ordner-Skill und
      // wird wie eine Einzel-Note behandelt — defensiv, sollte selten sein.
      out.push({
        kind: "single-note",
        name: baseName(node.path),
        mainPath: node.path,
        references: [],
        templates: [],
      });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
