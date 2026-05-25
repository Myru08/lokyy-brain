#!/usr/bin/env node
import { resolve } from "node:path";
import { buildServer, start } from "./server.js";

/**
 * lokyy-mcp CLI entry point.
 *
 * Required env vars:
 *   LOKYY_DB_URL       — Postgres DSN (same as the server's DATABASE_URL)
 *   LOKYY_VAULT_DIR    — Absolute path to the vault working copy
 *   LOKYY_GIT_REMOTE   — Vault git remote
 *   LOKYY_VAULT_ID     — ULID of the vault (for memory provider keying)
 *   LOKYY_AGENT_ID     — Identity used to look up scope (default: "claude-desktop")
 *
 * Optional:
 *   LOKYY_GIT_BRANCH   — default "main"
 *   LOKYY_GIT_AUTHOR_NAME / _EMAIL — defaults to "lokyy-brain" / "lokyy-brain@localhost"
 */

const databaseUrl = req("LOKYY_DB_URL");
const vaultDir = resolve(req("LOKYY_VAULT_DIR"));
const gitRemote = req("LOKYY_GIT_REMOTE");
const vaultId = req("LOKYY_VAULT_ID");
const agentId = process.env.LOKYY_AGENT_ID ?? "claude-desktop";

const coreConfig = {
  vaultDir,
  gitRemote,
  gitBranch: process.env.LOKYY_GIT_BRANCH ?? "main",
  gitAuthorName: process.env.LOKYY_GIT_AUTHOR_NAME ?? "lokyy-brain",
  gitAuthorEmail: process.env.LOKYY_GIT_AUTHOR_EMAIL ?? "lokyy-brain@localhost",
};

const server = await buildServer(coreConfig, databaseUrl, vaultId, agentId);
await start(server);

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[lokyy-mcp] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}
