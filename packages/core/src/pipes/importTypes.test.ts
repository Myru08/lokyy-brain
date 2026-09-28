import { describe, expect, it } from "vitest";

import {
  classifyImportFile,
  fileExtension,
  unsupportedReason,
} from "./importTypes.js";
import { detectType } from "./pipeQueue.js";

/**
 * Issue #63 — Typ-Erkennung des Datei-Imports.
 *
 * DER KERN: Browser liefern für `.md` je nach Betriebssystem
 * `application/octet-stream`, `text/markdown` oder gar nichts. Wer nur auf
 * MIME schaut, bei dem funktioniert Markdown-Import auf der einen Hälfte der
 * Rechner und auf der anderen nicht — und zwar ohne Fehlermeldung, weil die
 * Datei einfach als "nicht unterstützt" durchfällt. Deshalb entscheidet die
 * Endung zuerst, MIME nur als Rückfallebene.
 */

describe("fileExtension", () => {
  it("liest die Endung in Kleinbuchstaben", () => {
    expect(fileExtension("Notiz.MD")).toBe("md");
    expect(fileExtension("ordner/Datei.tar.gz")).toBe("gz");
  });

  it("liefert leer, wenn es keine Endung gibt", () => {
    expect(fileExtension("README")).toBe("");
    expect(fileExtension(".gitignore")).toBe("");
    expect(fileExtension("notiz.")).toBe("");
  });
});

describe("classifyImportFile — Endung schlägt MIME", () => {
  const markdownMimes = ["application/octet-stream", "", undefined, "text/markdown"];
  for (const mime of markdownMimes) {
    it(`erkennt .md auch bei MIME "${String(mime)}"`, () => {
      expect(classifyImportFile("Notiz.md", mime)).toBe("text");
    });
  }

  it("erkennt weitere Text-Endungen", () => {
    expect(classifyImportFile("a.markdown", "")).toBe("text");
    expect(classifyImportFile("a.txt", "")).toBe("text");
    expect(classifyImportFile("a.text", "")).toBe("text");
  });

  it("erkennt PDF an der Endung und am MIME", () => {
    expect(classifyImportFile("Bericht.pdf", "application/octet-stream")).toBe("pdf");
    expect(classifyImportFile("bericht", "application/pdf")).toBe("pdf");
  });

  it("erkennt Text am MIME, wenn keine bekannte Endung da ist", () => {
    expect(classifyImportFile("README", "text/plain")).toBe("text");
    expect(classifyImportFile("liesmich.xyz", "text/markdown")).toBe("text");
    // MIME mit Charset-Parameter darf nicht danebenliegen.
    expect(classifyImportFile("README", "text/plain; charset=utf-8")).toBe("text");
  });
});

describe("classifyImportFile — nicht unterstützt", () => {
  const unsupported: [string, string][] = [
    ["foto.png", "image/png"],
    ["foto.jpg", "image/jpeg"],
    ["archiv.zip", "application/zip"],
    ["tabelle.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["irgendwas", "application/octet-stream"],
  ];

  for (const [name, mime] of unsupported) {
    it(`weist ${name} zurück`, () => {
      expect(classifyImportFile(name, mime)).toBeNull();
    });
  }

  it("begründet die Abweisung mit dem, was der Nutzer sieht", () => {
    expect(unsupportedReason("foto.png", "image/png")).toMatch(/\.png/);
    // Ohne Endung nennt die Begründung den MIME-Typ.
    expect(unsupportedReason("irgendwas", "application/octet-stream")).toMatch(
      /application\/octet-stream/,
    );
  });
});

describe("detectType — Datei-Pipes in der Queue", () => {
  const file = (name: string, mime: string) => ({
    file: { name, mime, dataBase64: "" },
  });

  it("erkennt Markdown trotz octet-stream", () => {
    expect(detectType(file("Notiz.md", "application/octet-stream"))).toBe("text");
  });

  it("erkennt PDF", () => {
    expect(detectType(file("Bericht.pdf", "application/pdf"))).toBe("pdf");
  });

  it("lässt Audio weiterhin an die Voice-Pipe gehen", () => {
    expect(detectType(file("aufnahme.webm", "audio/webm"))).toBe("voice");
  });

  it("ändert die bestehende URL-Erkennung nicht", () => {
    expect(detectType({ url: "https://youtu.be/abc" })).toBe("youtube");
    expect(detectType({ url: "https://example.com" })).toBe("url");
    expect(detectType({ text: "kein Link" })).toBe("unknown");
  });

  it("bleibt bei nicht unterstützten Dateien auf 'unknown'", () => {
    expect(detectType(file("foto.png", "image/png"))).toBe("unknown");
  });
});
