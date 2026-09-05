import type { PipeType } from "@lokyy/shared";

/**
 * Typ-Erkennung für den Datei-/Ordner-Import (Issue #63).
 *
 * **Warum nicht MIME allein:** Browser liefern für `.md` regelmäßig
 * `application/octet-stream` oder einen leeren String — je nach
 * Betriebssystem und dessen Registry. Wer sich auf MIME verlässt, bei dem
 * wird Markdown auf der Hälfte der Rechner nicht erkannt. Deshalb entscheidet
 * hier die **Dateiendung zuerst** und MIME nur als Rückfallebene für Dateien
 * ohne (bekannte) Endung.
 *
 * Umfang laut Story: Text, Markdown, PDF. Bilder und sonstige Binärdateien
 * bekommen bewusst KEINEN Typ — sie passen nicht in den Markdown-Contract und
 * werden von der Route benannt abgewiesen.
 */

/** Pipe-Typen, die aus einer hochgeladenen Datei entstehen können. */
export type ImportFileKind = Extract<PipeType, "text" | "pdf">;

/** Endungen, die als Text/Markdown gelten. */
const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "mdown",
  "mkd",
  "txt",
  "text",
]);

/** MIME-Typen, die als Text/Markdown gelten (Rückfallebene ohne Endung). */
const TEXT_MIMES = new Set([
  "text/markdown",
  "text/x-markdown",
  "text/plain",
]);

const PDF_MIMES = new Set(["application/pdf", "application/x-pdf"]);

/** Endung in Kleinbuchstaben, ohne Punkt. Leerer String, wenn es keine gibt. */
export function fileExtension(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Datei einem Pipe-Typ zuordnen — oder `null`, wenn sie nicht unterstützt
 * wird. `null` ist kein Fehler, sondern die Grundlage für einen benannten
 * Eintrag in der `rejected`-Liste.
 *
 * Reihenfolge:
 *   1. bekannte Endung (verlässlichstes Signal, siehe Modul-Kommentar)
 *   2. MIME (für Dateien ohne oder mit unbekannter Endung)
 */
export function classifyImportFile(
  name: string,
  mime: string | undefined,
): ImportFileKind | null {
  const ext = fileExtension(name);
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(ext)) return "text";

  const normalizedMime = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (PDF_MIMES.has(normalizedMime)) return "pdf";
  if (TEXT_MIMES.has(normalizedMime)) return "text";

  return null;
}

/**
 * Klartext-Grund für eine abgewiesene Datei. Bewusst konkret: der Nutzer soll
 * sehen, WAS abgelehnt wurde, nicht nur DASS etwas abgelehnt wurde.
 */
export function unsupportedReason(name: string, mime: string | undefined): string {
  const ext = fileExtension(name);
  const what = ext ? `.${ext}` : (mime?.trim() || "unbekannter Typ");
  return `${what} wird nicht unterstützt — Import kann Text, Markdown und PDF`;
}
