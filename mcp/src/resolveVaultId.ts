import { database, initDb, vaults } from "@lokyy/core";

/**
 * A single vault candidate as seen at resolution time.
 */
export interface VaultCandidate {
  id: string;
  slug: string;
}

/**
 * Machine-readable result of vault-id resolution.
 *
 * `ambiguous` is true ONLY when the DB held more than one vault row AND no
 * `LOKYY_VAULT_ID` env override pinned a specific id. In that case `candidates`
 * lists every vault row found (id + slug), and `vaultId` is the oldest row
 * (the historical "pick oldest" fallback) — but the resolution is flagged so
 * callers like `get_health()` (Story 10.8, wired by the server) can surface a
 * `vault_warning` instead of silently trusting the choice.
 *
 * `source`:
 *   - "env" — pinned via `LOKYY_VAULT_ID` (never ambiguous).
 *   - "db"  — resolved from the `vaults` table.
 */
export interface VaultResolution {
  vaultId: string;
  ambiguous: boolean;
  candidates: VaultCandidate[];
  source: "env" | "db";
}

/**
 * Pure resolution logic — decides the vault-id from an env override + the rows
 * already fetched from the `vaults` table. Kept side-effect-light and free of
 * any DB access so it is unit-testable without a live Postgres.
 *
 * The ONLY side effect is the boot-time warning emitted to stderr (AC#1): when
 * the env override is absent and multiple rows exist, this logs a LOUD,
 * clearly-marked PROBLEM block listing every vault id + the `LOKYY_VAULT_ID`
 * hint. The historical "pick oldest" behaviour is preserved as the fallback
 * `vaultId`, but it is no longer SILENT.
 *
 * Callers must guarantee `rows` is non-empty when `envVaultId` is empty (the
 * async wrapper throws on the empty-DB case before calling this).
 */
export function pickVaultResolution(
  rows: { id: string; slug: string; createdAt: Date }[],
  envVaultId: string,
): VaultResolution {
  if (envVaultId) {
    console.log(`[lokyy-mcp] vault-id from env: ${envVaultId}`);
    return { vaultId: envVaultId, ambiguous: false, candidates: [], source: "env" };
  }

  // Oldest first — `createdAt` is a Postgres TIMESTAMPTZ; the driver returns Date.
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const candidates: VaultCandidate[] = sorted.map((r) => ({ id: r.id, slug: r.slug }));
  const chosen = sorted[0];

  if (sorted.length > 1) {
    const list = sorted
      .map((r, i) => `    ${i === 0 ? "→" : " "} ${r.id} (${r.slug})${i === 0 ? "  [picked: oldest]" : ""}`)
      .join("\n");
    console.error(
      "\n" +
        "════════════════════════════════════════════════════════════════════\n" +
        "  ⚠️  PROBLEM: lokyy-mcp found MULTIPLE vault rows in the DB\n" +
        "════════════════════════════════════════════════════════════════════\n" +
        `  ${sorted.length} vaults exist. Falling back to the OLDEST row, which\n` +
        "  risks silently attaching to the WRONG vault (data-loss hazard).\n\n" +
        "  Candidates:\n" +
        list +
        "\n\n" +
        "  FIX: pin the intended vault explicitly via the env var:\n" +
        `      LOKYY_VAULT_ID=${chosen.id}\n` +
        "════════════════════════════════════════════════════════════════════\n",
    );
    return { vaultId: chosen.id, ambiguous: true, candidates, source: "db" };
  }

  console.log(`[lokyy-mcp] vault-id from DB: ${chosen.id} (${chosen.slug})`);
  return { vaultId: chosen.id, ambiguous: false, candidates, source: "db" };
}

/**
 * Resolve the vault the MCP server should attach to, returning the full
 * machine-readable {@link VaultResolution} (id + ambiguity + candidates).
 *
 * Resolution order:
 *   1. `LOKYY_VAULT_ID` env-var (explicit override — wins even in multi-vault
 *      setups; never ambiguous).
 *   2. Rows in the `vaults` table — oldest wins as a fallback, but a multi-row
 *      DB is flagged `ambiguous: true` and a LOUD warning is emitted.
 *
 * If the env-var is empty AND the `vaults` table is empty this THROWS. It must
 * not terminate the process: a fresh deploy legitimately has an empty DB (the
 * Setup Wizard is what writes the first vault row), and the in-process mount
 * inside the brain has to survive that so the wizard stays reachable. Each
 * caller decides whether the failure is fatal for itself — the standalone CLI
 * entry points (`bin.ts`, `binHttp.ts`) catch this and exit 1.
 *
 * Calls `initDb(databaseUrl)` first; the function is idempotent, so the later
 * `buildServer(...)` call (which also runs `initDb`) is a no-op.
 *
 * Sorting is done in memory to avoid pulling in a direct `drizzle-orm`
 * dependency for a 1-2 row query.
 */
export async function resolveVaultResolution(databaseUrl: string): Promise<VaultResolution> {
  const envVaultId = process.env.LOKYY_VAULT_ID?.trim() || "";

  // Env override short-circuits the DB query entirely.
  if (envVaultId) {
    return pickVaultResolution([], envVaultId);
  }

  initDb(databaseUrl);
  const rows = await database()
    .select({ id: vaults.id, slug: vaults.slug, createdAt: vaults.createdAt })
    .from(vaults);

  if (rows.length === 0) {
    throw new Error(
      "no vault rows in DB and no LOKYY_VAULT_ID env — cannot serve MCP. Run setup wizard first.",
    );
  }

  return pickVaultResolution(rows, "");
}

/**
 * Backward-compatible accessor: returns ONLY the resolved vault-id string.
 *
 * Existing entry points (`bin.ts`, `binHttp.ts`) consume the plain id; they
 * stay unchanged. New consumers that need the ambiguity signal (e.g. the
 * server's `get_health` wiring, Story 10.8) should call
 * {@link resolveVaultResolution} instead.
 */
export async function resolveVaultId(databaseUrl: string): Promise<string> {
  const { vaultId } = await resolveVaultResolution(databaseUrl);
  return vaultId;
}
