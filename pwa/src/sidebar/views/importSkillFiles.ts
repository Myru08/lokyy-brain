/**
 * importSkillFiles — reine, DOM-/React-/Netzwerk-freie Helfer für den
 * Ordner-Skill-Import (Story 12.3, Epic 12).
 *
 * Ein `<input type="file" webkitdirectory>` liefert eine FileList, in der jede
 * `File` ein `webkitRelativePath` der Form `<gewählter-ordner>/SKILL.md`,
 * `<gewählter-ordner>/references/x.md` … trägt. Diese Datei normalisiert die
 * Auswahl in:
 *   - den vorgeschlagenen Skill-Namen (oberstes Ordner-Segment, slugifiziert)
 *   - die Liste { relPath, file } mit Pfaden RELATIV zur Skill-Wurzel
 *     (oberstes Ordner-Segment abgestreift) — exakt das Format, das
 *     `api.importSkill` / die Server-Route erwarten.
 *
 * Bewusst rein + testbar (PFLICHT-Vitest), ohne UI/Server zu mocken. Die
 * Datei kennt nur die Web-Typen `File`/`FileList` (in jsdom verfügbar).
 *
 * [Source: server/src/routes/skills.ts (POST /api/skills/import),
 *  pwa/src/api.ts importSkill; Story 12.3]
 */

import { slugifySkillName } from "./skillTemplate.js";

/** Eine ausgewählte Datei mit ihrem Pfad relativ zur Skill-Wurzel. */
export interface SelectedSkillFile {
  /** POSIX-Pfad relativ zur Skill-Wurzel, z. B. `SKILL.md`, `references/a.md`. */
  relPath: string;
  /** Das rohe File-Objekt zum Hochladen. */
  file: File;
}

/** Ergebnis der Auswahl-Normalisierung. */
export interface CollectedSkillUpload {
  /** Vorgeschlagener Skill-Name (slugifiziert; leer, wenn nicht ableitbar). */
  suggestedName: string;
  /** Dateien mit relativen Pfaden, dedupliziert, deterministisch sortiert. */
  files: SelectedSkillFile[];
  /** true, wenn eine `SKILL.md` an der Wurzel der Auswahl gefunden wurde. */
  hasSkillMd: boolean;
}

/**
 * Liest den verlässlichsten Pfad einer hochgeladenen Datei: bei
 * `webkitdirectory` trägt das File ein non-standard `webkitRelativePath`
 * (`ordner/unterordner/datei`). Fallback: der bloße `file.name`.
 */
function rawRelativePath(file: File): string {
  const wk = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  const raw = wk && wk.trim() !== "" ? wk : file.name;
  return raw.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Oberstes Ordner-Segment (vor dem ersten `/`) oder `""`, wenn flach. */
function topSegment(relPath: string): string {
  const idx = relPath.indexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

/** Streift genau das oberste Ordner-Segment (Skill-Wurzel) ab. */
function stripTopSegment(relPath: string): string {
  const idx = relPath.indexOf("/");
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/**
 * Normalisiert eine FileList (oder ein File-Array) aus dem Ordner-Upload in
 * `{ suggestedName, files, hasSkillMd }`.
 *
 * Regeln:
 *  - Der vorgeschlagene Name kommt aus dem gemeinsamen obersten Ordner-Segment
 *    (so wie es `webkitdirectory` voranstellt), slugifiziert. Tragen alle
 *    Dateien dasselbe Top-Segment, wird dieses abgestreift, damit die
 *    Skill-Wurzel zur Import-Wurzel wird (`SKILL.md` statt `name/SKILL.md`).
 *  - Uneinheitliche oder fehlende Top-Segmente (z. B. Einzeldatei-Auswahl) →
 *    Pfade bleiben unverändert; der Name bleibt leer und muss gesetzt werden.
 *  - Versteckte Dateien (Segment beginnt mit `.`, z. B. `.DS_Store`,
 *    `.git/…`) werden verworfen.
 *  - `hasSkillMd` prüft case-insensitiv auf eine `SKILL.md` an der Wurzel der
 *    abgestreiften Pfade.
 */
export function collectSkillUpload(
  list: FileList | File[],
): CollectedSkillUpload {
  const arr: File[] = Array.from(list as ArrayLike<File>);

  // Rohpfade ermitteln, versteckte Segmente verwerfen.
  const raw = arr
    .map((file) => ({ relPath: rawRelativePath(file), file }))
    .filter(({ relPath }) =>
      relPath.split("/").every((seg) => seg !== "" && !seg.startsWith(".")),
    );

  // Gemeinsames Top-Segment bestimmen (für Name + Abstreifen).
  const tops = new Set(raw.map(({ relPath }) => topSegment(relPath)));
  const commonTop =
    tops.size === 1 && !tops.has("") ? ([...tops][0] as string) : "";

  const files: SelectedSkillFile[] = raw.map(({ relPath, file }) => ({
    relPath: commonTop ? stripTopSegment(relPath) : relPath,
    file,
  }));

  // Dedup (gleicher relPath gewinnt: erstes Vorkommen), deterministisch sortiert
  // — SKILL.md zuerst, dann alphabetisch (stabil für UI + Tests).
  const seen = new Set<string>();
  const deduped = files.filter((f) => {
    if (seen.has(f.relPath)) return false;
    seen.add(f.relPath);
    return true;
  });
  deduped.sort((a, b) => {
    const aRoot = a.relPath.toLowerCase() === "skill.md";
    const bRoot = b.relPath.toLowerCase() === "skill.md";
    if (aRoot !== bRoot) return aRoot ? -1 : 1;
    return a.relPath.localeCompare(b.relPath);
  });

  const hasSkillMd = deduped.some(
    (f) => f.relPath.toLowerCase() === "skill.md",
  );

  return {
    suggestedName: commonTop ? slugifySkillName(commonTop) : "",
    files: deduped,
    hasSkillMd,
  };
}
