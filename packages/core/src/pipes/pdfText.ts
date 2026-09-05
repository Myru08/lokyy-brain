/**
 * PDF-Textextraktion für den Datei-Import (Issue #63).
 *
 * **Bibliothek: `unpdf`.** Ausgewählt gegen `pdf-parse` und `pdfjs-dist`:
 *   - reines JavaScript, KEIN nativer Build — der Server läuft im
 *     Docker-Container, alles mit `node-gyp` wäre ein Deploy-Risiko
 *   - Bündelt eine serverless-taugliche pdf.js-Variante; die Extraktion holt
 *     **keine** Ressourcen aus dem Netz (kein CDN-Worker, keine Font-Fetches)
 *   - ESM, aktiv gepflegt (unjs), keine zusätzlichen Abhängigkeiten
 *   - `pdf-parse` fällt raus: CJS, seit Jahren ungepflegt, und liest im
 *     Debug-Zweig beim Import eine Testdatei von Disk
 *   - `pdfjs-dist` direkt fällt raus: mehr Verdrahtung (Worker, Polyfills)
 *     für exakt dasselbe Ergebnis — `unpdf` ist genau diese Verdrahtung
 *
 * Der Import von `unpdf` passiert **lazy** in der Funktion, damit die
 * pdf.js-Bündelung nicht bei jedem Server-Start geladen wird, sondern erst
 * beim ersten PDF.
 */

export interface PdfExtraction {
  /** Zusammengeführter Text aller Seiten, normalisiert. */
  text: string;
  /** Seitenzahl laut PDF. */
  pages: number;
  /**
   * `true`, wenn das PDF keine Textebene hat (typischer Scan). Kein Fehler:
   * die Notiz entsteht trotzdem, aber der Job trägt einen Hinweis.
   */
  empty: boolean;
}

/** Whitespace-Salat aus der Extraktion auf lesbare Absätze eindampfen. */
function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Text aus einem PDF ziehen.
 *
 * Wirft nur, wenn das PDF selbst nicht lesbar ist (kaputte Datei, kein PDF,
 * verschlüsselt). Ein PDF **ohne Textebene** ist ausdrücklich kein Fehler,
 * sondern liefert `empty: true` — OCR ist nicht Teil dieses Imports.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtraction> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // `unpdf` erwartet einen eigenständigen ArrayBuffer-Puffer; ein Node-Buffer
  // ist ein View auf einen geteilten Pool und wird sonst falsch gelesen.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);

  const doc = await getDocumentProxy(copy);
  const { totalPages, text } = await extractText(doc, { mergePages: true });
  const merged = normalize(Array.isArray(text) ? text.join("\n\n") : text);

  return {
    text: merged,
    pages: totalPages,
    empty: merged.length === 0,
  };
}
