import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context, Hono } from "hono";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { config } from "./config.js";
// Subpath imports into the @lokyy/mcp package (no "exports" map → allowed). The
// MCP SDK + per-session Server factory stay INSIDE that package; the brain only
// touches SDK-free signatures here, so it needs no direct SDK dependency.
import { initServerDeps } from "@lokyy/mcp/dist/server.js";
import { resolveVaultId } from "@lokyy/mcp/dist/resolveVaultId.js";
import { handleMcpHttp } from "@lokyy/mcp/dist/inProcess.js";

/**
 * In-process MCP mount (replaces the separate `lokyy-mcp` container, which
 * over-committed the box's RAM and crashed the brain). The MCP Streamable-HTTP
 * transport is served on the brain's OWN Hono listener at `/mcp`, reachable on
 * the brain's public domain — one process, no extra container, no second port.
 *
 * Auth: static bearer `LOKYY_MCP_TOKEN` (what the customer pastes into their
 * AI's MCP/connector config). When the token is unset the endpoint is disabled.
 */

const token = process.env.LOKYY_MCP_TOKEN ?? "";
let ready = false;

/**
 * One-time MCP init: resolve the vault-id and wire core/db/repo/scopes for the
 * MCP tool handlers. Reuses the brain's own config (NOT separate LOKYY_* vars).
 * Best-effort — a failure here must NOT abort brain startup.
 */
export async function initMcp(): Promise<void> {
  if (!token) {
    console.warn("[mcp-mount] LOKYY_MCP_TOKEN not set — /mcp endpoint disabled.");
    return;
  }
  const coreConfig = {
    vaultDir: config.vaultDir,
    gitRemote: config.gitRemote,
    gitBranch: config.gitBranch,
    gitAuthorName: config.gitAuthorName,
    gitAuthorEmail: config.gitAuthorEmail,
  };
  const envVaultId = process.env.LOKYY_VAULT_ID;
  const vaultId =
    envVaultId && envVaultId.length > 0
      ? envVaultId
      : await resolveVaultId(config.databaseUrl);
  const agentId = process.env.LOKYY_AGENT_ID ?? "claude-code";
  await initServerDeps(coreConfig, config.databaseUrl, vaultId, agentId);
  ready = true;
  console.log(`[mcp-mount] MCP mounted at /mcp (vault ${vaultId})`);
}

/**
 * Register the `/mcp` routes on the brain's Hono app. MUST be called BEFORE the
 * static-PWA catch-all (`app.get("*", …)`) or the SPA fallback would swallow
 * `/mcp`. Hands the raw Node req/res (provided by @hono/node-server via
 * `c.env`) to the MCP transport, then signals RESPONSE_ALREADY_SENT so Hono
 * does not write a second response.
 */
export function mountMcp(app: Hono): void {
  const handler = async (c: Context) => {
    if (!ready || !token) {
      return c.json({ error: "mcp-unavailable" }, 503);
    }
    const env = c.env as { incoming?: IncomingMessage; outgoing?: ServerResponse };
    const incoming = env.incoming;
    const outgoing = env.outgoing;
    if (!incoming || !outgoing) {
      return c.json({ error: "mcp-no-raw-io" }, 500);
    }
    await handleMcpHttp(incoming, outgoing, token);
    // @hono/node-server sentinel: the transport already wrote to `outgoing`.
    return RESPONSE_ALREADY_SENT as unknown as Response;
  };
  app.all("/mcp", handler);
  app.all("/mcp/*", handler);
}
