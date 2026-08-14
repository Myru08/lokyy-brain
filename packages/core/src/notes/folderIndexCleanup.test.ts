import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Issue #56 — Ordner-Löschung und Ordner-Verschieben räumen die Suchindizes ab.
 *
 * Vorher lief die Index-Bereinigung in `deleteEntry` nur hinter
 * `if (kind === "note")`. Ein gelöschter Ordner nahm zwar die Dateien mit,
 * ließ aber jede enthaltene Notiz in `note_search` (Tier 1) UND
 * `note_embeddings` (Tier 2) stehen. Beim Ordner-Move war es schlimmer: die
 * `note_id` IST der Pfad ohne ".md", also entstanden Geisterzeilen unter den
 * alten Pfaden und gar keine unter den neuen.
 *
 * Wie in `searchIndexWiring.test.ts`: echtes Git-Repo im tmpdir, aber das
 * Memory-Modul gemockt — hier wird die VERDRAHTUNG geprüft, nicht die DB.
 * Der letzte Block fährt bewusst die ECHTE Bulk-Implementierung, um AC#6
 * (begrenzter Fan-out) am realen Aufrufpfad zu belegen.
 */

const exec = promisify(execFile);

const queueBulkTierRemove = vi.fn();
const queueBulkTierRefresh = vi.fn();
const queueSearchIndexRemove = vi.fn();
const queueIndexRemove = vi.fn();
const queueIndexRefresh = vi.fn();
const queueSearchIndexRefresh = vi.fn();

vi.mock("../memory/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/index.js")>();
  return {
    ...actual,
    queueIndexRefresh: (...a: unknown[]) => queueIndexRefresh(...a),
    queueSearchIndexRefresh: (...a: unknown[]) => queueSearchIndexRefresh(...a),
    queueSearchIndexRemove: (...a: unknown[]) => queueSearchIndexRemove(...a),
    queueIndexRemove: (...a: unknown[]) => queueIndexRemove(...a),
    queueBulkTierRemove: (...a: unknown[]) => queueBulkTierRemove(...a),
    queueBulkTierRefresh: (...a: unknown[]) => queueBulkTierRefresh(...a),
  };
});

const { initCore } = await import("../util/coreConfig.js");
const { ensureRepo } = await import("../git/gitService.js");
const { createNote, deleteEntry, moveEntry } = await import("./notesService.js");
const { Tier1BM25 } = await import("../memory/Tier1BM25.js");
const { Tier1Provider } = await import("../memory/Tier1Provider.js");
const { Tier2Provider } = await import("../memory/Tier2Provider.js");
const actualMemory = await vi.importActual<typeof import("../memory/index.js")>(
  "../memory/index.js",
);

const REAL_VAULT_ID = "01KYPWCA9JA6TBRF9NFZMC47PB";

let base: string;
let workdir: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "lokyy-folderidx-"));
  const remote = join(base, "remote");
  workdir = join(base, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);

  const seed = join(base, "seed");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "lokyy-test",
    GIT_AUTHOR_EMAIL: "test@localhost",
    GIT_COMMITTER_NAME: "lokyy-test",
    GIT_COMMITTER_EMAIL: "test@localhost",
  };
  await exec("git", ["init", "--initial-branch=main", seed]);
  await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"], { env });
  await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
  await exec("git", ["-C", seed, "push", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });

  initCore({
    vaultDir: workdir,
    gitRemote: remote,
    gitBranch: "main",
    gitAuthorName: "lokyy-test",
    gitAuthorEmail: "test@localhost",
    vaultId: REAL_VAULT_ID,
  });
  await ensureRepo();
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

beforeEach(() => {
  for (const m of [
    queueBulkTierRemove,
    queueBulkTierRefresh,
    queueSearchIndexRemove,
    queueIndexRemove,
    queueIndexRefresh,
    queueSearchIndexRefresh,
  ]) {
    m.mockReset();
  }
});

afterEach(async () => {
  await actualMemory.flushBulkIndexQueue();
  vi.restoreAllMocks();
});

