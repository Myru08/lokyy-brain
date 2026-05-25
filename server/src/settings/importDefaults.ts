import { getDefaultImportFolder, DEFAULT_IMPORT_FOLDER } from "@lokyy/core";
import type { ImportDefaults } from "@lokyy/shared";

/**
 * Import-Defaults — Lese-Helfer für die `default_import_folder`-Einstellung.
 *
 * Single source of truth ist `@lokyy/core` → `integrationSettings.ts`
 * (Wave 4a Agent G). Wir tunneln den Wert hier nur durch die HTTP-Schicht:
 *
 *   - `resolveDefaultImportFolder()` → roher String, vom Pipe-Route-Handler
 *     verwendet, um Jobs mit korrektem `targetFolder` zu enqueuen
 *   - `getImportDefaults()` → DTO für `GET /api/settings/import-defaults`,
 *     das die PWA beim Mount des Import-Panels abruft
 *
 * Defensiv: schlägt der DB-Lookup fehl (z.B. nach `git pull` aber vor
 * Migration), liefern wir `DEFAULT_IMPORT_FOLDER` ("30_captures") zurück,
 * damit das Import-Panel nicht in eine Setup-Wall läuft. Schweigender
 * Fallback ist hier korrekt — die UI hat keinen sinnvollen Recovery-Pfad
 * außer "nimm den Default".
 */

export async function resolveDefaultImportFolder(): Promise<string> {
  try {
    return await getDefaultImportFolder();
  } catch {
    return DEFAULT_IMPORT_FOLDER;
  }
}

export async function getImportDefaults(): Promise<ImportDefaults> {
  return { defaultImportFolder: await resolveDefaultImportFolder() };
}
