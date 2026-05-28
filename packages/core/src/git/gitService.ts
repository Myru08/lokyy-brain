import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
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
 *
 * Skips silently when `coreConfig().gitRemote` is the empty string — that
 * indicates the user hasn't run the setup wizard yet (or has detached the
 * vault). The wizard wires up the remote via `setupVaultFromForgejo` and
 * persists it on the `vaults` row; subsequent restarts will call this with
 * a non-empty remote and clone normally.
 */
export async function ensureRepo(): Promise<void> {
  return serialize(async () => {
    const c = config();
    if (!c.gitRemote) {
      console.log(
        "[gitService] ensureRepo: GIT_REMOTE not set — skipping clone " +
          "(setup wizard not run yet or vault detached).",
      );
      return;
    }
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
 * Bootstrap the vault working-copy from a Forgejo OAuth flow result.
 *
 * Called by the setup-wizard after the user has authorized lokyy-brain
 * against their Forgejo instance and picked (or created) a repo. We embed
 * the OAuth access token into the remote URL using the `oauth2:` username
 * convention — Forgejo treats this exactly like a personal access token
 * for HTTPS auth, but lets us swap the token without rewriting the URL.
 *
 * Behavior:
 *   1. Build URL: https://oauth2:<token>@<host>/<owner>/<repo>.git
 *   2. Wipe `vaultDir` (fresh setup — safe; the wizard runs before any
 *      writes), recreate empty.
 *   3. `git clone --branch <branch> <url> <vaultDir>`.
 *   4. If clone fails because the branch doesn't exist (brand-new empty
 *      repo, no commits yet): `git init` locally, add the remote, create
 *      the branch, drop a `.gitkeep`, commit, push `-u`.
 *
 * Returns the configured remote URL + branch so the caller can persist
 * them on the `vaults` row.
 *
 * Note on URL secrets: the access token lives in plain-text inside
 * `.git/config` (origin URL). This is the same trade-off the manual
 * "paste your PAT" path already had; encrypting Git's own config is out
 * of scope. Rotation = call this function again with a fresh token.
 */
export async function setupVaultFromForgejo(opts: {
  vaultId: string;
  forgejoBaseUrl: string;
  accessToken: string;
  repoFullName: string;
  branch: string;
}): Promise<{ gitRemote: string; gitBranch: string }> {
  const { forgejoBaseUrl, accessToken, repoFullName, branch } = opts;
  const hostNoScheme = stripScheme(forgejoBaseUrl);
  const remoteUrl = `https://oauth2:${accessToken}@${hostNoScheme}/${repoFullName}.git`;

  return serialize(async () => {
    const c = config();

    // Fresh-setup: wipe + recreate the vault directory. The wizard runs
    // before any writes; there is nothing valuable to preserve.
    await rm(c.vaultDir, { recursive: true, force: true });
    await mkdir(c.vaultDir, { recursive: true });

    // Attempt 1: clone the existing branch.
    try {
      await exec("git", ["clone", "--branch", branch, remoteUrl, c.vaultDir]);
      return { gitRemote: remoteUrl, gitBranch: branch };
    } catch (err) {
      // Forgejo returns "Remote branch <x> not found in upstream origin" for
      // an empty repo. Fall through to the init-and-push path. Any other
      // failure (network, auth) re-throws.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/remote branch .* not found|empty repository/i.test(msg)) {
        throw new Error(`git clone failed: ${msg}`);
      }
    }

    // Attempt 2: empty-repo bootstrap.
    await exec("git", ["init", c.vaultDir]);
    await exec("git", ["-C", c.vaultDir, "remote", "add", "origin", remoteUrl]);
    await exec("git", ["-C", c.vaultDir, "checkout", "-b", branch]);

    await writeFile(join(c.vaultDir, ".gitkeep"), "", "utf8");

    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: c.gitAuthorName,
      GIT_AUTHOR_EMAIL: c.gitAuthorEmail,
      GIT_COMMITTER_NAME: c.gitAuthorName,
      GIT_COMMITTER_EMAIL: c.gitAuthorEmail,
    };
    await exec("git", ["-C", c.vaultDir, "add", "--", ".gitkeep"], { env });
    await exec(
      "git",
      ["-C", c.vaultDir, "commit", "-m", "chore: initialize lokyy vault"],
      { env },
    );
    await exec("git", ["-C", c.vaultDir, "push", "-u", "origin", branch], {
      env,
    });

    return { gitRemote: remoteUrl, gitBranch: branch };
  });
}

/** `https://forgejo.example.com` → `forgejo.example.com`. */
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Returns true if the working copy has an `origin` remote configured.
 *
 * We probe the actual git state (`git remote get-url origin`) instead of
 * trusting `coreConfig().gitRemote`, because `setupVaultFromForgejo` writes
 * the remote straight into `.git/config` — it does not necessarily round-trip
 * through the in-memory config slice. `git remote get-url` exits non-zero
 * (throws) when no `origin` exists; an empty stdout is treated the same way.
 *
 * No remote = the documented pre-setup state (server up, setup wizard hasn't
 * wired a Forgejo repo yet). In that state pull/push have no target.
 */
async function hasRemote(): Promise<boolean> {
  try {
    const url = await git(["remote", "get-url", "origin"]);
    return url !== "";
  } catch {
    return false;
  }
}

/**
 * `git pull --rebase --autostash`. Aufrufen bevor Notizen gelesen werden
 * (Notiz öffnen, Tab wieder aktiv).
 */
export async function pull(): Promise<void> {
  return serialize(async () => {
    if (!(await hasRemote())) return; // no remote = nothing to pull from
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

    // Kein Remote (Setup-Wizard noch nicht gelaufen) -> nur lokaler Commit.
    if (!(await hasRemote())) {
      return git(["rev-parse", "HEAD"]);
    }

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

    // Kein Remote (Setup-Wizard noch nicht gelaufen) -> nur lokaler Commit.
    if (!(await hasRemote())) {
      return git(["rev-parse", "HEAD"]);
    }

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
