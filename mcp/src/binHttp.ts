#!/usr/bin/env node
import { resolve } from "node:path";
import { initServerDeps, createServer } from "./server.js";
import { startHttpServer } from "./httpServer.js";
import { resolveVaultId } from "./resolveVaultId.js";

/**
 * lokyy-brain MCP — HTTP variant.
 *
 * Required env:
 *   LOKYY_MCP_TOKEN     — bearer token clients must send
 *   LOKYY_DB_URL, LOKYY_VAULT_DIR, LOKYY_GIT_REMOTE
 *   LOKYY_AGENT_ID       — default "claude-code"
 * Optional:
 *   LOKYY_VAULT_ID       — explicit override; when empty/absent the server
 *                          resolves it from the `vaults` table at startup.
 *   LOKYY_MCP_HTTP_PORT  — default 8788
 */

const port = Number(process.env.LOKYY_MCP_HTTP_PORT ?? 8788);
const token = process.env.LOKYY_MCP_TOKEN ?? "";

const databaseUrl = req("LOKYY_DB_URL");
const vaultDir = resolve(req("LOKYY_VAULT_DIR"));
const gitRemote = req("LOKYY_GIT_REMOTE");
const agentId = process.env.LOKYY_AGENT_ID ?? "claude-code";

// Resolve vault-id BEFORE building the server (and BEFORE the HTTP listener
// goes up) — the MCP tools key the memory provider by vault-id, so we
// cannot accept any request before this completes.
const vaultId = await resolveVaultId(databaseUrl);

const coreConfig = {
  vaultDir,
  gitRemote,
  gitBranch: process.env.LOKYY_GIT_BRANCH ?? "main",
  gitAuthorName: process.env.LOKYY_GIT_AUTHOR_NAME ?? "lokyy-brain",
  gitAuthorEmail: process.env.LOKYY_GIT_AUTHOR_EMAIL ?? "lokyy-brain@localhost",
};

// One-time global init (core/db/repo/scopes + capture vault-id). Then pass a
// factory so each MCP session gets its OWN Server instance — the SDK forbids
// one Server connecting to multiple transports, and claude.ai opens many
// sessions over a connector's lifetime (reconnects, new chats, token refresh).
await initServerDeps(coreConfig, databaseUrl, vaultId, agentId);
await startHttpServer(() => createServer(), port, token);

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[lokyy-mcp-http] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}
