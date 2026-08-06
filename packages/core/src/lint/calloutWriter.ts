import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getNote, saveNote } from "../notes/notesService.js";
import { parseFrontmatter } from "../frontmatter/index.js";
import { parseTitle } from "../graph/graphService.js";
import { coreConfig } from "../util/coreConfig.js";
import type { LintSeverity } from "../db/schema/lintFindings.js";

/**
 * Callout-Writer — macht Lint-Funde IN der Notiz sichtbar.
 *
 * Ein Fund, der nur in einer Datenbank-Zeile steht, existiert für den Nutzer
 * nicht. Dieser Writer schreibt für ein offenes Finding einen Markdown-
 * Callout („roter Kasten") in jede betroffene Notiz — mit beiden Aussagen,
 * Wikilinks auf die Quellen und der Regel, dass die QUELLE zu reparieren ist
 * und nicht bloß der Kasten zu löschen.
 *
 * Identität = Anker-Kommentarpaar um den Block:
 *
 *     <!-- lokyy-lint:<findingId> -->
 *     > [!warning] …
 *     <!-- /lokyy-lint:<findingId> -->
 *
 * Warum HTML-Kommentare statt eines Frontmatter-Feldes: der Kasten ist
 * Body-Inhalt und muss mit dem Body wandern (Move/Rename/Merge). Der Anker
 * ist in gerendertem Markdown unsichtbar, im Editor blendet ihn die CM6-
 * Extension `pwa/src/editor/callouts.ts` zusätzlich aus.
 *
 * Idempotenz: `insertCalloutBlock` entfernt einen bestehenden Block mit
 * derselben Finding-ID, bevor der neue gesetzt wird. Ein zweiter Lint-Lauf
 * erzeugt daher niemals einen Doppel-Kasten. Blöcke ANDERER Findings bleiben
 * unangetastet.
 *
 * Schreibpfad: ausschließlich `saveNote` (Story-Vorgabe + Vault-Contract).
 * Damit bleibt das SPEC-Frontmatter unangetastet, `updated` wird über den
 * regulären Pfad gesetzt und der Commit läuft über gitService. Der Block
 * wird immer NACH dem Frontmatter-Fence eingefügt, nie hinein.
 */

export interface CalloutStatement {
  /** Note-ID (Vault-Pfad ohne `.md`) — wird zum Wikilink-Ziel. */
  noteId: string;
  title: string;
  /** Die Aussage selbst (Kurz-Exzerpt aus der Notiz). */
  text: string;
}

export interface CalloutFinding {
  id: string;
  kind: string;
  severity: LintSeverity;
  message: string;
  statements: CalloutStatement[];
}

export interface CalloutWriteResult {
  /** Notizen, in die der Kasten neu geschrieben wurde. */
  written: string[];
  /** Notizen, die den Kasten bereits identisch trugen. */
  unchanged: string[];
  /** Notizen, die es nicht (mehr) gibt. */
  missing: string[];
}

export interface CalloutRemoveResult {
  removed: string[];
  unchanged: string[];
  missing: string[];
}

/** Callout-Typ je Severity — Obsidian-kompatible Callout-Namen. */
const CALLOUT_TYPE: Record<LintSeverity, string> = {
  info: "info",
  warning: "warning",
  error: "danger",
};

/** Überschrift je Lint-Kind. Fallback für künftige Kinds ist bewusst generisch. */
const HEADLINE: Record<string, string> = {
  contradiction: "Widerspruch — zwei Aussagen stehen gegeneinander",
  duplicate: "Mögliche Dublette",
  missing_link: "Fehlende Zielnotiz",
  orphan: "Verwaiste Notiz",
  schema_drift: "Frontmatter passt nicht zum Schema",
};

const REPAIR_RULE =
  "**Regel: Quelle reparieren, nicht nur den Kasten löschen.** " +
  "Auflösen im Lint-Panel — dort wählst du, welche Aussage gilt (oder „beide ok“).";

/** Label-Buchstaben für die Aussagen: A, B, C, … */
const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function openAnchor(findingId: string): string {
  return `<!-- lokyy-lint:${findingId} -->`;
}

