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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Story 5.8 AC#1/AC#2 — the Tier-2 index hook must actually be wired into the
 * normal write path, with a REAL vault id.
 *
 * Before this story `queueIndexRefresh` (Tier 2) had zero call sites and the
 * Tier-1 hook was called with the `LOKYY_DEFAULT_VAULT ?? "default"`
 * placeholder. `note_embeddings.vault_id` has an FK to `vaults(id)`, so every
 * Tier-2 insert under the placeholder would be rejected — which is why
 * semantic search was inert while Tier 1 looked healthy (`note_search` has no
 * such FK).
 *
 * The memory module is mocked so this test asserts the WIRING only — no DB,
 * no Ollama.
 */

const exec = promisify(execFile);

const queueIndexRefresh = vi.fn();
const queueSearchIndexRefresh = vi.fn();
const queueSearchIndexRemove = vi.fn();
const queueIndexRemove = vi.fn();

vi.mock("../memory/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/index.js")>();
  return {
    ...actual,
    queueIndexRefresh: (...args: unknown[]) => queueIndexRefresh(...args),
    queueSearchIndexRefresh: (...args: unknown[]) => queueSearchIndexRefresh(...args),
    queueSearchIndexRemove: (...args: unknown[]) => queueSearchIndexRemove(...args),
    queueIndexRemove: (...args: unknown[]) => queueIndexRemove(...args),
  };
});

const { initCore } = await import("../util/coreConfig.js");
const { ensureRepo } = await import("../git/gitService.js");
const { createNote, saveNote, moveEntry, deleteEntry, trashEntry } = await import(
  "./notesService.js"
);
const { CombinedProvider } = await import("../memory/CombinedProvider.js");
/**
 * The UNMOCKED memory module — used by the throw-safety case below, which has
 * to exercise the real `queueIndexRemove` (the mock above obviously cannot
 * prove that the real implementation swallows provider errors).
 */
const actualMemory = await vi.importActual<typeof import("../memory/index.js")>(
  "../memory/index.js",
);

const REAL_VAULT_ID = "01KYPWCA9JA6TBRF9NFZMC47PB";

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "lokyy-idxwire-"));
  const remote = join(base, "remote");
  const workdir = join(base, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);

  const seed = join(base, "seed");
  await exec("git", ["init", "--initial-branch=main", seed]);
  await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "lokyy-test",
      GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "lokyy-test",
      GIT_COMMITTER_EMAIL: "test@localhost",
    },
  });
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
  queueIndexRefresh.mockClear();
  queueSearchIndexRefresh.mockClear();
  queueSearchIndexRemove.mockClear();
  queueIndexRemove.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Story 5.8 AC#1/AC#2 — Tier-2 hook wired with the real vault id", () => {
  it("createNote queues BOTH tiers, scoped to the configured vault id", async () => {
    const created = await createNote("wiring-create", "# Wiring Create\n\nbody text", {
      type: "note",
      title: "Wiring Create",
    });

    expect(queueSearchIndexRefresh).toHaveBeenCalledTimes(1);
    expect(queueSearchIndexRefresh.mock.calls[0]![0]).toBe(REAL_VAULT_ID);
    expect(queueIndexRefresh).toHaveBeenCalledTimes(1);
    expect(queueIndexRefresh).toHaveBeenCalledWith(REAL_VAULT_ID, created.id);
  });

  it("saveNote queues BOTH tiers, scoped to the configured vault id", async () => {
    const created = await createNote("wiring-save", "# Wiring Save\n\noriginal", {
      type: "note",
      title: "Wiring Save",
    });
    queueIndexRefresh.mockClear();
    queueSearchIndexRefresh.mockClear();

    const saved = await saveNote(created.id, "# Wiring Save\n\nedited body");

    expect(queueSearchIndexRefresh.mock.calls[0]![0]).toBe(REAL_VAULT_ID);
    expect(queueIndexRefresh).toHaveBeenCalledWith(REAL_VAULT_ID, saved.id);
  });

  it("moveEntry re-queues BOTH tiers under the new note id", async () => {
    const created = await createNote("wiring-move", "# Wiring Move\n\nmove me", {
      type: "note",
      title: "Wiring Move",
    });
    queueIndexRefresh.mockClear();
    queueSearchIndexRefresh.mockClear();

    const target = `${created.id}-moved`;
    await moveEntry(created.id, target, "note");

    expect(queueSearchIndexRemove).toHaveBeenCalledWith(created.id);
    expect(queueSearchIndexRefresh.mock.calls[0]![0]).toBe(REAL_VAULT_ID);
    expect(queueIndexRefresh).toHaveBeenCalledWith(REAL_VAULT_ID, target);
  });
});

