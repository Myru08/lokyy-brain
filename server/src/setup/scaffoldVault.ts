import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildVaultScaffold,
  installExecutableScript,
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
  /**
   * Story 1.20 — nur planen, nichts schreiben. Liefert `created`/`skipped`
   * exakt wie ein echter Lauf, fasst aber weder Filesystem noch git an (auch
   * `core.hooksPath` nicht). Siehe `planVaultScaffold`.
   */
  dryRun?: boolean;
  /**
   * Story 1.20 — ob `git config core.hooksPath` gesetzt wird.
   *
   * Default `true`: der Fresh-Install-Pfad (`routes/setup.ts`) ruft ohne
   * Optionen auf und bleibt damit unverändert — dort IST das Aktivieren
   * richtig, weil der Vault leer ist und gar keine Alt-Notizen existieren,
   * die der Hook blockieren könnte.
   *
   * Der Retrofit auf einen bestehenden Vault übergibt `false` und aktiviert
   * den Hook erst in einem zweiten, separat bestätigten Aufruf (AC#5) —
   * nachdem der User gesehen hat, wie viele Alt-Notizen die SPEC verletzen.
   */
  activateHook?: boolean;
}

/** Was ein Scaffold-Lauf anlegen würde, ohne etwas anzufassen. */
export interface VaultScaffoldPlan {
  /** Fehlende, vault-relative Pfade, die angelegt würden. */
  created: string[];
  /** Bereits vorhandene Pfade, die unangetastet blieben. */
  skipped: string[];
}

export interface ScaffoldVaultResult extends VaultScaffoldPlan {
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
  /** Story 1.20 — ob `core.hooksPath` in diesem Lauf gesetzt wurde. */
  hookActivated: boolean;
  /** Story 1.20 — true, wenn nur geplant und nichts geschrieben wurde. */
  dryRun: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Story 1.20 — die reine "was fehlt?"-Hälfte des Scaffolds.
 *
 * Bewusst als eigene Funktion und nicht als `if (dryRun) return` mitten im
 * Schreibpfad: so ist die Dry-Run-Garantie strukturell statt eine Bedingung,
 * der man vertrauen muss. Diese Funktion kann per Konstruktion nichts kaputt
 * machen — sie ruft ausschließlich `stat` auf.
 */
export async function planVaultScaffold(
  vaultDir: string = config.vaultDir,
  profile: VaultProfile = resolveVaultProfile(),
): Promise<VaultScaffoldPlan> {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of await buildVaultScaffold(profile)) {
    if (await exists(join(vaultDir, file.path))) skipped.push(file.path);
    else created.push(file.path);
  }

  return { created, skipped };
}

export async function scaffoldVault(
  opts: ScaffoldVaultOptions = {},
): Promise<ScaffoldVaultResult> {
  const vaultDir = opts.vaultDir ?? config.vaultDir;
  const profile = opts.profile ?? resolveVaultProfile();
  const message = opts.message ?? "chore: scaffold base vault structure";
  const activateHook = opts.activateHook ?? true;

  const plan = await planVaultScaffold(vaultDir, profile);

  // Dry-Run endet HIER — ab dieser Zeile schreibt die Funktion. Alles davor
  // war ausschließlich `stat`.
  if (opts.dryRun) {
    return {
      ...plan,
      committed: false,
      pushed: false,
      pushError: null,
      hookActivated: false,
      dryRun: true,
    };
  }

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

  const { created, skipped } = plan;
  const toCreate = new Set(created);

  for (const file of await buildVaultScaffold(profile)) {
    if (!toCreate.has(file.path)) continue;
    const abs = join(vaultDir, file.path);
    if (file.executable) {
      // Der einzige Installationspfad für Shell-Skripte im Vault: LF-normalisiert
      // (ein CRLF-Shebang macht den Hook im Container unausführbar und damit den
      // ganzen Vault schreibunfähig) und ausführbar (git überspringt einen Hook
      // ohne x-Bit stillschweigend).
      await installExecutableScript(abs, file.content);
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
  }

  // Git führt Hooks ausschließlich aus `core.hooksPath` (bzw. `.git/hooks`) aus
  // — die committete Hook-Datei allein tut gar nichts. Idempotent, deshalb bei
  // jedem Lauf gesetzt (repariert auch einen mitgebrachten Klon).
  //
  // Story 1.20: nur noch wenn `activateHook` (Default true) gesetzt ist. Beim
  // Retrofit auf einen bestehenden Vault ist das Aktivieren eine eigene,
  // bestätigte Entscheidung — Alt-Notizen ohne SPEC-Frontmatter würden sonst
  // ab sofort ihren eigenen nächsten Commit blockieren.
  if (activateHook) {
    await git(["config", "core.hooksPath", VAULT_HOOKS_DIR]);
  }

  const base = { created, skipped, hookActivated: activateHook, dryRun: false };

  if (created.length === 0) {
    return { ...base, committed: false, pushed: false, pushError: null };
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
    return { ...base, committed: false, pushed: false, pushError: null };
  }

  await git(["commit", "-m", message]);

  const remote = await git(["remote", "get-url", "origin"]).then(
    () => true,
    () => false,
  );
  if (!remote) {
    return { ...base, committed: true, pushed: false, pushError: null };
  }

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  try {
    await git(["push", "origin", branch]);
    return { ...base, committed: true, pushed: true, pushError: null };
  } catch (err) {
    return {
      ...base,
      committed: true,
      pushed: false,
      pushError: err instanceof Error ? err.message : String(err),
    };
  }
}
