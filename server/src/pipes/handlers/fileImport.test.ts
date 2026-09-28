import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnyDocType, ResolvedNote } from "@lokyy/core";
import type { SharePayload } from "@lokyy/shared";

/**
 * Issue #63 — die beiden Datei-Import-Handler.
 *
 * Der Prüfgegenstand ist der Vault-Contract: was hier rauskommt, geht ohne
 * weitere Bearbeitung durch `gitService.save` in den Vault, und der
 * Pre-Commit-Hook blockt jeden Commit, dessen Frontmatter unvollständig ist.
 * Deshalb validiert fast jeder Test das erzeugte Frontmatter mit demselben
 * `validateFrontmatter`, das auch die Anwendung benutzt — statt einzelne
 * Felder abzuhaken.
 *
 * `findByUlid` ist injizierbar gemockt: die ULID-Kollision (eine importierte
 * `.md` bringt eine ID mit, die im Vault schon liegt) ist sonst nicht
 * herstellbar, ohne einen ganzen Vault zu seeden.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

let vaultDir: string;
/** Was `findByUlid` melden soll — `null` heisst "ULID ist im Vault frei". */
let ulidClash: ResolvedNote | null = null;

vi.mock("@lokyy/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    coreConfig: () => ({
      vaultDir,
      gitRemote: "",
      gitBranch: "main",
      gitAuthorName: "test",
      gitAuthorEmail: "test@localhost",
    }),
    getDefaultImportFolder: async () => "30_captures",
    findByUlid: async () => ulidClash,
  };
});

type HandlersMod = typeof import("./fileImport.js");
let handlers: HandlersMod;
let validateFrontmatter: typeof import("@lokyy/core").validateFrontmatter;
let parseFrontmatter: typeof import("@lokyy/core").parseFrontmatter;

beforeAll(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "lokyy-import-"));
  handlers = await import("./fileImport.js");
  const core = await import("@lokyy/core");
  validateFrontmatter = core.validateFrontmatter;
  parseFrontmatter = core.parseFrontmatter;
});

afterEach(() => {
  ulidClash = null;
});

/** Payload bauen, wie die Route ihn erzeugt (Bytes base64, Ordner fertig). */
function payloadFor(
  name: string,
  content: string | Uint8Array,
  opts: { mime?: string; targetFolder?: string; relativePath?: string } = {},
): SharePayload {
  const bytes =
    typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return {
    file: {
      name,
      mime: opts.mime ?? "text/markdown",
      dataBase64: bytes.toString("base64"),
    },
    targetFolder: opts.targetFolder ?? "30_captures",
    ...(opts.relativePath ? { relativePath: opts.relativePath } : {}),
  };
}

/** Frontmatter der erzeugten Notiz gegen das echte Schema prüfen. */
function expectContractValid(body: string): Record<string, unknown> {
  const { data } = parseFrontmatter(body);
  for (const field of ["id", "type", "title", "created", "updated"]) {
    expect(data[field], `Pflichtfeld ${field} fehlt`).toBeTruthy();
  }
  const result = validateFrontmatter(data, data.type as AnyDocType);
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
  return data as Record<string, unknown>;
}

/** Minimales PDF (siehe packages/core/src/pipes/pdfText.test.ts für die Herleitung). */
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

