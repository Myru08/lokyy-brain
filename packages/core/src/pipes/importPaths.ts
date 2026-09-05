import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Pfad-Sicherheit für den Datei-/Ordner-Import (Issue #63).
 *
 * Beim Ordner-Import schickt der Browser zu jeder Datei ihren
 * `webkitRelativePath` mit — also einen Pfad, der **vom Client kommt**. Er
 * landet unter dem gewählten Zielordner im Vault und geht anschließend
 * ungeprüft durch `join(vaultDir, relPath)` in `gitService.save`. Ein `..`
 * darin schreibt außerhalb des Vaults. Deshalb ist dieses Modul die einzige
 * Stelle, die entscheidet, welcher Client-Pfad überhaupt zu einem Vault-Pfad
 * werden darf.
 *
 * Haltung: **ablehnen statt heimlich reparieren.** Ein `..` oder ein
 * absoluter Pfad kann aus einem echten Ordner-Dialog nie kommen — er ist
 * entweder ein Angriff oder ein kaputter Client. Beides gehört benannt in die
 * `rejected`-Liste, nicht stillschweigend zurechtgebogen. Nur harmlose
 * Zeichen-Probleme (Steuerzeichen, Doppel-Slashes, überlange Namen) werden
 * repariert.
 */

/** Ergebnis einer Pfad-Prüfung. `dir` ist "" bei einer Datei ohne Unterordner. */
export type RelativePathCheck =
  | { ok: true; dir: string; name: string }
  | { ok: false; reason: string };

/** Maximale Ordnertiefe eines Client-Pfads. Darüber ist es kein Ordner-Import mehr. */
const MAX_DEPTH = 16;

/** Maximale Länge eines einzelnen Pfad-Segments (ext4/APFS liegen bei 255 Bytes). */
const MAX_SEGMENT_LEN = 100;

/**
 * Zeichen, die in einem Vault-Pfad nichts verloren haben: Pfad-Trenner,
 * Windows-reservierte Zeichen und ASCII-Steuerzeichen.
 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f<>:"|?*\\/]/g;

/**
 * Ein Segment säubern: Steuerzeichen und Pfad-Trenner raus, Länge kappen,
 * abschließende Punkte/Leerzeichen weg (Windows kann sie nicht speichern).
 * Ergibt `null`, wenn nichts Verwertbares übrig bleibt.
 */
function sanitizeSegment(raw: string): string | null {
  const cleaned = raw
    .replace(UNSAFE_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, MAX_SEGMENT_LEN)
    .trim();
  if (!cleaned) return null;
  if (cleaned === "." || cleaned === "..") return null;
  return cleaned;
}

/**
 * NFKC-Normalisierung für die **Prüfung** (nicht für den gespeicherten Namen).
 *
 * Grund: Unicode kennt Zeichen, die wie ein Punkt aussehen und von NFKC auf
 * einen echten Punkt gefaltet werden (z.B. U+FF0E FULLWIDTH FULL STOP). Auf
 * dem Dateisystem entkommt `．．` zwar nichts, aber wir prüfen die gefaltete
 * Form, damit gar nicht erst diskutiert werden muss, welche Schicht das
 * später vielleicht doch normalisiert.
 */
function foldForCheck(s: string): string {
  return s.normalize("NFKC");
}

/**
 * Einen Client-Pfad (`webkitRelativePath`) in einen sicheren Vault-Teilpfad
 * übersetzen.
 *
 * Abgelehnt wird (mit Grund, für die `rejected`-Liste):
 *   - Nullbytes
 *   - absolute Pfade (`/etc/passwd`) und UNC-Pfade
 *   - Windows-Laufwerksbuchstaben (`C:\...`)
 *   - Backslashes — im `webkitRelativePath` trennt IMMER `/`; ein Backslash
 *     ist entweder ein Angriffsversuch oder ein Client, dem man nicht traut
 *   - jedes `.`- oder `..`-Segment, auch in NFKC-gefalteter Schreibweise
 *   - mehr als `MAX_DEPTH` Ordnerebenen
 *
 * Zurück kommt der Unterordner (`dir`, ohne führenden/abschließenden Slash)
 * und der bereinigte Dateiname (`name`, inkl. Endung).
 */
export function sanitizeRelativePath(raw: string): RelativePathCheck {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "Leerer Pfad" };
  if (input.includes("\u0000"))
    return { ok: false, reason: "Pfad enthält ein Nullbyte" };

  const folded = foldForCheck(input);
  if (folded.includes("\\"))
    return { ok: false, reason: "Backslash im Pfad ist nicht erlaubt" };
  if (folded.startsWith("/") || isAbsolute(folded))
    return { ok: false, reason: "Absoluter Pfad ist nicht erlaubt" };
  if (/^[A-Za-z]:/.test(folded))
    return { ok: false, reason: "Laufwerksbuchstabe im Pfad ist nicht erlaubt" };

  const rawSegments = folded.split("/").filter((s) => s.length > 0);
  if (rawSegments.length === 0)
    return { ok: false, reason: "Pfad enthält kein verwertbares Segment" };
  if (rawSegments.some((s) => s === "." || s === ".."))
    return { ok: false, reason: "Pfad enthält '..' oder '.'" };
  if (rawSegments.length - 1 > MAX_DEPTH)
    return { ok: false, reason: `Ordner tiefer als ${MAX_DEPTH} Ebenen` };

  const cleaned: string[] = [];
  for (const seg of rawSegments) {
    const safe = sanitizeSegment(seg);
    if (!safe)
      return {
        ok: false,
        reason: `Pfad-Segment "${seg.slice(0, 40)}" enthält nur unzulässige Zeichen`,
      };
    cleaned.push(safe);
  }

  const name = cleaned.pop()!;
  return { ok: true, dir: cleaned.join("/"), name };
}

/**
 * Denselben Filter auf einen einzelnen Dateinamen anwenden (Mehrfach-Upload
 * ohne Ordner: da gibt es keinen `relativePath`, nur `file.name`).
 */
export function sanitizeFileName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const check = sanitizeRelativePath(raw);
  if (!check.ok) return check;
  if (check.dir)
    return { ok: false, reason: "Dateiname darf keinen Pfad enthalten" };
  return { ok: true, name: check.name };
}

/**
 * Letzte Verteidigungslinie: einen vault-relativen Pfad auflösen und
 * bestätigen, dass er wirklich INNERHALB des Vaults liegt.
 *
 * Die Sanitisierung oben verhindert den Ausbruch bereits — diese Funktion
 * prüft das Ergebnis unabhängig davon noch einmal am aufgelösten absoluten
 * Pfad. Kommt `null` zurück, darf nichts geschrieben werden.
 *
 * Ein absoluter Pfad wird abgelehnt statt umgedeutet: `join()` würde
 * `/etc/passwd` klaglos zu `<vault>/etc/passwd` machen. Das entkommt zwar
 * nicht, schreibt aber woandershin, als der Aufrufer gemeint hat — und eine
 * Sicherheitsprüfung, die Eingaben still uminterpretiert, ist keine.
 */
export function resolveInsideVault(
  vaultDir: string,
  relPath: string,
): string | null {
  if (relPath.includes("\u0000")) return null;
  if (relPath.startsWith("/") || isAbsolute(relPath)) return null;
  const root = resolve(vaultDir);
  const abs = resolve(join(root, relPath));
  if (abs === root) return null;
  if (!abs.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return abs;
}