/** Legt `count` Notizen unter `folder` an und gibt ihre IDs zurück. */
async function seedFolder(folder: string, count: number): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i < count; i++) {
    const note = await createNote(`${folder}/note-${i}`, `# Note ${i}\n\nInhalt ${i}`, {
      type: "note",
      title: `Note ${i}`,
    });
    created.push(note.id);
  }
  return created;
}

describe("deleteEntry(folder) — AC#1/#2", () => {
  it("räumt beide Tiers für ALLE enthaltenen Notizen ab, rekursiv", async () => {
    const flat = await seedFolder("del-folder", 3);
    const nested = await seedFolder("del-folder/tief", 2);

    await deleteEntry("del-folder", "folder");

    expect(queueBulkTierRemove).toHaveBeenCalledTimes(1);
    const [vaultId, cleaned] = queueBulkTierRemove.mock.calls[0]!;
    expect(vaultId).toBe(REAL_VAULT_ID);
    expect([...(cleaned as string[])].sort()).toEqual([...flat, ...nested].sort());
  });

  it("sammelt die IDs VOR der Git-Operation ein — nach dem Löschen sind sie weg", async () => {
    const seeded = await seedFolder("del-before-git", 2);

    await deleteEntry("del-before-git", "folder");

    // Wäre der Walk nach `remove` gelaufen, käme hier eine leere Liste an.
    expect((queueBulkTierRemove.mock.calls[0]![1] as string[]).length).toBe(
      seeded.length,
    );
  });

  it("lässt den Einzel-Notiz-Pfad unangetastet (AC#7)", async () => {
    const [id] = await seedFolder("del-single", 1);

    await deleteEntry(id!, "note");

    expect(queueSearchIndexRemove).toHaveBeenCalledWith(id);
    expect(queueIndexRemove).toHaveBeenCalledWith(REAL_VAULT_ID, id);
    expect(queueBulkTierRemove).not.toHaveBeenCalled();
  });

  it("löst für einen leeren Ordner keine Bereinigung aus", async () => {
    const { createFolder } = await import("./notesService.js");
    await createFolder("del-empty");

    await deleteEntry("del-empty", "folder");

    expect(queueBulkTierRemove).not.toHaveBeenCalled();
  });
});

describe("deleteEntry(folder) — AC#5: Sammeln darf das Löschen nie abbrechen", () => {
  it("wirft nicht, wenn der Ordner nicht LESBAR ist (Walk scheitert, git nicht)", async () => {
    if (process.getuid?.() === 0) return; // root umgeht Dateirechte
    await seedFolder("del-noaccess", 2);
    const abs = join(workdir, "del-noaccess");
    // Schreib-/Betretbar (git rm kommt durch), aber nicht auflistbar
    // (readdir ⇒ EACCES). Genau der AC#5-Fall: der Walk scheitert, das
    // Löschen läuft trotzdem durch.
    await chmod(abs, 0o333);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(deleteEntry("del-noaccess", "folder")).resolves.toBeDefined();
      expect(queueBulkTierRemove).not.toHaveBeenCalled();
      expect(warned).toHaveBeenCalled();
    } finally {
      await chmod(abs, 0o755).catch(() => {});
    }
  });

  it("wirft beim Sammeln nicht, wenn der Ordner gar nicht existiert", async () => {
    // Der Walk liefert [], das eigentliche `git rm` wirft dann (echter Fehler).
    await expect(deleteEntry("gibt-es-nicht", "folder")).rejects.toThrow();
    expect(queueBulkTierRemove).not.toHaveBeenCalled();
  });
});

