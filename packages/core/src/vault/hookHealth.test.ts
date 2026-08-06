/**
 * Windows-CRLF-Blocker: Normalisierung + Self-Heal des Vault-Pre-Commit-Hooks.
 *
 * Der Kern dieser Story lässt sich NICHT mit Mocks beweisen: dass ein CRLF-Hook
 * jeden Commit killt, entscheidet der Kernel beim `execve` (er sucht dann den
 * Interpreter `/bin/sh\r`). Deshalb laufen die Tests hier — wie
 * `preCommitHook.test.ts` und `git/gitService.test.ts` — gegen echte
 * Wegwerf-Repos aus `mkdtemp`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { initCore } from "../util/coreConfig.js";
import { buildVaultScaffold, VAULT_HOOKS_DIR, VAULT_HOOK_PATH } from "./scaffold.js";
import {
  healVaultHook,
  installExecutableScript,
  normalizeShellScript,
} from "./hookHealth.js";

const exec = promisify(execFile);

let vault: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", vault, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@localhost",
      LC_ALL: "C",
    },
  });
  return stdout.trim();
}

const NOTE = [
  "---",
  "id: 01HPXY9Z0000000000000000AB",
  "type: note",
  'title: "Eine Notiz"',
  "created: 2026-01-01T00:00:00.000Z",
  "updated: 2026-01-01T00:00:00.000Z",
  "---",
  "",
  "Body.",
  "",
].join("\n");

/** Stage a note and report whether the commit survived (or died in the hook). */
async function tryCommit(relPath: string, content = NOTE): Promise<boolean> {
  const abs = join(vault, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  await git(["add", "--", relPath]);
  try {
    await git(["commit", "-m", `test: ${relPath}`]);
    return true;
  } catch {
    await git(["reset", "--", relPath]).catch(() => {});
    return false;
  }
}

/** A fully scaffolded, hook-activated vault with one commit in it. */
async function makeVault(): Promise<void> {
  vault = await mkdtemp(join(tmpdir(), "lokyy-hookheal-"));
  await exec("git", ["init", "-q", vault]);
  for (const file of await buildVaultScaffold("para")) {
    const abs = join(vault, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
    if (file.executable) await chmod(abs, 0o755);
  }
  await git(["config", "core.hooksPath", VAULT_HOOKS_DIR]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "chore: scaffold"]);

  initCore({
    vaultDir: vault,
    gitRemote: "",
    gitBranch: (await git(["rev-parse", "--abbrev-ref", "HEAD"])) || "main",
    gitAuthorName: "test",
    gitAuthorEmail: "test@localhost",
  } as Parameters<typeof initCore>[0]);
}

/**
 * Break the installed hook exactly the way a Windows checkout does.
 *
 * `versioned: true` committet die CRLF-Fassung zusätzlich — das ist der ECHTE
 * Zustand aus dem Feld: der Scaffold committet `.githooks/pre-commit`, ein aus
 * einem Windows-Checkout gebautes Image bringt ihn mit CRLF mit, und damit
 * liegt der Blocker im Repo statt nur auf der Platte. `--no-verify` ist der
 * einzige Weg, diesen Zustand nachzustellen — mit scharfem CRLF-Hook kommt
 * kein Commit mehr durch, auch der nicht, der ihn einspielt.
 */
async function crlfMangleHook(opts: { versioned?: boolean } = {}): Promise<void> {
  const abs = join(vault, VAULT_HOOK_PATH);
  const lf = await readFile(abs, "utf8");
  await writeFile(abs, lf.replace(/\n/g, "\r\n"), "utf8");
  if (opts.versioned) {
    await git(["add", "--", VAULT_HOOK_PATH]);
    await git(["commit", "--no-verify", "-m", "chore: hook aus Windows-Checkout"]);
  }
}

beforeEach(makeVault, 30_000);
afterEach(async () => {
  if (vault) await rm(vault, { recursive: true, force: true });
});

describe("normalizeShellScript", () => {
  it("turns CRLF into LF", () => {
    expect(normalizeShellScript("#!/bin/sh\r\necho hi\r\n")).toBe("#!/bin/sh\necho hi\n");
  });

  it("turns a lone CR (classic-Mac endings) into LF", () => {
    expect(normalizeShellScript("#!/bin/sh\recho hi\r")).toBe("#!/bin/sh\necho hi\n");
  });

  it("leaves an already-LF script byte-identical and is idempotent", () => {
    const lf = "#!/bin/sh\nset -u\nexit 0\n";
    expect(normalizeShellScript(lf)).toBe(lf);
    expect(normalizeShellScript(normalizeShellScript(lf))).toBe(lf);
  });
});

describe("AC2 — installExecutableScript (der Installations-Pfad)", () => {
  it("schreibt eine CRLF-Quelle als LF und setzt das Executable-Bit", async () => {
    const abs = join(vault, VAULT_HOOKS_DIR, "probe");
    await installExecutableScript(abs, "#!/bin/sh\r\nexit 0\r\n");

    expect(await readFile(abs, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect((await stat(abs)).mode & 0o111).toBe(0o111);
  });

  it("installiert den echten Hook CRLF-frei — ein Commit läuft durch", async () => {
    const hook = (await buildVaultScaffold("para")).find((f) => f.path === VAULT_HOOK_PATH);
    expect(hook?.executable).toBe(true);
    // Der Scaffold-Inhalt selbst trägt nie ein CR — egal wie der Quellbaum
    // ausgecheckt wurde (das ist die Hälfte, die .gitattributes absichert).
    expect(hook?.content).not.toContain("\r");

    const abs = join(vault, VAULT_HOOK_PATH);
    await installExecutableScript(abs, (hook as { content: string }).content);
    expect(await tryCommit("20_notes/ok.md")).toBe(true);
  });
});

describe("AC3 — healVaultHook", () => {
  it("der CRLF-Hook blockiert wirklich JEDEN Commit (Beweis des Blockers)", async () => {
    await crlfMangleHook();
    expect(await tryCommit("20_notes/blockiert.md")).toBe(false);
  });

  it("repariert Zeilenenden, committet die Reparatur — danach committet der Vault wieder", async () => {
    await crlfMangleHook({ versioned: true });
    expect(await tryCommit("20_notes/vorher.md")).toBe(false);

    const result = await healVaultHook({ vaultDir: vault });

    expect(result.status).toBe("healed");
    expect(result.lineEndingsFixed).toBe(true);
    expect(result.tracked).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.error).toBeNull();

    const healed = await readFile(join(vault, VAULT_HOOK_PATH), "utf8");
    expect(healed).not.toContain("\r");
    expect((await stat(join(vault, VAULT_HOOK_PATH))).mode & 0o111).toBe(0o111);

    // Der eigentliche Beweis: der Vault ist wieder schreibfähig.
    expect(await tryCommit("20_notes/nachher.md")).toBe(true);

    // Und die Reparatur liegt versioniert vor, nicht nur im Working-Copy.
    expect(await git(["status", "--porcelain", "--", VAULT_HOOK_PATH])).toBe("");
    expect(await git(["log", "-1", "--format=%s", "--", VAULT_HOOK_PATH])).toContain(
      "pre-commit-Hook repariert",
    );
    expect(await git(["show", `HEAD:${VAULT_HOOK_PATH}`])).not.toContain("\r");
  }, 30_000);

  it("committet nicht, wenn nur der Working-Copy kaputt war (Repo-Fassung ist gesund)", async () => {
    await crlfMangleHook();
    expect(await tryCommit("20_notes/vorher.md")).toBe(false);

    const result = await healVaultHook({ vaultDir: vault });

    expect(result.status).toBe("healed");
    expect(result.tracked).toBe(true);
    // Nichts zu committen: HEAD trug bereits die LF-Fassung.
    expect(result.committed).toBe(false);
    expect(await git(["status", "--porcelain", "--", VAULT_HOOK_PATH])).toBe("");
    expect(await tryCommit("20_notes/nachher.md")).toBe(true);
  }, 30_000);

  it("ist idempotent: ein zweiter Lauf fasst nichts an und committet nicht", async () => {
    await crlfMangleHook({ versioned: true });
    await healVaultHook({ vaultDir: vault });
    const headAfterHeal = await git(["rev-parse", "HEAD"]);

    const second = await healVaultHook({ vaultDir: vault });

    expect(second.status).toBe("ok");
    expect(second.lineEndingsFixed).toBe(false);
    expect(second.modeFixed).toBe(false);
    expect(second.committed).toBe(false);
    expect(await git(["rev-parse", "HEAD"])).toBe(headAfterHeal);
  }, 30_000);

  it("stellt ein verlorenes Executable-Bit wieder her", async () => {
    await chmod(join(vault, VAULT_HOOK_PATH), 0o644);

    const result = await healVaultHook({ vaultDir: vault });

    expect(result.status).toBe("healed");
    expect(result.modeFixed).toBe(true);
    expect(result.lineEndingsFixed).toBe(false);
    expect((await stat(join(vault, VAULT_HOOK_PATH))).mode & 0o111).toBe(0o111);
  }, 30_000);

  it("meldet `absent` (und wirft nicht), wenn der Vault gar keinen Hook hat", async () => {
    await rm(join(vault, VAULT_HOOK_PATH));
    const result = await healVaultHook({ vaultDir: vault });
    expect(result.status).toBe("absent");
    expect(result.committed).toBe(false);
    expect(result.error).toBeNull();
  });

  it("repariert auch einen NICHT versionierten Hook — dann ohne Commit", async () => {
    await git(["rm", "--cached", "--", VAULT_HOOK_PATH]);
    await git(["commit", "-m", "chore: untrack hook"]);
    await crlfMangleHook();

    const result = await healVaultHook({ vaultDir: vault });

    expect(result.status).toBe("healed");
    expect(result.tracked).toBe(false);
    expect(result.committed).toBe(false);
    expect(await readFile(join(vault, VAULT_HOOK_PATH), "utf8")).not.toContain("\r");
    expect(await tryCommit("20_notes/untracked-hook.md")).toBe(true);
  }, 30_000);

  it("wirft nie — ein Verzeichnis ohne git wird als Datei-Reparatur behandelt", async () => {
    const bare = await mkdtemp(join(tmpdir(), "lokyy-nogit-"));
    try {
      const abs = join(bare, VAULT_HOOK_PATH);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, "#!/bin/sh\r\nexit 0\r\n", "utf8");

      const result = await healVaultHook({ vaultDir: bare });

      expect(result.status).toBe("healed");
      expect(result.tracked).toBe(false);
      expect(result.committed).toBe(false);
      expect(await readFile(abs, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
