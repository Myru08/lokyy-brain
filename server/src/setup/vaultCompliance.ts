import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  parseFrontmatter,
  validateFrontmatter,
  resolveVaultProfile,
  VAULT_SCHEMA_DIR,
  type AnyDocType,
  type VaultProfile,
  type ValidationErrorDetail,
} from "@lokyy/core";
import { config } from "../config.js";

/**
 * Story 1.20 AC#6 — Pre-Flight vor dem Aktivieren des SPEC-Pre-Commit-Hooks.
 *
 * Bevor ein bestehender Vault den Hook scharf schaltet, muss der User wissen,
 * wie viele seiner Alt-Notizen die SPEC verletzen. Betroffen sind ausschließlich
 * extern importierte/migrierte Inhalte — alles, was durch `notesService` läuft,
 * ist per Konstruktion SPEC-valide. Ein Community-Mitglied hat ~1400 Dateien
 * migriert; genau diese Population ist gemeint.
 *
 * **Dies ist ein Report, keine Reparatur.** Ein Frontmatter-Migrationstool ist
 * bewusst NICHT Teil dieser Story.
 *
 * ## Warum zwei Zahlen
 *
 * Der Scan validiert mit `validateFrontmatter` aus `@lokyy/core` — derselben
 * Validierung, die auch jeder Schreibpfad benutzt; die Shell-Logik des Hooks
 * wird NICHT in TypeScript nachgebaut. Die App validiert dabei aber echt
 * strenger als der Hook, und zwar nachweisbar (siehe `vaultCompliance.test.ts`,
 * das jede Datei gegen den ECHTEN Hook gegenprüft):
 *
 * | Prüfung                                   | Hook | `validateFrontmatter` |
 * |-------------------------------------------|------|-----------------------|
 * | `---`-Fence vorhanden                     | ja   | ja                    |
 * | Pflichtfelder id/type/title/created/updated | ja   | ja                    |
 * | `id` ist ULID                             | ja   | ja                    |
 * | `type` hat ein Schema im Vault            | ja   | ja (via Profil)       |
 * | `created`/`updated` sind ISO-`date-time`  | NEIN | ja                    |
 * | `title` ist ein nicht-leerer String       | NEIN | ja                    |
 * | YAML ist überhaupt parsebar               | NEIN | ja                    |
 *
 * Der Hook grept nur nach `^feld:` — ein `created: gestern` passiert ihn
 * anstandslos, `validateFrontmatter` nicht. Bei migrierten Obsidian-Vaults
 * (`created: 2024-05-01`, Datum ohne Zeit) ist das der Normalfall, nicht der
 * Sonderfall.
 *
 * Deshalb meldet der Report beides:
 *   - `blocking`  — würde der Hook ABLEHNEN. Das ist die Zahl, die die Frage
 *                   „was passiert, wenn ich den Hook einschalte?" beantwortet,
 *                   und deshalb die Zahl, die die UI vor die Bestätigung setzt.
 *   - `invalid`   — verletzt die SPEC laut App-Validierung (Obermenge von
 *                   `blocking`). Ehrlicher Gesamtbefund, aber KEIN Grund, das
 *                   Aktivieren zu verweigern.
 *
 * Eine einzige Zahl zu melden hieße, entweder den User grundlos zu erschrecken
 * (`invalid` als Blocker) oder ihm einen echten SPEC-Verstoß zu verschweigen.
 *
 * ## Wie viel Risiko wirklich dahinter steckt
 *
 * Der Hook prüft NUR gestagte Dateien (`git diff --cached --diff-filter=ACM`)
 * und schreibt nie etwas um. Ein aktivierter Hook sperrt also niemanden aus
 * seinem Vault aus — er blockiert erst den Commit, der eine kaputte Alt-Notiz
 * anfasst.
 */

const exec = promisify(execFile);