/**
 * Issue #51 — der Löschpfad räumte nur Tier 1 ab. `CombinedProvider.removeNote()`
 * (Tier 1 + `DELETE FROM note_embeddings`) existierte, hatte aber keinen einzigen
 * Aufrufer, also blieben bei jedem Delete/Move verwaiste Vektoren liegen.
 * Diese Fälle nageln das Spiegelbild des Schreibpfads fest.
 */
describe("Issue #51 — Löschen/Verschieben räumt BEIDE Tiers ab", () => {
  it("deleteEntry entfernt die Notiz aus Tier 1 UND Tier 2", async () => {
    const created = await createNote("wiring-delete", "# Wiring Delete\n\nbye", {
      type: "note",
      title: "Wiring Delete",
    });
    queueSearchIndexRemove.mockClear();
    queueIndexRemove.mockClear();

    await deleteEntry(created.id, "note");

    expect(queueSearchIndexRemove).toHaveBeenCalledWith(created.id);
    expect(queueIndexRemove).toHaveBeenCalledWith(REAL_VAULT_ID, created.id);
  });

  it("moveEntry entfernt die ALTE note_id aus Tier 2 und indiziert die neue", async () => {
    const created = await createNote("wiring-move-t2", "# Wiring Move T2\n\nmove me", {
      type: "note",
      title: "Wiring Move T2",
    });
    queueIndexRefresh.mockClear();
    queueIndexRemove.mockClear();

    const target = `${created.id}-moved`;
    await moveEntry(created.id, target, "note");

    // Alte ID raus …
    expect(queueIndexRemove).toHaveBeenCalledWith(REAL_VAULT_ID, created.id);
    // … neue ID rein. Ohne das Remove läge die alte Zeile für immer daneben.
    expect(queueIndexRefresh).toHaveBeenCalledWith(REAL_VAULT_ID, target);
  });

  it("trashEntry (Soft-Delete) entfernt die alte note_id aus Tier 2", async () => {
    const created = await createNote("wiring-trash", "# Wiring Trash\n\ntrash me", {
      type: "note",
      title: "Wiring Trash",
    });
    queueIndexRemove.mockClear();

    const { from, to } = await trashEntry(created.id, new Date("2026-08-14T10:00:00Z"));

    expect(from).toBe(created.id);
    expect(to).toContain("99_archive/_trash/2026-08-14-");
    expect(queueIndexRemove).toHaveBeenCalledWith(REAL_VAULT_ID, created.id);
  });

  it("deleteEntry wirft nicht, wenn die Tier-2-Entfernung fehlschlägt", async () => {
    const created = await createNote("wiring-delete-boom", "# Boom\n\nbye", {
      type: "note",
      title: "Boom",
    });

    // Für DIESEN Fall die echte Implementierung fahren — nur so ist bewiesen,
    // dass `queueIndexRemove` den Provider-Fehler wirklich schluckt.
    queueIndexRemove.mockImplementation((vaultId: string, noteId: string) =>
      actualMemory.queueIndexRemove(vaultId, noteId),
    );
    const removeNote = vi
      .spyOn(CombinedProvider.prototype, "removeNote")
      .mockRejectedValue(new Error("tier2 down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(deleteEntry(created.id, "note")).resolves.toBeDefined();

    // Fire-and-forget: der Provider-Call passiert erst nach dem Microtask-Tick,
    // der Request-Pfad hat also nicht darauf gewartet.
    await new Promise((r) => setTimeout(r, 0));
    expect(removeNote).toHaveBeenCalledWith(created.id);
    expect(logged).toHaveBeenCalled();
  });
});
