import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PipeResult, SharePayload } from "@lokyy/shared";
import {
  coreConfig,
  DOC_TYPES,
  extractPdfText,
  findByUlid,
  generateUlid,
  getDefaultImportFolder,
  isUlid,
  parseFrontmatter,
  sanitizeFileName,
  serializeFrontmatter,
  type DocType,
  type FrontmatterMap,
} from "@lokyy/core";

/**
 * Datei-Import-Pipes (Issue #63) — Text/Markdown und PDF.
 *
 * Aufbau bewusst parallel zu `scrape.ts`: Quelle holen, zu Markdown formen,
 * `PipeResult` zurück. Die Queue committet das Ergebnis über `gitService`.
 *
 * Unterschied zu allen bisherigen Pipes: die Quelle ist keine URL, sondern
 * die Datei selbst — sie steckt base64-kodiert in `payload.file`. Der
 * Zielordner steht komplett in `payload.targetFolder`; die Route hat dort
 * beim Ordner-Import den (sanierten) Unterordner schon angehängt, damit die
 * Struktur erhalten bleibt und dieser Handler nur ein Feld lesen muss.
 *
 * Doc-Type: **`capture`** — genau wie bei den URL-, YouTube- und
 * Voice-Pipes. Eine importierte Datei ist erstmal eingefangenes Material,
 * keine gepflegte Notiz; die Typ-Liste ist geschlossen und `capture` ist der
 * Eintrag, der genau dafür da ist. Bringt eine `.md` allerdings selbst einen
 * gültigen Typ mit, gewinnt der (siehe `resolveDocType`).
 */

/** Zeitpunkt des Imports, einmal pro Job. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Per-Job-Override gewinnt vor dem globalen `default_import_folder`.
 * Die Route hat `payload.targetFolder` bereits saniert.
 */
async function resolveFolder(payload: SharePayload): Promise<string> {
  const override = payload.targetFolder?.trim();
  if (override) return override.replace(/^\/+|\/+$/g, "");
  return getDefaultImportFolder();
}

/** Die Datei-Bytes aus dem Payload holen. */
function fileBytes(payload: SharePayload): Uint8Array {
  const file = payload.file;
  if (!file) throw new Error("Datei-Import ohne Datei im Payload.");
  return new Uint8Array(Buffer.from(file.dataBase64, "base64"));
}

/** Dateiname ohne Endung — Grundlage für Titel und Dateinamen im Vault. */
function baseName(name: string): string {
  const withoutDir = name.split("/").pop() ?? name;
  const dot = withoutDir.lastIndexOf(".");
  return dot > 0 ? withoutDir.slice(0, dot) : withoutDir;
}

/**
 * Freien Pfad im Zielordner finden.
 *
 * Ein zweiter Import derselben Datei überschreibt die vorhandene Notiz
 * NICHT — er legt `name-2.md` daneben. Überschreiben wäre stiller
 * Datenverlust: die vorhandene Notiz kann längst bearbeitet worden sein.
 */
function freePath(folder: string, fileBase: string): string {
  const vaultDir = coreConfig().vaultDir;
  const candidate = (suffix: string): string =>
    `${folder}/${fileBase}${suffix}.md`;

  if (!existsSync(join(vaultDir, candidate(""))))
    return candidate("");
  for (let i = 2; i < 1000; i += 1) {
    if (!existsSync(join(vaultDir, candidate(`-${i}`)))) return candidate(`-${i}`);
  }
  // Praktisch unerreichbar; lieber ein eindeutiger Name als eine Endlosschleife.
  return candidate(`-${Date.now()}`);
}

/**
 * Dateinamen für den Vault ableiten. Der Originalname bleibt erhalten (nur
 * um unzulässige Zeichen bereinigt) statt in einen Slug übersetzt zu werden:
 * wer einen bestehenden Obsidian-Ordner importiert, behält damit seine
 * Wikilinks, die auf genau diese Dateinamen zeigen.
 */
function vaultFileBase(payload: SharePayload): string {
  const original = baseName(payload.file?.name ?? "import");
  const checked = sanitizeFileName(original);
  return checked.ok ? checked.name : "import";
}

/** Erste `# Überschrift` aus dem Markdown-Body. */
function firstHeading(body: string): string | null {
  const m = body.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1]!.trim() : null;
}

/**
 * Einen mitgebrachten Zeitstempel auf ISO-8601 bringen — oder `null`, wenn
 * er unbrauchbar ist.
 *
 * Wichtig: YAML kennt einen eigenen Timestamp-Typ, `gray-matter` liefert
 * `created: 2020-01-01T00:00:00.000Z` deshalb als **Date-Objekt**, nicht als
 * String. Wer hier nur auf `typeof === "string"` prüft, wirft genau die
 * korrekt gepflegten `created`-Daten weg und ersetzt sie durch "jetzt" —
 * und das Schema (`type: string, format: date-time`) lehnt das Date-Objekt
 * hinterher ausserdem ab.
 */
function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed) && /\d{4}-\d{2}-\d{2}/.test(value))
      return new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Doc-Type der importierten Datei bestimmen. Ein mitgebrachter Typ wird
 * respektiert, solange er auf der geschlossenen Liste steht — sonst
 * `capture`. Ein unbekannter Typ würde sonst den Pre-Commit-Hook auslösen,
 * der prüft, ob `00_meta/schemas/<type>.json` existiert.
 */