describe("textImportHandler — Markdown mit Frontmatter", () => {
  const existing = [
    "---",
    "id: 01HZZZZZZZZZZZZZZZZZZZZZZZ",
    "type: note",
    "title: Mitgebrachter Titel",
    "created: 2020-01-01T00:00:00.000Z",
    "tags: [alt, wichtig]",
    "eigenes_feld: bleibt",
    "---",
    "",
    "# Überschrift",
    "",
    "Inhalt.",
  ].join("\n");

  it("respektiert vorhandene Felder und ergänzt nur, was fehlt", async () => {
    const result = await handlers.textImportHandler(payloadFor("alt.md", existing));
    const data = expectContractValid(result.body);

    expect(data.title).toBe("Mitgebrachter Titel");
    expect(data.type).toBe("note");
    expect(data.created).toBe("2020-01-01T00:00:00.000Z");
    expect(data.tags).toEqual(["alt", "wichtig"]);
    expect(data.eigenes_feld).toBe("bleibt");
    // `updated` ist der Schreibzeitpunkt, nicht das, was in der Datei stand.
    expect(Date.parse(String(data.updated))).toBeGreaterThan(Date.parse("2024-01-01"));
    expect(result.body).toContain("Inhalt.");
  });

  it("behält eine mitgebrachte ULID, solange sie im Vault frei ist", async () => {
    ulidClash = null;
    const result = await handlers.textImportHandler(payloadFor("alt.md", existing));
    const data = expectContractValid(result.body);
    expect(data.id).toBe("01HZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(data.original_id).toBeUndefined();
  });

  it("vergibt eine neue ULID, wenn die mitgebrachte im Vault schon liegt", async () => {
    ulidClash = {
      id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      path: "20_notes/andere",
      title: "Andere Notiz",
      body: "",
      frontmatter: {},
    };

    const result = await handlers.textImportHandler(payloadFor("alt.md", existing));
    const data = expectContractValid(result.body);

    expect(data.id).not.toBe("01HZZZZZZZZZZZZZZZZZZZZZZZ");
    // Die Herkunft geht nicht verloren.
    expect(data.original_id).toBe("01HZZZZZZZZZZZZZZZZZZZZZZZ");
  });

  it("ersetzt einen Typ, der nicht auf der geschlossenen Liste steht", async () => {
    const fremd = ["---", "type: obsidian-kanban", "title: X", "---", "", "Text"].join("\n");
    const result = await handlers.textImportHandler(payloadFor("x.md", fremd));
    const data = expectContractValid(result.body);
    expect(data.type).toBe("capture");
  });

  it("ersetzt ein kaputtes created", async () => {
    const kaputt = ["---", "title: X", "created: irgendwann", "---", "", "Text"].join("\n");
    const result = await handlers.textImportHandler(payloadFor("x.md", kaputt));
    const data = expectContractValid(result.body);
    expect(Number.isNaN(Date.parse(String(data.created)))).toBe(false);
  });
});

describe("textImportHandler — ohne Frontmatter", () => {
  it("erzeugt vollständiges, contract-gültiges Frontmatter", async () => {
    const result = await handlers.textImportHandler(
      payloadFor("notiz.md", "# Meine Überschrift\n\nText."),
    );
    const data = expectContractValid(result.body);

    expect(data.type).toBe("capture");
    expect(data.title).toBe("Meine Überschrift");
    expect(data.tags).toEqual(["inbox", "import"]);
    expect(data.source_type).toBe("file-import");
    expect(result.body).toContain("Text.");
  });

  it("nimmt den Dateinamen als Titel, wenn es keine Überschrift gibt", async () => {
    const result = await handlers.textImportHandler(
      payloadFor("Einkaufsliste.txt", "Milch\nBrot", { mime: "text/plain" }),
    );
    const data = expectContractValid(result.body);
    expect(data.title).toBe("Einkaufsliste");
    expect(result.path.endsWith("Einkaufsliste.md")).toBe(true);
  });
});

describe("textImportHandler — Zielpfad", () => {
  it("schreibt in den Ordner, den die Route zusammengesetzt hat", async () => {
    const result = await handlers.textImportHandler(
      payloadFor("notiz.md", "# n", {
        targetFolder: "20_notes/Vault/Projekte",
        relativePath: "Vault/Projekte/notiz.md",
      }),
    );
    expect(result.path).toBe("20_notes/Vault/Projekte/notiz.md");
  });

  it("überschreibt eine bestehende Notiz nicht, sondern legt sie daneben", async () => {
    await mkdir(join(vaultDir, "30_captures"), { recursive: true });
    await writeFile(join(vaultDir, "30_captures", "kollision.md"), "vorhanden");

    const result = await handlers.textImportHandler(
      payloadFor("kollision.md", "# neu"),
    );
    expect(result.path).toBe("30_captures/kollision-2.md");
  });
});

describe("pdfImportHandler", () => {
  it("legt den extrahierten Text als Notiz ab", async () => {
    const pdf = buildPdf("BT /F1 24 Tf 72 700 Td (Quartalsbericht Q3) Tj ET");
    const result = await handlers.pdfImportHandler(
      payloadFor("bericht.pdf", pdf, { mime: "application/pdf" }),
    );
    const data = expectContractValid(result.body);

    expect(data.type).toBe("capture");
    expect(data.source).toBe("pdf");
    expect(data.pdf_has_text_layer).toBe(true);
    expect(result.body).toContain("Quartalsbericht Q3");
    expect(result.notice).toBeUndefined();
    expect(result.path).toBe("30_captures/bericht.md");
  });

  it("ein PDF ohne Textebene ist ein Ergebnis, kein Absturz", async () => {
    const scan = buildPdf("0 0 1 rg 72 600 200 100 re f");
    const result = await handlers.pdfImportHandler(
      payloadFor("scan.pdf", scan, { mime: "application/pdf" }),
    );
    const data = expectContractValid(result.body);

    // Die Notiz entsteht …
    expect(result.path).toBe("30_captures/scan.md");
    expect(data.pdf_has_text_layer).toBe(false);
    // … sie sagt im Body, warum sie leer ist …
    expect(result.body).toMatch(/keine Textebene/);
    expect(result.body).toMatch(/OCR/);
    // … und der Job trägt denselben Hinweis für die Job-Liste.
    expect(result.notice).toMatch(/ohne Textebene/);
  });

  it("wirft bei einer Datei, die gar kein PDF ist", async () => {
    await expect(
      handlers.pdfImportHandler(
        payloadFor("kaputt.pdf", "das ist kein PDF", { mime: "application/pdf" }),
      ),
    ).rejects.toThrow();
  });
});
