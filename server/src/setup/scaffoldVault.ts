import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildVaultScaffold,
  resolveVaultProfile,
  VAULT_HOOKS_DIR,
  type VaultProfile,
} from "@lokyy/core";
import { config } from "../config.js";

/**
 * Story 1.19 — Basis-Vault-Scaffold beim Fresh Install.
 *
 * Bis hierher bekam ein frisch installierter Vault genau eine `.gitkeep`
 * (aus `provisionVaultDir`) plus vier Seed-Skills — keinerlei Ordnerstruktur.
 * Diese Funktion schreibt das vollständige Grundgerüst in den frisch
 * provisionierten Vault: kanonische Ordner (je mit `.gitkeep`, sonst überlebt
 * ein leeres Verzeichnis den Commit nicht), die 19 aktuellen JSON-Schemas,
 * `00_meta/SPEC.md`, die Note-Templates und den SPEC-Pre-Commit-Hook.
 *
 * Wo das hier hängt und warum:
 *   - NICHT in `provisionVaultDir` (`@lokyy/core`): die Funktion teilt sich
 *     Story 1.13 mit dem Tenant-Pfad (`POST /api/tenants`), der bewusst ein
 *     ANDERES, kundenseitiges Ordner-Modell scaffoldet. Primary-Vault-Belange
 *     dort hineinzuziehen würde beide Pfade verkoppeln.
 *   - Sondern auf derselben Ebene wie `seedSkills()`, direkt nach dem
 *     Provisioning in `routes/setup.ts` — und VOR `seedSkills()`, damit Hook
 *     und Schemas stehen, bevor die erste Notiz committet wird.
 *
 * Schreibmuster wie im Tenant-Scaffold (`routes/tenants.ts`): Dateien per fs
 * schreiben, dann EIN Folge-Commit — nicht ein Commit pro Datei wie in
 * `seedSkills`, was hier ~60 Commits erzeugen würde. Die rohen git-Aufrufe
 * laufen (wie dort) außerhalb des `serialize()`-Locks von gitService; im
 * Setup-Fenster schreibt nichts anderes in dieses Verzeichnis.
 *
 * Invariante: idempotentes create-if-absent. Ein zweiter Lauf fasst nichts an,
 * eine vom User editierte SPEC/Template-Datei überlebt jedes Re-Init.
 */

const exec = promisify(execFile);

export interface ScaffoldVaultOptions {
  /** Vault-Root. Default: `config.vaultDir`. */
  vaultDir?: string;
  /** SPEC-Profil. Default: `resolveVaultProfile()` (env-gesteuert, `para`). */
  profile?: VaultProfile;
  /** Commit-Message für den Folge-Commit. */
  message?: string;
}

export interface ScaffoldVaultResult {
  /** Neu angelegte, vault-relative Pfade. */
  created: string[];
  /** Bereits vorhandene Pfade, die unangetastet blieben. */
  skipped: string[];
  /** Ob ein Commit entstanden ist (false, wenn nichts zu tun war). */
  committed: boolean;
  /** Ob der Commit zu `origin` gepusht wurde. */
  pushed: boolean;
  /**
   * Push-Fehler, falls der lokale Commit stand, der Push aber scheiterte.
   * Wird bewusst NICHT geworfen: das Scaffold liegt dann bereits korrekt im
   * Working-Copy, und ein späterer `sync` holt den Push nach.
   */
  pushError: string | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function scaffoldVault(
  opts: ScaffoldVaultOptions = {},
): Promise<ScaffoldVaultResult> {
  const vaultDir = opts.vaultDir ?? config.vaultDir;
  const profile = opts.profile ?? resolveVaultProfile();
  const message = opts.message ?? "chore: scaffold base vault structure";

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: config.gitAuthorName,
    GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
    GIT_COMMITTER_NAME: config.gitAuthorName,
    GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
    // Stabiles englisches stderr — dieselbe Begründung wie in gitService.
    LC_ALL: "C",
    LANG: "C",
  };
  const git = (args: string[]) => exec("git", ["-C", vaultDir, ...args], { env: gitEnv });

  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of await buildVaultScaffold(profile)) {
    const abs = join(vaultDir, file.path);
    if (await exists(abs)) {
      skipped.push(file.path);
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
    if (file.executable) await chmod(abs, 0o755);
    created.push(file.path);
  }

  // Git führt Hooks ausschließlich aus `core.hooksPath` (bzw. `.git/hooks`) aus
  // — die committete Hook-Datei allein tut gar nichts. Idempotent, deshalb bei
  // jedem Lauf gesetzt (repariert auch einen mitgebrachten Klon).
  await git(["config", "core.hooksPath", VAULT_HOOKS_DIR]);

  if (created.length === 0) {
    return { created, skipped, committed: false, pushed: false, pushError: null };
  }

  // Nur die eigenen Pfade stagen — ein pauschales `add -A` würde bei einem
  // Re-Init fremde Änderungen im Working-Copy mit einsammeln.
  await git(["add", "--", ...created]);

  // `diff --cached --quiet` endet mit 1, wenn etwas gestaged ist.
  const hasStaged = await git(["diff", "--cached", "--quiet"]).then(
    () => false,
    () => true,
  );
  if (!hasStaged) {
    return { created, skipped, committed: false, pushed: false, pushError: null };
  }

  await git(["commit", "-m", message]);

  const remote = await git(["remote", "get-url", "origin"]).then(
    () => true,
    () => false,
  );
  if (!remote) {
    return { created, skipped, committed: true, pushed: false, pushError: null };
  }

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  try {
    await git(["push", "origin", branch]);
    return { created, skipped, committed: true, pushed: true, pushError: null };
  } catch (err) {
    return {
      created,
      skipped,
      committed: true,
      pushed: false,
      pushError: err instanceof Error ? err.message : String(err),
    };
  }
}
