import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { vaults } from "./vaults.js";

/**
 * Per-customer MCP bearer tokens (multi-tenant foundation, M3 / LBMT-2).
 *
 * Each customer gets their own isolated vault (own Forgejo repo) and their
 * own bearer token. The token — not a session — decides which vault and with
 * which role an incoming `/mcp` request is bound to:
 *
 *   bearer → SHA-256 → mcp_tokens row → { vault_id, agent_id, role }
 *
 * ## At-rest
 *
 * Only the SHA-256 hex digest of the bearer is stored (`token_hash`). The
 * plaintext bearer is shown to the owner exactly once at creation time and is
 * never persisted — there is no way to recover it, only to revoke + reissue.
 * Lookup hashes the incoming bearer and matches on `token_hash`.
 *
 * ## Fields
 *
 *   agent_id   — the writer identity (e.g. `kunde-<slug>`) matched against the
 *                vault's `00_meta/mcp-scopes.yaml` for folder-level scoping.
 *   role       — coarse capability gate: `read` (read-only tools) or `write`
 *                (read + write tools, still bounded by the scope globs).
 *   revoked_at — non-null = token is dead; lookup ignores revoked rows (→ 401).
 *   last_used_at — best-effort access timestamp, bumped on each successful lookup.
 *
 * FK to `vaults` with ON DELETE CASCADE — dropping a customer vault drops its
 * tokens with it.
 */
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: text("id").primaryKey(), // ULID
    tokenHash: text("token_hash").notNull(), // SHA-256 hex of the bearer; plaintext never at-rest
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(), // e.g. "kunde-<slug>" — matched against mcp-scopes.yaml
    role: text("role").notNull(), // 'read' | 'write'
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("idx_mcp_tokens_token_hash").on(t.tokenHash),
    vaultIdx: index("idx_mcp_tokens_vault").on(t.vaultId),
  }),
);

export type McpToken = typeof mcpTokens.$inferSelect;
export type NewMcpToken = typeof mcpTokens.$inferInsert;
