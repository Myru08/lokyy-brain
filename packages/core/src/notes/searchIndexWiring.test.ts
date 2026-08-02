import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

vi.mock("../memory/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/index.js")>();
  return {
    ...actual,
    queueIndexRefresh: (...args: unknown[]) => queueIndexRefresh(...args),
    queueSearchIndexRefresh: (...args: unknown[]) => queueSearchIndexRefresh(...args),
    queueSearchIndexRemove: (...args: unknown[]) => queueSearchIndexRemove(...args),
  };
});

const { initCore } = await import("../util/coreConfig.js");
const { ensureRepo } = await import("../git/gitService.js");
const { createNote, saveNote, moveEntry } = await import("./notesService.js");

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
