#!/usr/bin/env node
import { resolve } from "node:path";
import { buildServer } from "./server.js";
import { startHttpServer } from "./httpServer.js";

/**
 * lokyy-brain MCP — HTTP variant.
 *
 * Required env:
 *   LOKYY_MCP_TOKEN     — bearer token clients must send
 *   LOKYY_DB_URL, LOKYY_VAULT_DIR, LOKYY_GIT_REMOTE, LOKYY_VAULT_ID
 *   LOKYY_AGENT_ID       — default "claude-code"
 * Optional:
 *   LOKYY_MCP_HTTP_PORT  — default 8788
 */

const port = Number(process.env.LOKYY_MCP_HTTP_PORT ?? 8788);
const token = process.env.LOKYY_MCP_TOKEN ?? "";

const databaseUrl = req("LOKYY_DB_URL");
const vaultDir = resolve(req("LOKYY_VAULT_DIR"));
const gitRemote = req("LOKYY_GIT_REMOTE");
const vaultId = req("LOKYY_VAULT_ID");
const agentId = process.env.LOKYY_AGENT_ID ?? "claude-code";

const coreConfig = {
  vaultDir,
  gitRemote,
  gitBranch: process.env.LOKYY_GIT_BRANCH ?? "main",
  gitAuthorName: process.env.LOKYY_GIT_AUTHOR_NAME ?? "lokyy-brain",
  gitAuthorEmail: process.env.LOKYY_GIT_AUTHOR_EMAIL ?? "lokyy-brain@localhost",
};

const server = await buildServer(coreConfig, databaseUrl, vaultId, agentId);
await startHttpServer(server, port, token);

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[lokyy-mcp-http] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}
