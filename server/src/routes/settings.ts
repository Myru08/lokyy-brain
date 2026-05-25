import { Hono } from "hono";
import { getImportDefaults } from "../settings/importDefaults.js";

/**
 * /api/settings — read-only Endpunkte für PWA-relevante Einstellungen.
 *
 * Aktuell exponiert das nur `default_import_folder` für das Import-Panel
 * (Story 4b). Wave 4a Agent G pflegt diesen Schlüssel in `system_config`;
 * solange das noch nicht passiert ist, antwortet `getImportDefaults`
 * defensiv mit `"30_captures"` — d.h. die PWA crasht nicht, falls der
 * Settings-Agent noch nicht im Tree ist.
 *
 * Schreibzugriff bleibt bewusst draußen — den haben die Admin-Routen
 * (`/api/admin/system-settings/*`).
 */
export const settingsRoutes = new Hono();

// GET /api/settings/import-defaults -> ImportDefaults
settingsRoutes.get("/import-defaults", async (c) => {
  const data = await getImportDefaults();
  return c.json(data);
});
