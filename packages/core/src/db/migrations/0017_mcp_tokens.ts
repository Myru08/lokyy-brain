/**
 * mcp_tokens — per-customer MCP bearer tokens (multi-tenant foundation, M3).
 *
 * Only the SHA-256 hex of the bearer is stored; the plaintext is shown once at
 * creation and never persisted. A request's bearer hashes to a row that pins
 * the vault + role it may act on. Unique on `token_hash` (one row per token);
 * indexed on `vault_id` for the dashboard's per-vault token listing. FK to
 * `vaults` ON DELETE CASCADE so dropping a customer vault drops its tokens.
 *
 * `role` is constrained to read|write at the DB level so a bad insert fails
 * fast rather than silently granting an undefined capability.
 */
export const migration0017McpTokens = `
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  vault_id      TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('read', 'write')),
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_tokens_token_hash ON mcp_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_vault ON mcp_tokens (vault_id);
`;
