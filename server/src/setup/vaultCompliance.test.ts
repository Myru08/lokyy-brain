/**
 * Story 1.20 AC#6 / AC#8c — der Pre-Flight-Zähler.
 *
 * Der Kern dieses Files ist der DIFFERENZTEST: für jede Beispieldatei wird der
 * ECHTE `.githooks/pre-commit` ausgeführt (Datei gestaged, Hook aufgerufen,
 * Exit-Code = Urteil) und gegen `scanVaultCompliance().blocksCommit` gehalten.
 * Damit ist „die Zahl stimmt mit dem überein, was der Hook wirklich ablehnt"
 * gemessen und nicht behauptet.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { initCore, provisionVaultDir, VAULT_HOOK_PATH } from "@lokyy/core";

const exec = promisify(execFile);

let scaffoldVault: typeof import("./scaffoldVault.js").scaffoldVault;
let scanVaultCompliance: typeof import("./vaultCompliance.js").scanVaultCompliance;

let base: string;
let vaultDir: string;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "lokyy-test",
  GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "lokyy-test",
  GIT_COMMITTER_EMAIL: "test@localhost",
  LC_ALL: "C",
};

async function g(args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", vaultDir, ...args], {
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

async function write(relPath: string, content: string): Promise<void> {
  const abs = join(vaultDir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/**
 * Führt den ECHTEN Hook gegen genau eine gestagte Datei aus. `true` = der Hook
 * würde den Commit ablehnen. Der Index wird danach wieder geleert, damit die
 * Dateien unabhängig voneinander beurteilt werden — so wie der Hook sie beim
 * jeweils eigenen Commit sähe.
 */
async function hookRejects(relPath: string): Promise<boolean> {
  await g(["reset"]);
  await g(["add", "--intent-to-add", "--", relPath]).catch(() => {});
  await g(["add", "--", relPath]);
  try {
    await exec(join(vaultDir, VAULT_HOOK_PATH), [], {
      cwd: vaultDir,
      env: { ...process.env, ...GIT_ENV },
    });
    return false;
  } catch {
    return true;
  } finally {
    await g(["reset"]).catch(() => {});
  }
}

const ULID = "01HQ8ZK3M4N5P6R7S8T9V0WXYZ";

/**
 * Ein vollständig SPEC-valider Kopf, aus dem die Fixtures abweichen.
 *
 * Zeitstempel sind GEQUOTET — genau wie `00_meta/templates/*.md` und alles,
 * was `serializeFrontmatter` schreibt. Unquoted macht YAML daraus ein
 * `Date`-Objekt, und das ist kein `type: string` mehr (siehe den
 * `strict-unquoted-timestamp`-Fixture unten, der genau das abdeckt).
 */
