import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";

import {
  resolveInsideVault,
  sanitizeFileName,
  sanitizeRelativePath,
} from "./importPaths.js";

/**
 * Issue #63 — Pfad-Sicherheit des Datei-/Ordner-Imports.
 *
 * DER BEFUND, gegen den diese Datei schützt: `gitService.save` schreibt mit
 * `join(vaultDir, relPath)`. Ein `..` im client-gelieferten
 * `webkitRelativePath` landet damit AUSSERHALB des Vaults — im schlimmsten
 * Fall in `~/.ssh` oder `/etc`. Zwischen dem Client und dieser Zeile steht
 * nur `sanitizeRelativePath`.
 *
 * Deshalb prüft der erste Block nicht Formalien, sondern echte
 * Ausbruchsversuche, und zwar zweifach: der Pfad wird abgewiesen UND der
 * aufgelöste Pfad liegt nachweislich nicht ausserhalb des Vaults.
 */

const VAULT = "/srv/lokyy/vault";

describe("sanitizeRelativePath — Ausbruchsversuche", () => {
  const escapes = [
    "../../etc/passwd",
    "../secrets.md",
    "notizen/../../../root/.ssh/authorized_keys",
    "/etc/passwd",
    "/absolut/notiz.md",
    "C:\\Windows\\System32\\notiz.md",
    "..\\..\\windows\\notiz.md",
    "./notiz.md",
    "ordner/./unter/../notiz.md",
  ];

  for (const attempt of escapes) {
    it(`weist "${attempt}" ab`, () => {
      const check = sanitizeRelativePath(attempt);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toBeTruthy();
    });
  }

  it("kein abgewiesener Pfad kann den Vault verlassen (Gegenprobe)", () => {
    // Die Gegenprobe zeigt, WARUM abgewiesen wird: würde man den rohen Pfad
    // einfach durchreichen, läge das Ergebnis ausserhalb des Vaults.
    const raw = "../../etc/passwd";
    const naive = resolve(join(VAULT, "30_captures", raw));
    expect(naive.startsWith(VAULT)).toBe(false);

    // Mit Sanitisierung gibt es gar keinen Pfad, der geschrieben werden dürfte.
    expect(sanitizeRelativePath(raw).ok).toBe(false);
    // Und selbst wenn eine spätere Änderung die Sanitisierung umginge, fängt
    // die zweite Verteidigungslinie den Fall ab.
    expect(resolveInsideVault(VAULT, `30_captures/${raw}`)).toBeNull();
  });

  it("weist ein Nullbyte im Pfad ab", () => {
    const check = sanitizeRelativePath("notiz\u0000.md");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/Nullbyte/);
  });

  it("weist auch die NFKC-gefaltete Punkt-Variante ab", () => {
    // U+FF0E FULLWIDTH FULL STOP faltet unter NFKC auf einen echten Punkt.
    const check = sanitizeRelativePath("\uFF0E\uFF0E/notiz.md");
    expect(check.ok).toBe(false);
  });

  it("weist zu tiefe Ordnerbäume ab", () => {
    const deep = `${Array.from({ length: 20 }, (_, i) => `e${i}`).join("/")}/notiz.md`;
    const check = sanitizeRelativePath(deep);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/tiefer/);
  });
});

describe("sanitizeRelativePath — gültige Ordner-Importe", () => {
  it("erhält die Ordnerstruktur", () => {
    const check = sanitizeRelativePath("Mein Vault/Projekte/Notiz.md");
    expect(check).toEqual({
      ok: true,
      dir: "Mein Vault/Projekte",
      name: "Notiz.md",
    });
  });

  it("behandelt eine Datei ohne Unterordner als dir=\"\"", () => {
    const check = sanitizeRelativePath("Notiz.md");
    expect(check).toEqual({ ok: true, dir: "", name: "Notiz.md" });
  });

  it("erhält Umlaute und Leerzeichen im Namen", () => {
    const check = sanitizeRelativePath("Ordner mit Ümläuten/Über Bäume.md");
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.dir).toBe("Ordner mit Ümläuten");
      expect(check.name).toBe("Über Bäume.md");
    }
  });

  it("räumt Steuerzeichen und Doppel-Slashes weg statt abzuweisen", () => {
    const check = sanitizeRelativePath("Ordner//Notiz\u0007.md");
    expect(check).toEqual({ ok: true, dir: "Ordner", name: "Notiz.md" });
  });
});

describe("sanitizeFileName", () => {
  it("nimmt einen einfachen Dateinamen an", () => {
    expect(sanitizeFileName("Notiz.md")).toEqual({ ok: true, name: "Notiz.md" });
  });

  it("weist einen Namen mit Pfadanteil ab", () => {
    const check = sanitizeFileName("ordner/Notiz.md");
    expect(check.ok).toBe(false);
  });

  it("weist einen Ausbruchsversuch im Dateinamen ab", () => {
    expect(sanitizeFileName("../Notiz.md").ok).toBe(false);
  });
});

describe("resolveInsideVault", () => {
  it("gibt den absoluten Pfad zurück, wenn er im Vault liegt", () => {
    expect(resolveInsideVault(VAULT, "30_captures/notiz.md")).toBe(
      join(VAULT, "30_captures/notiz.md"),
    );
  });

  it("gibt null zurück, wenn der Pfad den Vault verlässt", () => {
    expect(resolveInsideVault(VAULT, "../anderer-ordner/notiz.md")).toBeNull();
    expect(resolveInsideVault(VAULT, "/etc/passwd")).toBeNull();
  });

  it("gibt null für den Vault-Wurzelpfad selbst zurück", () => {
    expect(resolveInsideVault(VAULT, "")).toBeNull();
  });

  it("lässt sich nicht von einem Präfix-Nachbarn täuschen", () => {
    // `/srv/lokyy/vault-backup` beginnt mit `/srv/lokyy/vault`, liegt aber
    // NICHT darin — ein reiner startsWith-Vergleich ohne Trenner fiele darauf herein.
    expect(resolveInsideVault(VAULT, "../vault-backup/notiz.md")).toBeNull();
  });
});
