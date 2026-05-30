import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { initCore } from "../util/coreConfig.js";
import { ensureRepo } from "../git/gitService.js";
import {
  read,
  write,
  SYSTEM_ITEMS,
  MENU_FILE,
  type MenuItem,
} from "./menuConfig.js";

const exec = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "lokyy-test",
  GIT_AUTHOR_EMAIL: "test@localhost",
  GIT_COMMITTER_NAME: "lokyy-test",
  GIT_COMMITTER_EMAIL: "test@localhost",
};

/**
 * Isolated bare-remote + working-copy pair (same pattern as
 * notesService.test.ts / findByUlid.test.ts). Returns the working-copy path.
 */
async function setupTestVault(): Promise<{
  workdir: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "lokyy-menu-config-"));
  const remote = join(base, "remote");
  const workdir = join(base, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);

  const seed = join(base, "seed");
  await exec("git", ["init", "--initial-branch=main", seed]);
  await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"], {
    env: GIT_ENV,
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
  });
  await ensureRepo();

  return {
    workdir,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

function customItem(over: Partial<MenuItem> = {}): MenuItem {
  return {
    id: "01J0000000000000000000CUST",
    label: "Projekte",
    icon: "folder",
    folder: "20_projects",
    viewType: "tree",
    shortcut: null,
    kind: "custom",
    ...over,
  };
}

let vault: Awaited<ReturnType<typeof setupTestVault>>;

beforeEach(async () => {
  vault = await setupTestVault();
});

afterEach(async () => {
  await vault.cleanup();
});

describe("menuConfig.read — empty vault", () => {
  it("returns only System-Defaults when no file exists", async () => {
    const cfg = await read();
    expect(cfg.version).toBe(1);
    expect(cfg.items).toEqual(SYSTEM_ITEMS);
    // Every returned item from a fresh vault is a system item.
    expect(cfg.items.every((i) => i.kind === "system")).toBe(true);
  });
});

describe("menuConfig.write + read — roundtrip", () => {
  it("persists custom items and merges System-Defaults in front", async () => {
    const custom = customItem({ label: "Notizen", folder: "20_notes" });
    const merged = await write([custom]);

    // write() returns System-Items first, then the custom item.
    expect(merged.items.slice(0, SYSTEM_ITEMS.length)).toEqual(SYSTEM_ITEMS);
    expect(merged.items.at(-1)).toEqual(custom);

    // read() reproduces the same merged shape after a fresh pull.
    const reread = await read();
    expect(reread.items).toEqual([...SYSTEM_ITEMS, custom]);
  });

  it("writes ONLY custom items to the vault file (no System-Items)", async () => {
    await write([customItem()]);
    const onDisk = await readFile(join(vault.workdir, MENU_FILE), "utf8");
    expect(onDisk).toContain("01J0000000000000000000CUST");
    expect(onDisk).not.toContain("system:home");
    expect(onDisk).not.toContain("system:skills");
  });

  it("drops incoming System-Items before persisting", async () => {
    const merged = await write([...SYSTEM_ITEMS, customItem()]);
    // Exactly one custom item survives; System-Items are merged, not persisted.
    expect(merged.items.filter((i) => i.kind === "custom")).toHaveLength(1);

    const onDisk = await readFile(join(vault.workdir, MENU_FILE), "utf8");
    expect(onDisk).not.toContain("system:");
  });
});

describe("menuConfig.read — System merge ordering", () => {
  it("keeps System-Items first and preserves custom order", async () => {
    const a = customItem({ id: "01JAAAAAAAAAAAAAAAAAAAAAAA", label: "A" });
    const b = customItem({ id: "01JBBBBBBBBBBBBBBBBBBBBBBB", label: "B" });
    await write([a, b]);

    const cfg = await read();
    expect(cfg.items.map((i) => i.kind)).toEqual([
      "system",
      "system",
      "custom",
      "custom",
    ]);
    expect(cfg.items.slice(SYSTEM_ITEMS.length).map((i) => i.label)).toEqual([
      "A",
      "B",
    ]);
  });
});

describe("menuConfig.read — resilience", () => {
  it("returns System-Defaults on invalid YAML without throwing", async () => {
    await mkdir(join(vault.workdir, "00_meta"), { recursive: true });
    await writeFile(
      join(vault.workdir, MENU_FILE),
      "version: 1\nitems: [ this : is : not : valid\n",
      "utf8",
    );

    const cfg = await read();
    expect(cfg.items).toEqual(SYSTEM_ITEMS);
  });

  it("returns System-Defaults on schema-invalid content without throwing", async () => {
    await mkdir(join(vault.workdir, "00_meta"), { recursive: true });
    // viewType is not in the closed list → schema rejects it.
    await writeFile(
      join(vault.workdir, MENU_FILE),
      "version: 1\nitems:\n  - id: x\n    label: Bad\n    icon: folder\n    folder: foo\n    viewType: bogus\n    shortcut: null\n    kind: custom\n",
      "utf8",
    );

    const cfg = await read();
    expect(cfg.items).toEqual(SYSTEM_ITEMS);
  });
});

describe("menuConfig.write — validation", () => {
  it("throws when a custom item is malformed", async () => {
    const bad = customItem({ viewType: "nope" as MenuItem["viewType"] });
    await expect(write([bad])).rejects.toThrow();
  });
});
