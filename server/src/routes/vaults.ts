import { Hono } from "hono";
import { database, vaults } from "@lokyy/core";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * Owner vault list for the main-UI switcher (LBMT-C). Returns every vault the
 * operator owns, with `kind` (personal | shared | company) so the PWA can group
 * them into „Eigene / Mandanten / Firma", and flags which is the default
 * singleton (the personal vault at `vaultDir` — selecting it means „no rebind").
 */
export const vaultsRoutes = new Hono();

// Logged-in only — the vault switcher lists vaults the operator can open.
vaultsRoutes.use("*", requireAuth);

vaultsRoutes.get("/", async (c) => {
  const rows = await database().select().from(vaults);
  return c.json({
    defaultVaultId: config.lokyyVaultId,
    vaults: rows.map((v) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      kind: v.kind,
      isDefault: v.id === config.lokyyVaultId,
    })),
  });
});