function fm(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    id: ULID,
    type: "note",
    title: "Eine Notiz",
    created: '"2026-01-15T10:00:00.000Z"',
    updated: '"2026-01-15T10:00:00.000Z"',
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\nInhalt.\n`;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "lokyy-compliance-"));
  vaultDir = join(base, "vault");

  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
  process.env.VAULT_DIR = vaultDir;
  process.env.GIT_AUTHOR_NAME = "lokyy-test";
  process.env.GIT_AUTHOR_EMAIL = "test@localhost";
  ({ scaffoldVault } = await import("./scaffoldVault.js"));
  ({ scanVaultCompliance } = await import("./vaultCompliance.js"));

  initCore({
    vaultDir,
    vaultsRoot: join(base, "vaults"),
    gitRemote: "",
    gitBranch: "main",
    gitAuthorName: "lokyy-test",
    gitAuthorEmail: "test@localhost",
  });

  await provisionVaultDir({ targetDir: vaultDir });
  // Schemas + Hook-Datei müssen liegen, damit der Hook überhaupt urteilen kann.
  await scaffoldVault({ vaultDir, activateHook: false });
}, 30_000);

afterEach(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe("scanVaultCompliance — Pre-Flight vor der Hook-Aktivierung", () => {
  it("zählt einen bekannten Mix aus validen und kaputten Notizen korrekt (AC#8c)", async () => {
    // 3 valide …
    await write("20_notes/gut-1.md", fm());
    await write("20_notes/gut-2.md", fm({ type: "task", title: "Aufgabe" }));
    await write("10_projects/gut-3.md", fm({ type: "project", title: "Projekt" }));
    // … 4 kaputte, jede mit einem anderen Defekt.
    await write("20_notes/kein-frontmatter.md", "Nur Text, kein Frontmatter.\n");
    await write("20_notes/ohne-id.md", fm({ id: "" }));
    await write("20_notes/id-kein-ulid.md", fm({ id: "nicht-wirklich-eine-ulid" }));
    await write("20_notes/typ-unbekannt.md", fm({ type: "hausaufgabe" }));

    const report = await scanVaultCompliance({ vaultDir });

    expect(report.scanned).toBe(7);
    expect(report.blocking).toBe(4);
    expect(report.invalid).toBe(4);
    expect(report.samples).toHaveLength(4);
    expect(report.truncated).toBe(false);
    expect(report.samples.map((s) => s.path).sort()).toEqual([
      "20_notes/id-kein-ulid.md",
      "20_notes/kein-frontmatter.md",
      "20_notes/ohne-id.md",
      "20_notes/typ-unbekannt.md",
    ]);
  }, 30_000);

  it("stimmt Datei für Datei mit dem ECHTEN pre-commit-Hook überein (AC#6)", async () => {
    const fixtures: Record<string, string> = {
      // — SPEC-valide, Hook lässt durch —
      "20_notes/ok-note.md": fm(),
      "20_notes/ok-task.md": fm({ type: "task" }),
      // — beide lehnen ab —
      "20_notes/bad-no-fence.md": "kein frontmatter\n",
      "20_notes/bad-missing-id.md": fm({ id: "" }),
      "20_notes/bad-missing-updated.md": fm({ updated: "" }),
      "20_notes/bad-missing-title.md": fm({ title: "" }),
      "20_notes/bad-ulid-short.md": fm({ id: "01HQ8ZK3M4" }),
      "20_notes/bad-ulid-lowercase.md": fm({ id: ULID.toLowerCase() }),
      "20_notes/bad-unknown-type.md": fm({ type: "rezept" }),
      // — die App ist strenger als der Hook —
      // Datum ohne Zeit: kein `date-time`, aber `^created:` findet der Hook.
      "20_notes/strict-date-only.md": fm({ created: '"2024-05-01"' }),
      // Unquoted → YAML macht ein Date-Objekt draus, kein String.
      "20_notes/strict-unquoted-ts.md": fm({ created: "2024-05-01T08:00:00Z" }),
      // Unquoted Zahl → `title` ist kein String.
      "20_notes/strict-title-number.md": fm({ title: "42" }),
      // Kaputtes YAML: der Hook parst kein YAML und lässt es durch.
      "20_notes/strict-broken-yaml.md":
        `---\nid: ${ULID}\ntype: note\ntitle: "unbalanciert\ncreated: "2026-01-15T10:00:00.000Z"\nupdated: "2026-01-15T10:00:00.000Z"\n---\n\nInhalt.\n`,
    };
    for (const [path, content] of Object.entries(fixtures)) {
      await write(path, content);
    }

    const report = await scanVaultCompliance({ vaultDir, sampleLimit: 100 });
    const byPath = new Map(report.samples.map((s) => [s.path, s]));

    const mismatches: string[] = [];
    let hookRejectCount = 0;
    for (const path of Object.keys(fixtures)) {
      const actual = await hookRejects(path);
      if (actual) hookRejectCount++;
      const predicted = byPath.get(path)?.blocksCommit ?? false;
      if (predicted !== actual) {
        mismatches.push(
          `${path}: Scan sagt blocksCommit=${predicted}, Hook sagt ${actual}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
    // Die gemeldete Zahl IST die Zahl, die der Hook ablehnt.
    expect(report.blocking).toBe(hookRejectCount);
  }, 60_000);

  it("meldet die App-strengeren Befunde als invalid, aber NICHT als blockierend", async () => {
    await write("20_notes/date-only.md", fm({ created: '"2024-05-01"' }));

    const report = await scanVaultCompliance({ vaultDir });

    expect(report.invalid).toBe(1);
    expect(report.blocking).toBe(0);
    expect(report.samples[0].blocksCommit).toBe(false);
    expect(report.samples[0].reasons.join(" ")).toMatch(/created/);
    // Gegenprobe am echten Hook.
    expect(await hookRejects("20_notes/date-only.md")).toBe(false);
  }, 30_000);

  it("überspringt exakt das, was auch der Hook überspringt", async () => {
    // Der Hook filtert `^00_meta/`, `^docs/` und `^README`. Alle drei sind hier
    // absichtlich kaputt — sie dürfen weder gezählt noch gemeldet werden.
    await write("00_meta/kaputt.md", "kein frontmatter\n");
    await write("docs/kaputt.md", "kein frontmatter\n");
    await write("README.md", "kein frontmatter\n");
    await write("20_notes/zaehlt.md", fm());

    const report = await scanVaultCompliance({ vaultDir });

    expect(report.scanned).toBe(1);
    expect(report.invalid).toBe(0);
    for (const path of ["00_meta/kaputt.md", "docs/kaputt.md", "README.md"]) {
      expect(await hookRejects(path), `${path} sollte den Hook passieren`).toBe(false);
    }
  }, 30_000);

  it("kappt die Beispielliste und meldet das ehrlich", async () => {
    for (let i = 0; i < 8; i++) {
      await write(`20_notes/kaputt-${i}.md`, "kein frontmatter\n");
    }

    const report = await scanVaultCompliance({ vaultDir, sampleLimit: 3 });

    expect(report.invalid).toBe(8);
    expect(report.blocking).toBe(8);
    expect(report.samples).toHaveLength(3);
    expect(report.truncated).toBe(true);
  }, 30_000);

  it("liefert für einen sauberen Vault eine glatte Null", async () => {
    await write("20_notes/a.md", fm());
    await write("20_notes/b.md", fm({ type: "decision", title: "Entscheidung" }));

    const report = await scanVaultCompliance({ vaultDir });

    expect(report.scanned).toBe(2);
    expect(report.invalid).toBe(0);
    expect(report.blocking).toBe(0);
    expect(report.samples).toEqual([]);
  }, 30_000);
});
