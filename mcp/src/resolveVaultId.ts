import { database, initDb, vaults } from "@lokyy/core";

/**
 * Resolve the vault-id the MCP server should attach to.
 *
 * Resolution order:
 *   1. `LOKYY_VAULT_ID` env-var (explicit override — wins even in multi-vault setups).
 *   2. Single (oldest) row in `vaults` table (the setup wizard always creates one).
 *
 * If the env-var is empty AND the `vaults` table is empty → fatal exit (the
 * deployment is incomplete; the user must finish the Setup Wizard before
 * the MCP server can serve any tools).
 *
 * If multiple rows exist and no env override is set → pick the oldest, warn
 * loudly. Operators with multi-vault deployments are expected to pin a
 * specific id via env.
 *
 * Calls `initDb(databaseUrl)` first; the function is idempotent, so the
 * later `buildServer(...)` call (which also runs `initDb`) is a no-op.
 *
 * Sorting is done in memory to avoid pulling in a direct `drizzle-orm`
 * dependency for a 1-2 row query.
 */
export async function resolveVaultId(databaseUrl: string): Promise<string> {
  const envVaultId = process.env.LOKYY_VAULT_ID?.trim() || "";
  if (envVaultId) {
    console.log(`[lokyy-mcp] vault-id from env: ${envVaultId}`);
    return envVaultId;
  }

  // DB fallback — pick the oldest vault row.
  initDb(databaseUrl);
  const rows = await database()
    .select({ id: vaults.id, slug: vaults.slug, createdAt: vaults.createdAt })
    .from(vaults);

  if (rows.length === 0) {
    console.error(
      "[lokyy-mcp] no vault rows in DB and no LOKYY_VAULT_ID env — cannot serve MCP. Run setup wizard first.",
    );
    process.exit(1);
  }

  // Oldest first — `createdAt` is a Postgres TIMESTAMPTZ; the driver returns Date.
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  if (rows.length > 1) {
    console.warn(
      `[lokyy-mcp] multiple vault rows found (${rows.length}). Picking oldest: ${rows[0].id} (${rows[0].slug}). Set LOKYY_VAULT_ID env to override.`,
    );
  } else {
    console.log(`[lokyy-mcp] vault-id from DB: ${rows[0].id} (${rows[0].slug})`);
  }
  return rows[0].id;
}