/** Eine Notiz, die die SPEC verletzt. */
export interface NonCompliantNote {
  /** Vault-relativer Pfad, POSIX-Separatoren. */
  path: string;
  /** Klartext-Befunde, in der Reihenfolge der Validierung. */
  reasons: string[];
  /** Ob der Pre-Commit-Hook diese Datei ebenfalls ablehnen würde. */
  blocksCommit: boolean;
}

export interface VaultComplianceReport {
  /** Geprüfte `.md`-Dateien (nach denselben Ausschlüssen wie der Hook). */
  scanned: number;
  /** Dateien, die `validateFrontmatter` ablehnt (Obermenge von `blocking`). */
  invalid: number;
  /** Dateien, die der Pre-Commit-Hook ablehnen würde. */
  blocking: number;
  /** Beispiele, gekappt auf `sampleLimit` — der Report ist kein Dateibaum. */
  samples: NonCompliantNote[];
  /** True, wenn `invalid > samples.length` (die UI zeigt dann „… und N weitere"). */
  truncated: boolean;
}

export interface ScanVaultComplianceOptions {
  vaultDir?: string;
  profile?: VaultProfile;
  /** Wie viele Beispiel-Dateien maximal zurückkommen. Default 25. */
  sampleLimit?: number;
}

/**
 * Dieselben Ausschlüsse, die der Hook per `grep -v` anwendet: `00_meta/`
 * (Schemas, Templates, SPEC), `docs/` und alles, was auf oberster Ebene mit
 * `README` beginnt. Die Anker `^` des Hooks entsprechen `startsWith` auf dem
 * vault-relativen Pfad.
 */
function isScannable(relPath: string): boolean {
  if (!relPath.endsWith(".md")) return false;
  if (relPath.startsWith("00_meta/")) return false;
  if (relPath.startsWith("docs/")) return false;
  if (relPath.startsWith("README")) return false;
  return true;
}

/**
 * Die Dateien, die der Hook je zu sehen bekäme: alles, was git kennt. Nicht
 * ignorierte, aber untracked Dateien zählen mit — sie werden beim nächsten
 * `git add` gestaged und laufen dann in den Hook.
 *
 * Fallback auf einen Filesystem-Walk, falls `git ls-files` scheitert (kein
 * Repo, kaputter Index) — dann lieber zu viel scannen als gar nichts melden.
 */
async function listCandidateFiles(vaultDir: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", vaultDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\0").filter((p) => p.length > 0 && isScannable(p));
  } catch {
    return (await walk(vaultDir, vaultDir)).filter(isScannable);
  }
}

async function walk(dir: string, root: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, acc);
    else if (entry.name.endsWith(".md")) {
      acc.push(relative(root, full).split(sep).join("/"));
    }
  }
  return acc;
}

/**
 * Die Typen, die DIESER Vault trägt — abgeleitet aus den tatsächlich
 * vorhandenen `00_meta/schemas/<type>.json`, exakt wie der Hook es tut. Ein
 * Vault kann Schemas mitbringen, die im aktiven Profil nicht vorkommen
 * (`wiki-article`, `raw-source` …); für den Hook sind die gültig, für
 * `validateFrontmatter` unter `para` nicht. Genau diese Differenz macht den
 * Unterschied zwischen `invalid` und `blocking` aus.
 */
async function schemaTypesOnDisk(vaultDir: string): Promise<Set<string>> {
  try {
    const files = await readdir(join(vaultDir, VAULT_SCHEMA_DIR));
    return new Set(
      files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)),
    );
  } catch {
    return new Set();
  }
}

/**
 * Bildet einen Validierungsfehler auf die Frage ab „sieht der Hook das auch?".
 *
 * Bewusst abgeleitet aus dem Ergebnis der App-Validierung, statt die Checks
 * des Hooks ein zweites Mal zu implementieren: die Wahrheit über gültig/ungültig
 * kommt aus `validateFrontmatter`, hier wird sie nur klassifiziert.
 */
