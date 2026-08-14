import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * issue #62 — `listNoteIdentities()`: Pfad-ID UND Frontmatter-ULID im Bulk.
 *
 * DER BEFUND, den diese Tests festnageln: Wer beide Identitäten braucht, hatte
 * bisher nur schlechte Wege — `getNote()` pullt je Notiz, `findByUlid()` läuft
 * je Lookup durch den ganzen Vault, `listNotes()` kennt die ULID nicht. Der
 * Workaround in `server/src/lib/derivedStoreOrphans.ts` las den Frontmatter-Kopf
 * mit einem EIGENEN Regex — eine zweite Wahrheit über das Format, die still
 * veraltet, sobald sich das Format ändert.
 *
 * Drei Eigenschaften stehen deshalb im Mittelpunkt:
 *   1. EIN Pull für den ganzen Aufruf, nicht einer je Notiz.
 *   2. Die ULID kommt aus `parseFrontmatter` — keine zweite Format-Kenntnis.
 *   3. Kein stiller Fehlbetrag: Notizen ohne (gültige) ULID kommen mit
 *      `ulid: null` zurück, nicht gar nicht. Und ein Frontmatter-Block, der
 *      länger ist als der gelesene Kopf, liefert trotzdem seine ULID — sonst
 *      wäre die Kopf-Optimierung genau der stille Datenverlust, den dieses
 *      Issue beseitigt.
 *
 * Git ist gemockt: `pull()` zählt nur, die Vault-Dateien werden direkt
 * geschrieben. So misst der Pull-Test die Aufrufzahl statt Netzwerkverhalten.
 */

let pullCount = 0;

vi.mock("../git/gitService.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    pull: async () => {
      pullCount += 1;
    },
  };
});

const { initCore } = await import("../util/coreConfig.js");
const { listNoteIdentities } = await import("./notesService.js");

/** ULIDs: Crockford-base32, 26 Zeichen. */
const ULID_A = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const ULID_LATE = "01J0000000000000000000000A";
const ULID_EARLY = "01J0000000000000000000000B";
const ULID_LONG_BODY = "01J0000000000000000000000C";

/** Füllung, die den Frontmatter-Block sicher über jeden Kopf-Puffer hebt. */
const PADDING = "x".repeat(16_384);

let vaultDir: string;

async function writeNote(relPath: string, content: string): Promise<void> {
  const abs = join(vaultDir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

beforeAll(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "lokyy-note-identities-"));

  initCore({
    vaultDir,
    gitRemote: "",
    gitBranch: "main",
    gitAuthorName: "lokyy-test",
    gitAuthorEmail: "test@localhost",
  });

  // Der Normalfall: gültige ULID im Frontmatter.
  await writeNote(
    "10_projects/a.md",
    `---\nid: ${ULID_A}\ntype: note\ntitle: A\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\n# A\n`,
  );

  // Frontmatter ohne `id` — die Notiz existiert, die ULID nicht.
  await writeNote(
    "20_areas/b.md",
    `---\ntype: note\ntitle: B\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\n# B\n`,
  );

  // Gar kein Frontmatter — darf nicht werfen.
  await writeNote("30_captures/c.md", `# C\n\nNur Fließtext, kein Block.\n`);

  // `id` vorhanden, aber keine gültige ULID: derselbe Fall wie „keine ULID".
  await writeNote(
    "20_areas/d.md",
    `---\nid: kaputt-keine-ulid\ntype: note\ntitle: D\n---\n\n# D\n`,
  );

  // DER KRITISCHE FALL, Teil 1: die `id:`-Zeile steht HINTER dem Kopf-Puffer.
  await writeNote(
    "40_edge/late-id.md",
    `---\ntype: note\ntitle: Late\nnotes: "${PADDING}"\nid: ${ULID_LATE}\n---\n\n# Late\n`,
  );

  // DER KRITISCHE FALL, Teil 2: `id:` steht früh, aber der SCHLUSS-Zaun liegt
  // hinter dem Puffer. Ein Kopf ohne schließendes `---` ist für gray-matter
  // gar kein Frontmatter — ein naiver Kopf-Parse liefert hier still `null`.
  await writeNote(
    "40_edge/early-id.md",
    `---\nid: ${ULID_EARLY}\ntype: note\ntitle: Early\nnotes: "${PADDING}"\n---\n\n# Early\n`,
  );

  // Der Gegenprobe-Fall: Datei weit größer als der Kopf-Puffer, Block aber
  // vollständig darin — hier MUSS der Kopf reichen, sonst wäre die Optimierung
  // wirkungslos und jede lange Notiz würde ganz gelesen.
  await writeNote(
    "50_long/body.md",
    `---\nid: ${ULID_LONG_BODY}\ntype: note\ntitle: Long\n---\n\n# Long\n\n${PADDING}\n`,
  );
});

afterAll(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

/** Bequemer Zugriff: Ergebnis als Map pathId → ulid. */
async function identityMap(): Promise<Map<string, string | null>> {
  const rows = await listNoteIdentities();
  return new Map(rows.map((r) => [r.pathId, r.ulid]));
}

describe("listNoteIdentities", () => {
  it("liefert für eine gültige Notiz beide Identitäten", async () => {
    const map = await identityMap();

    expect(map.get("10_projects/a")).toBe(ULID_A);
  });

  it("gibt `ulid: null` zurück, wenn das Frontmatter kein `id` hat", async () => {
    const map = await identityMap();

    // Vorhanden — nicht still verschluckt.
    expect(map.has("20_areas/b")).toBe(true);
    expect(map.get("20_areas/b")).toBeNull();
  });

  it("gibt `ulid: null` zurück und wirft nicht, wenn Frontmatter ganz fehlt", async () => {
    const map = await identityMap();

    expect(map.has("30_captures/c")).toBe(true);
    expect(map.get("30_captures/c")).toBeNull();
  });

  it("behandelt ein ungültiges `id` wie eine fehlende ULID", async () => {
    const map = await identityMap();

    expect(map.get("20_areas/d")).toBeNull();
  });

  it("findet die ULID auch, wenn das Frontmatter länger ist als der gelesene Kopf", async () => {
    const map = await identityMap();

    // Beides sind Belege dafür, dass die Kopf-Optimierung keine Daten verliert.
    expect(map.get("40_edge/late-id")).toBe(ULID_LATE);
    expect(map.get("40_edge/early-id")).toBe(ULID_EARLY);
  });

  it("liest bei langem Body nur den Kopf und findet die ULID trotzdem", async () => {
    const map = await identityMap();

    expect(map.get("50_long/body")).toBe(ULID_LONG_BODY);
  });

  it("führt EINEN Pull für den ganzen Aufruf aus, nicht einen je Notiz", async () => {
    pullCount = 0;

    const rows = await listNoteIdentities();

    expect(rows.length).toBeGreaterThan(1);
    expect(pullCount).toBe(1);
  });

  it("kann den Pull auslassen, wenn der Aufrufer schon gepullt hat", async () => {
    pullCount = 0;

    const rows = await listNoteIdentities({ pull: false });

    expect(rows.length).toBeGreaterThan(1);
    expect(pullCount).toBe(0);
  });

  it("listet jede .md-Datei genau einmal", async () => {
    const rows = await listNoteIdentities();

    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.pathId)).size).toBe(7);
  });
});
