#!/usr/bin/env node
import { resolve } from "node:path";
import { buildServer, start } from "./server.js";
import { resolveVaultId } from "./resolveVaultId.js";

/**
 * lokyy-mcp CLI entry point.
 *
 * Required env vars:
 *   LOKYY_DB_URL       — Postgres DSN (same as the server's DATABASE_URL)
 *   LOKYY_VAULT_DIR    — Absolute path to the vault working copy
 *   LOKYY_GIT_REMOTE   — Vault git remote
 *   LOKYY_AGENT_ID     — Identity used to look up scope (default: "claude-desktop")
 *
 * Optional:
 *   LOKYY_VAULT_ID     — ULID of the vault (for memory provider keying). When
 *                        empty/absent the server resolves it from the
 *                        `vaults` table at startup.
 *   LOKYY_GIT_BRANCH   — default "main"
 *   LOKYY_GIT_AUTHOR_NAME / _EMAIL — defaults to "lokyy-brain" / "lokyy-brain@localhost"
 */

const databaseUrl = req("LOKYY_DB_URL");
const vaultDir = resolve(req("LOKYY_VAULT_DIR"));
const gitRemote = req("LOKYY_GIT_REMOTE");
const agentId = process.env.LOKYY_AGENT_ID ?? "claude-desktop";

// Resolve vault-id BEFORE building the server. stdio transport doesn't
// accept requests until after `start(server)` runs, so this is a safety
// belt rather than a strict ordering requirement, but it keeps the two
// entry points symmetrical and fails fast on misconfigured deployments.
const vaultId = await resolveVaultId(databaseUrl);

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
