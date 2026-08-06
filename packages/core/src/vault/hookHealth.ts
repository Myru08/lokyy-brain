/**
 * Der Vault-Pre-Commit-Hook als Datei: Normalisierung beim Installieren und
 * Self-Heal beim Serverstart.
 *
 * ## Der Blocker, den dieses Modul beseitigt
 *
 * `packages/core/src/vault/hooks/pre-commit` ist ein endungsloses POSIX-Skript.
 * Git for Windows checkt per Default mit `core.autocrlf=true` aus und macht
 * daraus CRLF. Diese Bytes wandern per Docker-Build ins Image und vom Scaffold
 * in den Vault. Im Linux-Container liest der Kernel die Shebang-Zeile dann als
 * `/bin/sh\r`, findet diesen Interpreter nicht und JEDER Commit stirbt mit
 *
 *     fatal: cannot exec '.githooks/pre-commit': No such file or directory
 *
 * Der Vault ist damit vollständig schreibunfähig — jeder Save wirkt kaputt.
 * Verschärfend: die Meldung enthält „pre-commit", was der Fehler-Klassifizierer
 * bis dahin als „ungültige Frontmatter" gemeldet hat (siehe `HookExecutionError`
 * in `errors/GitError.ts`), also exakt die falsche Fährte.
 *
 * ## Drei Verteidigungslinien
 *
 * 1. `.gitattributes` (`eol=lf`) — verhindert die CRLF-Quelle überhaupt.
 * 2. {@link installExecutableScript} — normalisiert beim Schreiben in den Vault,
 *    unabhängig davon, wie der Quellbaum ausgecheckt wurde.
 * 3. {@link healVaultHook} — repariert Bestandsinstallationen beim Start, die
 *    den kaputten Hook längst im Vault (und im Vault-Repo) liegen haben.
 *
 * Ohne (3) hilft (1)+(2) genau den Leuten nicht, die heute blockiert sind.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { coreConfig } from "../util/coreConfig.js";
import { saveVaultFile } from "../git/gitService.js";

const exec = promisify(execFile);

/** Directory git is pointed at via `core.hooksPath` in a scaffolded vault. */
export const VAULT_HOOKS_DIR = ".githooks";

/** Vault-relative install path of the SPEC-enforcing pre-commit hook. */
export const VAULT_HOOK_PATH = `${VAULT_HOOKS_DIR}/pre-commit`;

/** Mode a git hook must carry — git skips a hook it cannot execute. */
export const HOOK_FILE_MODE = 0o755;

/** Commit message of a self-heal that had to be versioned. */
export const HOOK_HEAL_COMMIT_MESSAGE = "chore: pre-commit-Hook repariert (Zeilenenden)";

/**
 * CRLF (und einzelne CR) → LF.
 *
 * Bewusst auf Zeilenenden beschränkt: der Hook-Inhalt selbst wird NICHT
 * angefasst (Nicht-Ziel der Story). Idempotent — ein LF-Skript kommt
 * byte-identisch zurück, was die „nur schreiben wenn nötig"-Prüfung in
 * {@link healVaultHook} überhaupt erst zuverlässig macht.
 */
export function normalizeShellScript(src: string): string {
  return src.replace(/\r\n?/g, "\n");
}

/**
 * Schreibt ein Shell-Skript so in den Vault, dass es dort auch laufen kann:
 * LF-normalisiert und ausführbar. Der einzige Installationspfad für den Hook —
 * Scaffold (Fresh Install) und Self-Heal benutzen beide diesen.
 */
export async function installExecutableScript(
  absPath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, normalizeShellScript(content), "utf8");
  await chmod(absPath, HOOK_FILE_MODE);
}

/** Ergebnis eines Self-Heal-Laufs. Rein informativ — geworfen wird nie. */
export interface HealVaultHookResult {
  /**
   * `absent` — der Vault hat (noch) keinen Hook, es gibt nichts zu tun.
   * `ok`     — Hook war bereits LF + ausführbar.
   * `healed` — mindestens eine der beiden Eigenschaften wurde korrigiert.
   */
  status: "absent" | "ok" | "healed";
  /** Zeilenenden mussten korrigiert werden. */
  lineEndingsFixed: boolean;
  /** Das Executable-Bit fehlte und wurde gesetzt. */
  modeFixed: boolean;
  /** Ob der Hook im Vault-Repo versioniert ist. */
  tracked: boolean;
  /** Ob die Reparatur als Commit im Vault gelandet ist. */
  committed: boolean;
  /** Fehlertext, falls die Reparatur (teilweise) scheiterte. */
  error: string | null;
}

const NOTHING: Omit<HealVaultHookResult, "status"> = {
  lineEndingsFixed: false,
  modeFixed: false,
  tracked: false,
  committed: false,
  error: null,
};

/** Ist `VAULT_HOOK_PATH` in diesem Working-Copy versioniert? */
async function isTracked(vaultDir: string): Promise<boolean> {
  try {
    await exec("git", ["-C", vaultDir, "ls-files", "--error-unmatch", "--", VAULT_HOOK_PATH], {
      env: { ...process.env, LC_ALL: "C" },
    });
    return true;
  } catch {
    // Nicht versioniert, kein Repo, kaputter Index — in allen drei Fällen gibt
    // es nichts zu committen.
    return false;
  }
}