function isHookVisible(err: ValidationErrorDetail, typeHasSchemaOnDisk: boolean): boolean {
  // 1. Fehlendes Pflichtfeld — der Hook grept nach genau diesen fünf.
  if (err.keyword === "required") {
    const missing = String(err.params.missingProperty ?? "");
    return ["id", "type", "title", "created", "updated"].includes(missing);
  }
  // 2. `id` ist kein ULID — identische Regex in Schema und Hook.
  if (err.instancePath === "/id" && err.keyword === "pattern") return true;
  // 3. Unbekannter `type` — der Hook fragt das Dateisystem, nicht das Profil.
  if (err.instancePath === "/type" || err.keyword === "enum") {
    return !typeHasSchemaOnDisk;
  }
  // Alles andere (date-time-Format, title-Typ/Länge, …) prüft der Hook nicht.
  return false;
}

/** Kurze, für Menschen lesbare Fassung eines Validierungsfehlers. */
function describe(err: ValidationErrorDetail): string {
  if (err.keyword === "required") {
    return `Pflichtfeld fehlt: ${String(err.params.missingProperty ?? "?")}`;
  }
  const where = err.instancePath || "/";
  return `${where}: ${err.message}`;
}

export async function scanVaultCompliance(
  opts: ScanVaultComplianceOptions = {},
): Promise<VaultComplianceReport> {
  const vaultDir = opts.vaultDir ?? config.vaultDir;
  const profile = opts.profile ?? resolveVaultProfile();
  const sampleLimit = opts.sampleLimit ?? 25;

  const [files, knownTypes] = await Promise.all([
    listCandidateFiles(vaultDir),
    schemaTypesOnDisk(vaultDir),
  ]);

  let invalid = 0;
  let blocking = 0;
  const samples: NonCompliantNote[] = [];

  for (const relPath of files) {
    let raw: string;
    try {
      raw = await readFile(join(vaultDir, relPath), "utf8");
    } catch {
      // Zwischen `ls-files` und dem Lesen verschwunden — der Hook sähe sie
      // ebenso wenig (`[ -f "$FILE" ] || continue`).
      continue;
    }

    const note = inspect(raw, knownTypes, profile);
    if (!note) continue;

    invalid++;
    if (note.blocksCommit) blocking++;
    if (samples.length < sampleLimit) samples.push({ path: relPath, ...note });
  }

  return {
    scanned: files.length,
    invalid,
    blocking,
    samples,
    truncated: invalid > samples.length,
  };
}

/** Prüft EINE Datei. `null` heißt SPEC-konform. */
function inspect(
  raw: string,
  knownTypes: Set<string>,
  profile: VaultProfile,
): Omit<NonCompliantNote, "path"> | null {
  let data: Record<string, unknown>;
  try {
    ({ data } = parseFrontmatter(raw));
  } catch (err) {
    // Kaputtes YAML. Der Hook parst kein YAML und würde es durchlassen —
    // ein echter SPEC-Verstoß, aber kein Commit-Blocker.
    return {
      reasons: [`Frontmatter nicht parsebar: ${err instanceof Error ? err.message : String(err)}`],
      blocksCommit: false,
    };
  }

  // Gar kein Frontmatter — der einzige Fall, den der Hook vor allen
  // Feld-Checks abfängt („file must start with ---").
  if (Object.keys(data).length === 0) {
    return { reasons: ["kein Frontmatter (Datei beginnt nicht mit ---)"], blocksCommit: true };
  }

  const type = data.type;
  const typeHasSchemaOnDisk = typeof type === "string" && knownTypes.has(type);

  const result = validateFrontmatter(
    data as Parameters<typeof validateFrontmatter>[0],
    type as AnyDocType,
    profile,
  );
  if (result.valid) return null;

  return {
    reasons: result.errors.map(describe),
    blocksCommit: result.errors.some((e) => isHookVisible(e, typeHasSchemaOnDisk)),
  };
}