export function closeAnchor(findingId: string): string {
  return `<!-- /lokyy-lint:${findingId} -->`;
}

/** Jede Zeile als Blockquote-Zeile ausgeben (leere Zeilen werden zu `>`). */
function quote(text: string): string[] {
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`));
}

/**
 * Baut den vollständigen Markdown-Block inklusive Anker. Ohne abschließenden
 * Zeilenumbruch — den setzt `insertCalloutBlock`.
 */
export function buildCalloutBlock(finding: CalloutFinding): string {
  const type = CALLOUT_TYPE[finding.severity] ?? "warning";
  const headline = HEADLINE[finding.kind] ?? "Lint-Fund";

  const lines: string[] = [];
  lines.push(openAnchor(finding.id));
  lines.push(`> [!${type}] ${headline}`);
  lines.push(...quote(finding.message));

  finding.statements.forEach((statement, i) => {
    const label = LABELS[i] ?? String(i + 1);
    lines.push(">");
    lines.push(
      `> **${label} · [[${statement.noteId}|${statement.title}]]**`,
    );
    // Aussage als verschachteltes Zitat — hebt sie optisch vom Rahmentext ab
    // und bleibt trotzdem Teil des Callout-Blocks (führendes `>`).
    lines.push(...quote(statement.text).map((l) => (l === ">" ? ">" : `> ${l}`)));
  });

  lines.push(">");
  lines.push(`> ${REPAIR_RULE}`);
  lines.push(closeAnchor(finding.id));

  return lines.join("\n");
}

/** Trägt die Notiz einen Kasten für dieses Finding? */
export function hasCalloutBlock(text: string, findingId: string): boolean {
  return (
    text.includes(openAnchor(findingId)) && text.includes(closeAnchor(findingId))
  );
}

/**
 * Entfernt den Block dieses Findings — inklusive der einen Leerzeile, die
 * `insertCalloutBlock` als Abstand gesetzt hat. Blöcke anderer Findings
 * bleiben stehen.
 */
export function stripCalloutBlock(
  text: string,
  findingId: string,
): { text: string; changed: boolean } {
  const open = openAnchor(findingId);
  const close = closeAnchor(findingId);
  const lines = text.split("\n");

  const start = lines.findIndex((l) => l.trim() === open);
  if (start === -1) return { text, changed: false };
  const end = lines.findIndex((l, i) => i >= start && l.trim() === close);
  if (end === -1) return { text, changed: false };

  lines.splice(start, end - start + 1);
  // Die von uns gesetzte Trenn-Leerzeile mit entfernen, damit ein Auflösen
  // die Notiz exakt in den Zustand vor dem Kasten zurückversetzt.
  if (lines[start] === "") lines.splice(start, 1);

  return { text: lines.join("\n"), changed: true };
}

/** Entfernt ALLE Lint-Kästen — für Exzerpte, damit kein Kasten in den nächsten wandert. */
export function stripAllCalloutBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!skipping && /^<!--\s*lokyy-lint:[^\s]+\s*-->$/.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^<!--\s*\/lokyy-lint:[^\s]+\s*-->$/.test(trimmed)) skipping = false;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Offset direkt hinter dem schließenden Frontmatter-Fence (inkl. Newline),
 * oder 0, wenn die Notiz kein führendes Frontmatter hat.
 */
function bodyStartOffset(text: string): number {
  if (!text.startsWith("---\n")) return 0;
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      // Zeichen bis einschließlich dieser Zeile + Newline.
      return lines.slice(0, i + 1).join("\n").length + 1;
    }
  }
  return 0;
}

/**
 * Setzt den Block an den Anfang des Bodys (direkt nach dem Frontmatter).
 * Ein bestehender Block desselben Findings wird vorher entfernt — dadurch ist
 * die Operation idempotent und aktualisiert gleichzeitig veralteten Inhalt.
 */
export function insertCalloutBlock(
  text: string,
  block: string,
  findingId: string,
): { text: string; changed: boolean } {
  const base = stripCalloutBlock(text, findingId).text;
  const at = bodyStartOffset(base);
  const next = base.slice(0, at) + block + "\n\n" + base.slice(at);
  return { text: next, changed: next !== text };
}

/**
 * Kurz-Exzerpt einer Notiz für die Anzeige als „Aussage". Überspringt
 * Frontmatter, Überschriften, bestehende Kästen und Blockquotes und nimmt die
 * erste echte Inhaltszeile (bei sehr kurzen Zeilen bis zu drei).
 */
export function excerptStatement(fileText: string, maxLen = 240): string {
  const { body } = parseFrontmatter(fileText);
  const clean = stripAllCalloutBlocks(body);

  const picked: string[] = [];
  for (const raw of clean.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith(">")) continue;
    if (line.startsWith("<!--")) continue;
    if (line === "---") continue;
    picked.push(line);
    if (picked.join(" ").length >= 160 || picked.length >= 3) break;
  }

  const joined = picked.join(" ");
  if (joined.length <= maxLen) return joined;
  return joined.slice(0, maxLen) + "…";
}

/**
 * Liest Titel + Aussage-Exzerpt für die angegebenen Notizen DIREKT von der
 * Platte (kein `getNote`, weil das pro Aufruf ein `git pull --rebase` auslöst
 * — bei einer Fund-Liste mit N Notizen wären das N Netzwerk-Roundtrips).
 * Für ein reines Lese-Exzerpt ist die lokale Arbeitskopie ausreichend; jeder
 * andere Lesepfad hält sie ohnehin frisch.
 */
export async function buildStatements(
  noteIds: string[],
): Promise<CalloutStatement[]> {
  const c = coreConfig();
  const out: CalloutStatement[] = [];
  for (const noteId of noteIds) {
    const abs = join(c.vaultDir, ...noteId.split("/")) + ".md";
    try {
      const text = await readFile(abs, "utf8");
      out.push({
        noteId,
        title: parseTitle(text, `${noteId}.md`),
        text: excerptStatement(text) || "(kein Textinhalt)",
      });
    } catch {
      out.push({ noteId, title: noteId, text: "(Notiz nicht gefunden)" });
    }
  }
  return out;
}

/** Notiz-IDs des Findings in stabiler Reihenfolge, ohne Duplikate. */
function targetNoteIds(finding: CalloutFinding): string[] {
  return [...new Set(finding.statements.map((s) => s.noteId))];
}

/**
 * Schreibt den Kasten in jede betroffene Notiz. Jede Notiz ist ein eigener
 * `saveNote` und damit ein eigener Commit — gitService committet dateiweise.
 */
export async function writeFindingCallout(
  finding: CalloutFinding,
): Promise<CalloutWriteResult> {
  const block = buildCalloutBlock(finding);
  const result: CalloutWriteResult = { written: [], unchanged: [], missing: [] };

  for (const noteId of targetNoteIds(finding)) {
    const note = await getNote(noteId);
    if (!note) {
      result.missing.push(noteId);
      continue;
    }
    const { text, changed } = insertCalloutBlock(note.body, block, finding.id);
    if (!changed) {
      result.unchanged.push(noteId);
      continue;
    }
    await saveNote(noteId, text);
    result.written.push(noteId);
  }

  return result;
}

/** Entfernt den Kasten dieses Findings aus allen genannten Notizen. */
export async function removeFindingCallout(
  findingId: string,
  noteIds: string[],
): Promise<CalloutRemoveResult> {
  const result: CalloutRemoveResult = {
    removed: [],
    unchanged: [],
    missing: [],
  };

  for (const noteId of [...new Set(noteIds)]) {
    const note = await getNote(noteId);
    if (!note) {
      result.missing.push(noteId);
      continue;
    }
    const { text, changed } = stripCalloutBlock(note.body, findingId);
    if (!changed) {
      result.unchanged.push(noteId);
      continue;
    }
    await saveNote(noteId, text);
    result.removed.push(noteId);
  }

  return result;
}
