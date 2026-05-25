import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { coreConfig, initCore, type CoreConfig } from "../util/coreConfig.js";

const exec = promisify(execFile);

/**
 * Git-Service. Kapselt die einzige echte Working-Copy des Vaults.
 *
 * Grundsatz: Forgejo ist die Wahrheit. Vor dem Lesen wird gepullt, beim
 * Speichern wird committet und sofort wieder mit dem Remote abgeglichen.
 * Operationen sind serialisiert (siehe `lock`), damit nie zwei git-Befehle
 * gleichzeitig auf dasselbe Repo losgehen.
 *
 * Configuration is shared with other core services via `coreConfig()`.
 * Callers initialize once via `initCore(config)` (or the back-compat
 * `initGitService` alias) at process startup.
 */

/** Back-compat alias for callers that still reference `GitConfig`. */
export type GitConfig = CoreConfig;

/** Back-compat alias for callers that still call `initGitService(config)`. */
export const initGitService = initCore;

const config = coreConfig;

let lock: Promise<unknown> = Promise.resolve();
/** Stellt git-Operationen hintereinander, gibt das Ergebnis von `fn` zurück. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  // Lock nie auf einen rejecteten State setzen
  lock = run.catch(() => {});
  return run;
}

/** Roher git-Aufruf im Vault-Verzeichnis. */
async function git(args: string[]): Promise<string> {
  const c = config();
  const { stdout } = await exec("git", args, {
    cwd: c.vaultDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: c.gitAuthorName,
      GIT_AUTHOR_EMAIL: c.gitAuthorEmail,
      GIT_COMMITTER_NAME: c.gitAuthorName,
      GIT_COMMITTER_EMAIL: c.gitAuthorEmail,
    },
  });
  return stdout.trim();
}

/**
 * Klont das Remote beim ersten Start, falls der Vault-Ordner leer/nicht
 * vorhanden ist. Idempotent — danach ein No-op.
 */
export async function ensureRepo(): Promise<void> {
  return serialize(async () => {
    const c = config();
    const hasGit = existsSync(join(c.vaultDir, ".git"));
    if (hasGit) return;

    await mkdir(c.vaultDir, { recursive: true });
    const entries = existsSync(c.vaultDir) ? await readdir(c.vaultDir) : [];
    if (entries.length > 0) {
      throw new Error(
        `VAULT_DIR (${c.vaultDir}) ist nicht leer und kein git-Repo.`,
      );
    }
    // in den (leeren) Zielordner klonen
    await exec("git", [
      "clone",
      "--branch",
      c.gitBranch,
      c.gitRemote,
      c.vaultDir,
    ]);
  });
}

/**
 * `git pull --rebase --autostash`. Aufrufen bevor Notizen gelesen werden
 * (Notiz öffnen, Tab wieder aktiv).
 */
export async function pull(): Promise<void> {
  return serialize(async () => {
    await git(["pull", "--rebase", "--autostash", "origin", config().gitBranch]);
  });
}

/**
 * Schreibt eine Datei und bringt sie nach Forgejo:
 *   write → add → commit → pull --rebase → push
 *
 * `relPath` ist relativ zum Vault-Root. Gibt den neuen Commit-Hash zurück.
 * Wirft bei echten Merge-Konflikten (gleiche Zeilen geändert) — der Caller
 * kann das an die PWA melden.
 */
export async function save(
  relPath: string,
  content: string,
  message: string,
): Promise<string> {
  return serialize(async () => {
    const c = config();
    const abs = join(c.vaultDir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");

    await git(["add", "--", relPath]);

    // nichts zu committen? (Inhalt identisch) -> still zurueck
    const status = await git(["status", "--porcelain", "--", relPath]);
    if (status === "") {
      return git(["rev-parse", "HEAD"]);
    }

    await git(["commit", "-m", message]);

    try {
      await git([
        "pull",
        "--rebase",
        "--autostash",
        "origin",
        c.gitBranch,
      ]);
    } catch (err) {
      // Rebase fehlgeschlagen -> abbrechen, sauberen State hinterlassen
      await git(["rebase", "--abort"]).catch(() => {});
      throw new Error(
        `Merge-Konflikt beim Speichern von ${relPath}. ` +
          `Datei wurde remote an denselben Zeilen geaendert.`,
      );
    }

    await git(["push", "origin", c.gitBranch]);
    return git(["rev-parse", "HEAD"]);
  });
}

/**
 * Wie `save`, aber für binäre Inhalte (Bilder, PDFs, …). Schreibt die
 * `Buffer`-/`Uint8Array`-Bytes direkt (kein utf8-encode) und benutzt
 * denselben git-Flow: write → add → commit → pull --rebase → push.
 *
 * Teilt das Promise-Lock mit allen anderen git-Operationen — kein Risiko
 * paralleler Schreibvorgänge auf das Working-Copy.
 *
 * Wichtig: assets bekommen keine Frontmatter (binär), der lokyy-vault
 * pre-commit Hook prüft Frontmatter nur für `.md`.
 */
export async function saveBinary(
  relPath: string,
  content: Uint8Array,
  message: string,
): Promise<string> {
  return serialize(async () => {
    const c = config();
    const abs = join(c.vaultDir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);

    await git(["add", "--", relPath]);

    const status = await git(["status", "--porcelain", "--", relPath]);
    if (status === "") {
      return git(["rev-parse", "HEAD"]);
    }

    await git(["commit", "-m", message]);

    try {
      await git([
        "pull",
        "--rebase",
        "--autostash",
        "origin",
        c.gitBranch,
      ]);
    } catch (err) {
      await git(["rebase", "--abort"]).catch(() => {});
      throw new Error(
        `Merge-Konflikt beim Speichern von ${relPath}. ` +
          `Datei wurde remote geaendert.`,
      );
    }

    await git(["push", "origin", c.gitBranch]);
    return git(["rev-parse", "HEAD"]);
  });
}

/** Löscht eine Datei und pusht das ebenfalls nach Forgejo. */
export async function remove(relPath: string, message: string): Promise<void> {
  return serialize(async () => {
    const c = config();
    await git(["rm", "-r", "--", relPath]);
    await git(["commit", "-m", message]);
    await git(["pull", "--rebase", "--autostash", "origin", c.gitBranch]);
    await git(["push", "origin", c.gitBranch]);
  });
}

/**
 * Verschiebt/benennt um — `git mv` funktioniert für Dateien *und* Ordner,
 * Rename ist nur ein Move im selben Verzeichnis. Legt das Zielverzeichnis
 * an, falls nötig, und gleicht danach mit Forgejo ab.
 */
export async function move(
  fromRel: string,
  toRel: string,
  message: string,
): Promise<void> {
  return serialize(async () => {
    const c = config();
    await mkdir(dirname(join(c.vaultDir, toRel)), { recursive: true });
    await git(["mv", "--", fromRel, toRel]);
    await git(["commit", "-m", message]);
    try {
      await git([
        "pull",
        "--rebase",
        "--autostash",
        "origin",
        c.gitBranch,
      ]);
    } catch {
      await git(["rebase", "--abort"]).catch(() => {});
      throw new Error(`Konflikt beim Verschieben von ${fromRel}.`);
    }
    await git(["push", "origin", c.gitBranch]);
  });
}

/** ISO-Timestamp des letzten Commits, der `relPath` berührt hat. */
export async function lastModified(relPath: string): Promise<string> {
  try {
    const ts = await git(["log", "-1", "--format=%cI", "--", relPath]);
    return ts || new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}
