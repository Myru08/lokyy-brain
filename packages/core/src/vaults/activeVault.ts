/**
 * Deterministic "which vault is active" resolution for the single-process
 * HTTP API (issue #43).
 *
 * The search index and the write/index path both resolve their vault id
 * through {@link import("../util/coreConfig.js").indexVaultId}. When the process
 * was booted WITHOUT an explicit `LOKYY_VAULT_ID` pin (the common local /
 * single-user setup), that function used to fall back to the `"default"`
 * placeholder — a value that is NOT a real `vaults(id)` row, so every Tier-2
 * embedding write bounced off `note_embeddings`' FK while Tier-1 looked healthy
 * ("Treffer fehlen unerklärlich"). Worse, once a SECOND vault row exists (e.g.
 * an accidental second registration) nothing deterministically decided which
 * real vault the index and the search should agree on.
 *
 * This module owns the ONE deterministic rule, identical in spirit to
 * `@lokyy/mcp`'s `pickVaultResolution` (kept as a separate copy because core
 * must not depend on the mcp package — that would be a circular dependency):
 *
 *   1. `LOKYY_VAULT_ID` env pin wins (explicit operator choice).
 *   2. else the single vault row, when exactly one exists.
 *   3. else the OLDEST row by `created_at` (ULID id as a stable tiebreak) — and
 *      the situation is flagged `ambiguous` so callers can surface a warning.
 *
 * The rule is pure ({@link pickActiveVault}) and unit-testable without a DB;
 * {@link selectActiveVault} is the thin async wrapper that reads the rows.
 */
import { database } from "../db/index.js";
import { vaults } from "../db/schema/vaults.js";

/** A vault row as seen at resolution time (only the fields the rule needs). */
export interface ActiveVaultRow {
  id: string;
  createdAt: Date;
}

/** Deterministic outcome of active-vault resolution. */
export interface ActiveVaultSelection {
  /**
   * The chosen vault id, or `null` when no vault exists yet (fresh install,
   * setup wizard not completed). `null` means "keep using the placeholder".
   */
  vaultId: string | null;
  /** true ⇒ >1 vault row AND no env pin — the choice ("oldest") is a guess. */
  ambiguous: boolean;
  /** How the id was chosen — mirrors the mcp resolver's `source`. */
  source: "env" | "db" | "none";
  /** Total number of vault rows seen (for warnings / diagnostics). */
  count: number;
}

/**
 * Pure resolution: pick the active vault id from an env pin + the rows already
 * read from the `vaults` table. No side effects, no DB access — safe to unit
 * test with hand-built rows.
 *
 * `envPin` should already be trimmed; an empty string means "no pin".
 */
export function pickActiveVault(
  rows: ActiveVaultRow[],
  envPin: string,
): ActiveVaultSelection {
  const count = rows.length;

  // 1. Explicit operator pin always wins — never ambiguous, even with N rows.
  if (envPin) {
    return { vaultId: envPin, ambiguous: false, source: "env", count };
  }

  // 2. No vaults yet → let the caller keep the placeholder. Not an error: a
  //    fresh deploy legitimately has an empty table until the setup wizard runs.
  if (count === 0) {
    return { vaultId: null, ambiguous: false, source: "none", count };
  }

  // Oldest first — `created_at` is a Postgres TIMESTAMPTZ (Date). Ties broken
  // by the ULID id, which is itself creation-ordered, so the pick is stable
  // regardless of the DB's row order.
  const sorted = [...rows].sort((a, b) => {
    const dt = a.createdAt.getTime() - b.createdAt.getTime();
    return dt !== 0 ? dt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const chosen = sorted[0]!;

  // 3. One vault → unambiguous. >1 → deterministic (oldest) but flagged.
  return {
    vaultId: chosen.id,
    ambiguous: count > 1,
    source: "db",
    count,
  };
}

/**
 * Resolve the active vault id from the live `vaults` table using
 * {@link pickActiveVault}. Reads `LOKYY_VAULT_ID` from the environment for the
 * pin. Throws only if the DB itself is unreachable — the empty-table case is a
 * normal `{ vaultId: null }` result, not an error.
 */
export async function selectActiveVault(): Promise<ActiveVaultSelection> {
  const envPin = process.env.LOKYY_VAULT_ID?.trim() || "";
  // Env pin short-circuits the query entirely — no DB needed to honour it.
  if (envPin) return pickActiveVault([], envPin);

  const rows = await database()
    .select({ id: vaults.id, createdAt: vaults.createdAt })
    .from(vaults);
  return pickActiveVault(rows, "");
}
