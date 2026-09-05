import { describe, expect, it } from "vitest";

import { extractPdfText } from "./pdfText.js";

/**
 * Issue #63 — PDF-Textextraktion.
 *
 * Die beiden Fälle, die zählen, sind nicht "funktioniert das Parsen", sondern:
 *   1. PDF MIT Textebene → Text kommt raus
 *   2. PDF OHNE Textebene (Scan) → LEER, aber KEIN Wurf. Das ist die Regel
 *      aus der Story: ein Scan ist ein Ergebnis, kein Absturz.
 *
 * Die Testdateien werden im Test gebaut statt als Binär-Fixture eingecheckt —
 * so ist am Testcode selbst ablesbar, was ein PDF "mit" und "ohne" Textebene
 * unterscheidet (`BT … Tj ET` im Content-Stream gegenüber reiner Grafik).
 */

/** Minimales, gültiges PDF mit einem Content-Stream und korrekter xref-Tabelle. */
function buildPdf(contentStream: string): Uint8Array {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${Buffer.byteLength(contentStream, "latin1")}>>\nstream\n${contentStream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** Text auf der Seite: `BT … Tj ET` ist die Textebene. */
const PDF_WITH_TEXT = buildPdf(
  "BT /F1 24 Tf 72 700 Td (Hallo Lokyy Brain) Tj ET",
);

/** Nur ein gefülltes Rechteck — die Seite hat Inhalt, aber keinen Text. */
const PDF_WITHOUT_TEXT = buildPdf("0 0 1 rg 72 600 200 100 re f");

describe("extractPdfText", () => {
  it("liest den Text aus einem PDF mit Textebene", async () => {
    const result = await extractPdfText(PDF_WITH_TEXT);
    expect(result.text).toContain("Hallo Lokyy Brain");
    expect(result.pages).toBe(1);
    expect(result.empty).toBe(false);
  });

  it("meldet ein PDF ohne Textebene als leer — und wirft NICHT", async () => {
    const result = await extractPdfText(PDF_WITHOUT_TEXT);
    expect(result.empty).toBe(true);
    expect(result.text).toBe("");
    expect(result.pages).toBe(1);
  });

  it("wirft bei einer Datei, die gar kein PDF ist", async () => {
    const notAPdf = new Uint8Array(Buffer.from("das ist nur Text", "utf8"));
    await expect(extractPdfText(notAPdf)).rejects.toThrow();
  });
});
