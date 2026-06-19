/**
 * Vault registry queries (multi-tenant, M3).
 *
 * Thin read helpers over the `vaults` table so callers outside core (server
 * routes, the MCP HTTP layer) don't reach into drizzle directly. Keeps the
 * DB dependency confined to `@lokyy/core`.
 */
import { eq } from "drizzle-orm";
import { database } from "../db/index.js";
import { vaults, type Vault } from "../db/schema/vaults.js";

/** Fetch a vault by its id, or null when no such row exists. */
export async function getVaultById(id: string): Promise<Vault | null> {
  const rows = await database()
    .select()
    .from(vaults)
    .where(eq(vaults.id, id))
    .limit(1);
  return rows[0] ?? null;
}
