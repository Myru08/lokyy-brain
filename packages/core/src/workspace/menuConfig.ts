/**
 * Sidebar menu configuration — Lokyy-Workspace (Epic 11 / Story 11.1).
 *
 * The sidebar menu is a list of "menu items" = (folder) + (view type). It is
 * split into two regimes:
 *
 *   - SYSTEM items (`kind:"system"`)  → code constants here (SYSTEM_ITEMS).
 *                                        NEVER persisted to the vault.
 *   - CUSTOM items (`kind:"custom"`)  → user-defined, persisted to the vault
 *                                        file `00_meta/sidebar-menu.yaml`.
 *
 * Persistence rules (architecture addendum §1 + §3):
 *   - File:    `00_meta/sidebar-menu.yaml` (synced cross-device via gitService).
 *   - Read:    `git.pull()` first (same pull-first pattern as dataview/queryNotes)
 *              → parse YAML → ajv-validate → merge SYSTEM_ITEMS in front → return.
 *              An invalid/handcrafted file degrades to System-Defaults + a
 *              `console.error` warning — it NEVER throws (Zone-2 resilience).
 *   - Write:   validate → serialize ONLY `kind:"custom"` items → persist via
 *              `gitService.save()` (the single allowed write path — no direct
 *              fs-write, Forgejo is the truth). Commit prefix `workspace:`.
 *
 * O-1 note: `.yaml` in `00_meta/` rides along with the already-committed
 * `00_meta/mcp-scopes.yaml` and `00_meta/schemas/*.json` — the lokyy-vault
 * pre-commit hook validates frontmatter for `.md` only, so a frontmatter-less
 * `.yaml` passes. A `.json` fallback is trivial: swap MENU_FILE's extension and
 * replace the two `yaml` calls with `JSON.parse` / `JSON.stringify`;
 * the schema is identical and `parse()`/`serialize()` are isolated below.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import Ajv, { type ValidateFunction } from "ajv";

import { coreConfig } from "../util/coreConfig.js";
import { pull, save } from "../git/gitService.js";
import menuSchema from "./sidebar-menu.schema.json" with { type: "json" };

// ─── Types (architecture addendum §1, verbatim) ─────────────────────────────

export type ViewType = "tree" | "skills" | "dashboard"; // closed list v1

export interface MenuItem {
  id: string; // ULID for custom items; reserved "system:*" for system items
  label: string;
  icon: string; // lucide-react icon name
  folder: string; // vault-relative path, "" = root
  viewType: ViewType;
  shortcut: string | null;
  kind: "system" | "custom";
}

export interface MenuConfig {
  version: number;
  items: MenuItem[];
}

// ─── System items (addendum §3 — the single source of truth) ────────────────
// Hardcoded, always merged in FIRST, never written to the vault file. The
// reserved `system:*` ids can never collide with ULIDs.

export const SYSTEM_ITEMS: MenuItem[] = [
  {
    id: "system:home",
    label: "Home",
    icon: "home",
    folder: "",
    viewType: "dashboard",
    shortcut: null,
    kind: "system",
  },
  {
    id: "system:skills",
    label: "Skill-Bibliothek",
    icon: "wand-2",
    folder: "70_pai/skills",
    viewType: "skills",
    shortcut: null,
    kind: "system",
  },
];

// ─── Constants ──────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

/** Vault-relative path of the persisted custom-menu file. */
export const MENU_FILE = "00_meta/sidebar-menu.yaml";

/** Commit-message prefix for every menu write (analogous to mcp-scopes). */
const COMMIT_PREFIX = "workspace:";

// ─── Validation (ajv — addendum §1) ─────────────────────────────────────────

const ajv = new Ajv({ allErrors: true, strict: false });
const validateConfig: ValidateFunction = ajv.compile(menuSchema as object);

/** Empty default config (only System-Items get merged on top of it). */
function emptyConfig(): MenuConfig {
  return { version: SCHEMA_VERSION, items: [] };
}

// ─── (De)serialization — the ONLY format-specific code ──────────────────────
// Swapping to a `.json` fallback only touches these two helpers + MENU_FILE.

function parse(raw: string): unknown {
  return parseYaml(raw);
}

function serialize(value: unknown): string {
  return stringifyYaml(value);
}

// ─── Merge / protection (addendum §3) ───────────────────────────────────────

/** Defensive: only keep `kind:"custom"` items; System-Items are never stored. */
function customOnly(items: MenuItem[]): MenuItem[] {
  return items.filter((it) => it.kind === "custom");
}

/** Merge: SYSTEM_ITEMS first (fixed order), then persisted custom items. */
function merge(version: number, custom: MenuItem[]): MenuConfig {
  return { version, items: [...SYSTEM_ITEMS, ...customOnly(custom)] };
}

// ─── Read ─────────────────────────────────────────────────────────────────

/**
 * Read the merged menu config (System-Defaults + persisted custom items).
 *
 * pull → read file → parse → validate → merge. A missing file is normal (a
 * fresh vault has no custom items) and yields System-Defaults only. Any other
 * failure (unreadable/handcrafted/invalid file) logs to `console.error` and
 * degrades to System-Defaults — `read()` never throws.
 */
export async function read(): Promise<MenuConfig> {
  // Pull-first, same as queryNotes/dataview, so cross-device edits are visible.
  try {
    await pull();
  } catch (err) {
    // A failed pull (offline, transient) must not block reading the local copy.
    console.error(
      `[menuConfig] git pull failed before read; using local copy: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const abs = join(coreConfig().vaultDir, MENU_FILE);

  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch (err) {
    // ENOENT is the expected "no custom items yet" case — not an error.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(
        `[menuConfig] could not read ${MENU_FILE}; using System-Defaults: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return merge(SCHEMA_VERSION, []);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    console.error(
      `[menuConfig] invalid YAML in ${MENU_FILE}; using System-Defaults: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return merge(SCHEMA_VERSION, []);
  }

  // An empty/null file parses to null/undefined — treat as "no custom items".
  if (parsed == null) {
    return merge(SCHEMA_VERSION, []);
  }

  if (!validateConfig(parsed)) {
    console.error(
      `[menuConfig] ${MENU_FILE} failed schema validation; using System-Defaults: ${ajv.errorsText(
        validateConfig.errors,
      )}`,
    );
    return merge(SCHEMA_VERSION, []);
  }

  const cfg = parsed as MenuConfig;
  return merge(cfg.version ?? SCHEMA_VERSION, cfg.items);
}

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Persist the given items as the custom-menu file. System-Items are silently
 * dropped (never persisted, addendum §3). The on-disk file is validated before
 * the write, then committed via `gitService.save()` (Forgejo-first; no direct
 * fs-write). Returns the freshly merged config (System + persisted custom).
 *
 * @throws if the resulting custom-only config fails schema validation.
 */
export async function write(customItems: MenuItem[]): Promise<MenuConfig> {
  const custom = customOnly(customItems);
  const toPersist: MenuConfig = { version: SCHEMA_VERSION, items: custom };

  if (!validateConfig(toPersist)) {
    throw new Error(
      `[menuConfig] refusing to write invalid menu config: ${ajv.errorsText(
        validateConfig.errors,
      )}`,
    );
  }

  const body = serialize(toPersist);
  await save(MENU_FILE, body, `${COMMIT_PREFIX} update sidebar menu`);

  return merge(SCHEMA_VERSION, custom);
}