describe("moveEntry(folder) — AC#3", () => {
  it("entfernt die ALTEN IDs und indiziert unter den NEUEN", async () => {
    const oldIds = await seedFolder("mv-src/inner", 2);
    const rootIds = await seedFolder("mv-src", 1);
    const all = [...oldIds, ...rootIds];

    await moveEntry("mv-src", "mv-dst", "folder");

    expect(queueBulkTierRemove).toHaveBeenCalledTimes(1);
    const [, removed] = queueBulkTierRemove.mock.calls[0]!;
    expect([...(removed as string[])].sort()).toEqual([...all].sort());

    expect(queueBulkTierRefresh).toHaveBeenCalledTimes(1);
    const [vaultId, items] = queueBulkTierRefresh.mock.calls[0]!;
    expect(vaultId).toBe(REAL_VAULT_ID);
    const newIds = (items as { noteId: string }[]).map((i) => i.noteId).sort();
    expect(newIds).toEqual(all.map((id) => id.replace(/^mv-src/, "mv-dst")).sort());
  });

  it("die Refresh-Items laden den echten Inhalt vom NEUEN Pfad", async () => {
    await seedFolder("mv-load", 1);

    await moveEntry("mv-load", "mv-load-neu", "folder");

    const [, items] = queueBulkTierRefresh.mock.calls[0]!;
    const first = (items as {
      noteId: string;
      load: () => Promise<{ title: string; body: string; tags: string[] } | null>;
    }[])[0]!;
    expect(first.noteId).toBe("mv-load-neu/note-0");
    const doc = await first.load();
    expect(doc).not.toBeNull();
    expect(doc!.body).toContain("Inhalt 0");
  });

  it("lässt den Einzel-Notiz-Move unangetastet (AC#7)", async () => {
    const [id] = await seedFolder("mv-single", 1);

    await moveEntry(id!, "mv-single/note-renamed", "note");

    expect(queueSearchIndexRemove).toHaveBeenCalledWith(id);
    expect(queueBulkTierRemove).not.toHaveBeenCalled();
    expect(queueBulkTierRefresh).not.toHaveBeenCalled();
  });
});

describe("AC#4/#6 am echten Aufrufpfad — fire-and-forget mit begrenztem Fan-out", () => {
  it("deleteEntry wartet NIE auf die Bereinigung — und bündelt sie", async () => {
    const seeded = await seedFolder("fanout", 6);

    // Für diesen Fall die ECHTE Bulk-Implementierung fahren.
    queueBulkTierRemove.mockImplementation((vaultId: string, noteIds: string[]) =>
      actualMemory.queueBulkTierRemove(vaultId, noteIds),
    );
    // Die Tier-1-Löschung hängt, bis wir sie freigeben. Kehrt `deleteEntry`
    // trotzdem zurück, hat es nachweislich nicht darauf gewartet — mit einem
    // reinen Microtask-Tick wäre das nicht unterscheidbar, weil `await
    // deleteEntry(...)` selbst über Microtasks auflöst.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const t1 = vi
      .spyOn(Tier1BM25.prototype, "removeMany")
      .mockImplementation(() => gate);
    const t2 = vi
      .spyOn(Tier2Provider.prototype, "removeNotes")
      .mockResolvedValue(undefined);
    vi.spyOn(Tier1Provider.prototype, "removeNote").mockResolvedValue(undefined);

    await expect(deleteEntry("fanout", "folder")).resolves.toBeDefined();

    // Die Bereinigung steckt noch im Gate — Tier 2 ist noch gar nicht dran.
    expect(t2).not.toHaveBeenCalled();

    release();
    await actualMemory.flushBulkIndexQueue();

    // Sechs Notizen, aber genau EINE Query pro Tier — kein Schreib-Sturm.
    expect(t1).toHaveBeenCalledTimes(1);
    expect(t2).toHaveBeenCalledTimes(1);
    expect([...t1.mock.calls[0]![0]].sort()).toEqual([...seeded].sort());
  });

  it("deleteEntry wirft nicht, wenn die gebündelte Bereinigung fehlschlägt", async () => {
    await seedFolder("fanout-boom", 2);

    queueBulkTierRemove.mockImplementation((vaultId: string, noteIds: string[]) =>
      actualMemory.queueBulkTierRemove(vaultId, noteIds),
    );
    vi.spyOn(Tier1BM25.prototype, "removeMany").mockRejectedValue(
      new Error("index pool down"),
    );
    vi.spyOn(Tier2Provider.prototype, "removeNotes").mockRejectedValue(
      new Error("tier2 down"),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(deleteEntry("fanout-boom", "folder")).resolves.toBeDefined();
    await actualMemory.flushBulkIndexQueue();

    expect(logged).toHaveBeenCalled();
  });
});