async function headSha(vaultDir: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", vaultDir, "rev-parse", "HEAD"], {
      env: { ...process.env, LC_ALL: "C" },
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

export interface HealVaultHookOptions {
  /** Working copy to repair. Default: `coreConfig().vaultDir`. */
  vaultDir?: string;
  /**
   * Ob eine Reparatur an einem VERSIONIERTEN Hook committet wird (Default
   * `true`). Siehe die Begründung unten — `false` existiert für Aufrufer, die
   * bewusst nur den Working-Copy anfassen wollen.
   */
  commit?: boolean;
}

/**
 * Repariert den Pre-Commit-Hook eines Vaults. Idempotent, wirft nie.
 *
 * Ablauf: Datei lesen → normalisieren + `chmod` NUR wenn nötig → bei einem
 * versionierten Hook die Reparatur über `gitService` committen.
 *
 * ## Warum committet wird (und nicht nur der Working-Copy repariert wird)
 *
 * Der Scaffold legt `.githooks/pre-commit` an und committet ihn (siehe
 * `server/src/setup/scaffoldVault.ts`: der Pfad steht in `created` und läuft
 * durch `git add`/`git commit`). Der Hook ist also **versioniert** — eine
 * CRLF-Fassung liegt damit nicht nur auf der Platte, sondern im Repo und auf
 * Forgejo. Eine reine Working-Copy-Reparatur würde:
 *   - den Vault dauerhaft „dirty" lassen (jeder `pull --rebase --autostash`
 *     stasht und restauriert die Änderung wieder und wieder),
 *   - jeden weiteren Klon / jeden Container-Neustart mit frischem Volume erneut
 *     mit dem kaputten Hook versorgen — der Blocker käme zurück.
 * Der Commit repariert das Problem an der Quelle, einmal für alle Kopien.
 *
 * Reihenfolge ist dabei nicht verhandelbar: erst die Datei auf der Platte
 * heilen, DANN committen. Der Commit läuft durch genau den Hook, den er
 * repariert — mit CRLF käme er selbst nicht durch.
 *
 * Ist der Hook NICHT versioniert (Bestandsvault, der ihn nur lokal liegen hat,
 * oder gar kein git-Repo), bleibt es bei der reinen Dateikorrektur.
 *
 * Der Commit geht durch `saveVaultFile`, nicht durch rohes `git`: der
 * Architektur-Vertrag verlangt, dass jeder Vault-Write über `gitService` läuft
 * (Serialisierung per FIFO-Lock, Pull/Push, typisierte Fehler).
 */
export async function healVaultHook(
  opts: HealVaultHookOptions = {},
): Promise<HealVaultHookResult> {
  const vaultDir = opts.vaultDir ?? coreConfig().vaultDir;
  const shouldCommit = opts.commit ?? true;
  const abs = join(vaultDir, VAULT_HOOK_PATH);

  let raw: string;
  let mode: number;
  try {
    const st = await stat(abs);
    if (!st.isFile()) return { ...NOTHING, status: "absent" };
    mode = st.mode;
    raw = await readFile(abs, "utf8");
  } catch {
    // Kein Hook installiert (Vault vor Story 1.19, Setup noch nicht gelaufen).
    return { ...NOTHING, status: "absent" };
  }

  const normalized = normalizeShellScript(raw);
  const lineEndingsFixed = normalized !== raw;
  // Git führt einen nicht-ausführbaren Hook still gar nicht erst aus — der
  // SPEC-Schutz wäre also lautlos abgeschaltet. Ebenfalls heilen.
  const modeFixed = (mode & 0o111) !== 0o111;

  if (!lineEndingsFixed && !modeFixed) {
    return { ...NOTHING, status: "ok", tracked: await isTracked(vaultDir) };
  }

  try {
    if (lineEndingsFixed) await writeFile(abs, normalized, "utf8");
    if (modeFixed) await chmod(abs, HOOK_FILE_MODE);
  } catch (err) {
    return {
      ...NOTHING,
      status: "ok",
      error: `Hook konnte nicht repariert werden: ${message(err)}`,
    };
  }

  const tracked = await isTracked(vaultDir);
  const result: HealVaultHookResult = {
    status: "healed",
    lineEndingsFixed,
    modeFixed,
    tracked,
    committed: false,
    error: null,
  };
  if (!tracked || !shouldCommit) return result;

  // `saveVaultFile` entscheidet selbst, ob es etwas zu committen gibt
  // (`git status --porcelain` nach dem `add`) — ein reiner Mode-Wechsel zählt
  // dort mit, ein No-op erzeugt keinen Commit. Der HEAD-Vergleich ist deshalb
  // die ehrlichste Antwort auf „wurde committet?".
  const before = await headSha(vaultDir);
  try {
    await saveVaultFile({
      targetDir: vaultDir,
      relPath: VAULT_HOOK_PATH,
      content: normalized,
      message: HOOK_HEAL_COMMIT_MESSAGE,
    });
    result.committed = (await headSha(vaultDir)) !== before;
  } catch (err) {
    // Die Datei auf der Platte IST repariert — der Vault ist wieder
    // schreibfähig. Ein gescheiterter Commit (Forgejo down, Konflikt) darf das
    // nicht zu einem Startfehler machen.
    result.error = `Hook repariert, Commit fehlgeschlagen: ${message(err)}`;
  }
  return result;
}

function message(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