function resolveDocType(existing: unknown): DocType {
  if (
    typeof existing === "string" &&
    (DOC_TYPES as readonly string[]).includes(existing)
  )
    return existing as DocType;
  return "capture";
}

/**
 * ULID der importierten Notiz bestimmen.
 *
 * Eine mitgebrachte ULID wird **nicht blind übernommen**: liegt sie im Vault
 * bereits auf einer anderen Notiz, gäbe es zwei Notizen mit derselben ID —
 * `findByUlid` / das MCP-Tool `resolve_by_id` liefern dann je nach
 * Verzeichnis-Reihenfolge mal die eine, mal die andere. In dem Fall bekommt
 * die importierte Notiz eine frische ULID, und die alte bleibt als
 * `original_id` erhalten, damit die Herkunft nachvollziehbar bleibt.
 */
async function resolveUlid(
  existing: unknown,
): Promise<{ id: string; originalId?: string }> {
  if (typeof existing !== "string" || !isUlid(existing)) {
    return { id: generateUlid() };
  }
  const clash = await findByUlid(existing);
  if (!clash) return { id: existing };
  return { id: generateUlid(), originalId: existing };
}

/**
 * Text/Markdown-Import.
 *
 * Bringt die Datei bereits Frontmatter mit, wird es respektiert — ergänzt
 * wird nur, was fehlt oder was nachweislich falsch wäre (unbekannter Typ,
 * kaputtes `created`, kollidierende ULID). `updated` setzen wir immer auf
 * jetzt: dieser Import IST der Schreibzeitpunkt, und der Vault-Contract
 * verlangt genau das.
 */
export async function textImportHandler(
  payload: SharePayload,
): Promise<PipeResult> {
  const file = payload.file;
  if (!file) throw new Error("Text-Import ohne Datei im Payload.");

  const raw = Buffer.from(file.dataBase64, "base64").toString("utf8");
  const parsed = parseFrontmatter(raw);
  const incoming = parsed.data ?? {};
  const body = parsed.body;

  const now = nowIso();
  const { id, originalId } = await resolveUlid(incoming.id);
  const title =
    (typeof incoming.title === "string" && incoming.title.trim()) ||
    firstHeading(body) ||
    baseName(file.name);

  const data: FrontmatterMap = {
    ...incoming,
    id,
    type: resolveDocType(incoming.type),
    title,
    created: normalizeTimestamp(incoming.created) ?? now,
    updated: now,
    source_type: "file-import",
    source_file: payload.relativePath || file.name,
    imported_at: now,
  };
  if (originalId) data.original_id = originalId;
  if (!Array.isArray(incoming.tags)) data.tags = ["inbox", "import"];

  const folder = await resolveFolder(payload);
  return {
    path: freePath(folder, vaultFileBase(payload)),
    body: serializeFrontmatter(data, body.trim() ? body : `# ${title}\n`),
  };
}

/**
 * PDF-Import: Text extrahieren, als Notiz ablegen.
 *
 * Ein PDF **ohne Textebene** (eingescannt) ist ein Ergebnis, kein Absturz:
 * die Notiz entsteht, sagt im Body warum sie leer ist, und der Job trägt
 * denselben Hinweis (`PipeResult.notice`), damit der Nutzer es in der
 * Job-Liste sieht statt vor einer wortlos leeren Datei zu stehen. OCR ist
 * ausdrücklich nicht Teil dieses Imports.
 */
export async function pdfImportHandler(
  payload: SharePayload,
): Promise<PipeResult> {
  const file = payload.file;
  if (!file) throw new Error("PDF-Import ohne Datei im Payload.");

  const extraction = await extractPdfText(fileBytes(payload));

  const now = nowIso();
  const title = baseName(file.name);
  const sourceFile = payload.relativePath || file.name;

  const data: FrontmatterMap = {
    id: generateUlid(),
    type: "capture",
    title,
    source: "pdf",
    source_type: "file-import",
    source_file: sourceFile,
    pdf_pages: extraction.pages,
    pdf_has_text_layer: !extraction.empty,
    captured_at: now,
    created: now,
    updated: now,
    imported_at: now,
    tags: ["inbox", "pdf"],
  };

  const notice = extraction.empty
    ? `PDF ohne Textebene (vermutlich ein Scan) — es wurde kein Text gefunden. OCR ist nicht Teil des Imports.`
    : undefined;

  const bodyLines = [`# ${title}`, "", `**Quelle:** ${sourceFile}`, ""];
  if (extraction.empty) {
    bodyLines.push(
      "> [!warning] Kein Text extrahierbar",
      `> Dieses PDF (${extraction.pages} Seite${extraction.pages === 1 ? "" : "n"}) hat keine Textebene — vermutlich ein Scan.`,
      "> Der Import liest nur vorhandenen Text; eine Texterkennung (OCR) findet nicht statt.",
      "",
    );
  } else {
    bodyLines.push(extraction.text, "");
  }

  const folder = await resolveFolder(payload);
  return {
    path: freePath(folder, vaultFileBase(payload)),
    body: serializeFrontmatter(data, bodyLines.join("\n")),
    ...(notice ? { notice } : {}),
  };
}
