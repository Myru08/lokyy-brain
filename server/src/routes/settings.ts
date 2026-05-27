import { Hono } from "hono";
import { database, vaults, getTimezone } from "@lokyy/core";
import { config } from "../config.js";
import { getImportDefaults } from "../settings/importDefaults.js";

/**
 * /api/settings — read-only Endpunkte für PWA-relevante Einstellungen.
 *
 * - `import-defaults` — `default_import_folder` für das Import-Panel
 *   (Story 4b). Wave 4a Agent G pflegt diesen Schlüssel in `system_config`;
 *   solange das noch nicht passiert ist, antwortet `getImportDefaults`
 *   defensiv mit `"30_captures"`.
 * - `runtime` — konsolidierte Laufzeit-Werte (Vault + env). Eine einzige
 *   Quelle der Wahrheit für die Settings-PWA: damit die GIT_REMOTE, der
 *   Ollama-Host und die MCP-Public-URL nicht aus drei verschiedenen
 *   Endpunkten zusammengewürfelt werden.
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

/**
 * GET /api/settings/runtime — runtime config for the PWA Settings page.
 *
 * Returns the active vault (id / name / slug / git remote / branch) plus
 * the env-derived runtime hosts AND the persisted display-timezone:
 *
 *   - `databaseHost`     host:port part of DATABASE_URL only, NEVER the password
 *   - `ollamaHost`       process.env.OLLAMA_HOST (defaults to localhost:11434)
 *   - `mcpPublicUrl`     full https URL incl `/mcp` suffix, derived from
 *                        SERVICE_FQDN_LOKYY_MCP. Falls back to the legacy
 *                        LOKYY_PUBLIC_HOST + LOKYY_MCP_HTTP_PORT shape so
 *                        existing deployments keep working.
 *   - `system.timezone`  IANA timezone string from `system_config[timezone]`,
 *                        defaults to `"UTC"` when unset or unreadable. Single
 *                        source of truth for date formatting in the PWA — the
 *                        Settings page consumes this so the round-trip to
 *                        `/api/system/timezone` is no longer required just to
 *                        render times consistently.
 *
 * `vault` is `null` when no vault row exists yet (pre-setup) — the PWA
 * Setup-Wizard surfaces the same state via /api/setup, this endpoint
 * mirrors it for the live Settings page.
 *
 * `system` is additive — pre-existing consumers that destructured only
 * `vault` / `env` keep working unchanged.
 */
settingsRoutes.get("/runtime", async (c) => {
  const vaultRows = await database().select().from(vaults).limit(1);
  const v = vaultRows[0];

  // `getTimezone` already swallows DB / validation failures and returns
  // `"UTC"`. Wrap defensively anyway so any future import-time / DB-init
  // surprise still produces a valid response shape rather than a 500.
  let timezone = "UTC";
  try {
    timezone = await getTimezone();
  } catch {
    timezone = "UTC";
  }

  return c.json({
    vault: v
      ? {
          id: v.id,
          name: v.name,
          slug: v.slug,
          gitRemote: v.gitRemote,
          gitBranch: v.gitBranch,
        }
      : null,
    env: {
      databaseHost: hostFromDsn(config.databaseUrl),
      ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
      mcpPublicUrl: buildMcpPublicUrl(),
    },
    system: {
      timezone,
    },
  });
});

/**
 * Extract `host:port/db` from a DSN, dropping `user:password@`.
 *
 * Returns the host portion as `host[:port][/db]` — no scheme, no credentials.
 * If parsing fails (malformed DSN), returns `"<unparseable>"` rather than
 * leaking the raw string.
 */
function hostFromDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    const port = url.port ? `:${url.port}` : "";
    const db = url.pathname && url.pathname !== "/" ? url.pathname : "";
    return `${url.hostname}${port}${db}`;
  } catch {
    return "<unparseable>";
  }
}

/**
 * Build the public MCP endpoint URL.
 *
 * Preferred input: `SERVICE_FQDN_LOKYY_MCP` (just the FQDN, e.g.
 * `lokyy-mcp.example.com`) — Coolify/Dokploy-style — which we wrap into
 * `https://<fqdn>/mcp`. Strips any accidental scheme prefix and trailing
 * slash so the caller can paste either form.
 *
 * Fallback: legacy `LOKYY_PUBLIC_HOST` + `LOKYY_MCP_HTTP_PORT` (plain HTTP,
 * used by the local-dev setup wizard).
 */
function buildMcpPublicUrl(): string {
  const fqdn = process.env.SERVICE_FQDN_LOKYY_MCP;
  if (fqdn && fqdn.trim().length > 0) {
    const stripped = fqdn.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `https://${stripped}/mcp`;
  }
  const host = process.env.LOKYY_PUBLIC_HOST ?? "localhost";
  const port = Number(process.env.LOKYY_MCP_HTTP_PORT ?? 8788);
  return `http://${host}:${port}/mcp`;
}
