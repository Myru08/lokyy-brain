/**
 * MCP token registry — hash, lookup, lifecycle (multi-tenant foundation, M3).
 *
 * The `/mcp` endpoint is shared by every customer; the bearer token is what
 * routes a request to its isolated vault + role:
 *
 *   bearer → hashMcpToken() → mcp_tokens row → { vaultId, agentId, role }
 *
 * Only the SHA-256 hex of the bearer is ever stored. `generateMcpToken()`
 * mints a fresh URL-safe bearer that is returned to the owner ONCE (at
 * creation) and never persisted in plaintext — recovery is impossible by
 * design; the only remedy for a lost token is revoke + reissue.
 *
 * This module is the data layer only. Wiring it into the request path (Bearer
 * → vault binding + read/write enforcement) is LBMT-3; provisioning a customer
 * (repo + clone + token + scope) is LBMT-4. Until then the legacy static
 * `LOKYY_MCP_TOKEN` path in `mcp/src/httpServer.ts` stays untouched, so this
 * change is additive and backward-compatible.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { database } from "../db/index.js";
import { mcpTokens, type McpToken } from "../db/schema/mcpTokens.js";
import { generateUlid } from "../frontmatter/index.js";

export type McpRole = "read" | "write";

/** Human-recognisable prefix so a leaked bearer is greppable / identifiable. */
export const MCP_TOKEN_PREFIX = "lokyy_mcp_";

/**
 * The placeholder bearer `docker-compose.local.yml` falls back to when the
 * operator never set `LOKYY_MCP_TOKEN`. It is committed to the PUBLIC repo, so
 * every installation that keeps it shares one publicly-known secret.
 *
 * Story 7.10 AC#7 — it stays ACCEPTED (rejecting it would lock out every
 * existing install mid-flight, and the OAuth consent password falls back to the
 * same env var), but callers can detect it via `isSharedDefaultMcpToken()` and
 * surface it as insecure with a one-click path to a real, DB-backed token.
 */
export const SHARED_DEFAULT_MCP_TOKEN = "local_dev_token_change_me_32_chars_min";

/** True when `value` is the publicly-known default bearer (see above). */
export function isSharedDefaultMcpToken(value: string | undefined | null): boolean {
  return (value ?? "").trim() === SHARED_DEFAULT_MCP_TOKEN;
}

/** Resolved per-request identity a bearer maps to. */
export interface McpTokenContext {
  tokenId: string;
  vaultId: string;
  agentId: string;
  role: McpRole;
}

/** SHA-256 hex of the raw bearer. The only form ever persisted. */
export function hashMcpToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Mint a fresh, URL-safe bearer. Shown to the owner once, then only its hash lives on. */
export function generateMcpToken(): string {
  return MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * Resolve a raw bearer to its vault + role context.
 *
 * Returns `null` for an unknown OR revoked token — callers MUST treat `null`
 * as 401 and reveal nothing. On a hit, `last_used_at` is bumped best-effort
 * (fire-and-forget; a bump failure never blocks the request).
 */
export async function lookupMcpToken(
  rawToken: string,
): Promise<McpTokenContext | null> {
  if (!rawToken) return null;
  const tokenHash = hashMcpToken(rawToken);
  const rows = await database()
    .select()
    .from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, tokenHash), isNull(mcpTokens.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  void touchMcpToken(row.id);
  return {
    tokenId: row.id,
    vaultId: row.vaultId,
    agentId: row.agentId,
    role: row.role as McpRole,
  };
}

/** Best-effort `last_used_at` bump. Swallows errors — auditing must never break auth. */
export async function touchMcpToken(id: string): Promise<void> {
  try {
    await database()
      .update(mcpTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpTokens.id, id));
  } catch {
    // best-effort only
  }
}

export interface CreateMcpTokenInput {
  vaultId: string;
  agentId: string;
  role: McpRole;
  label?: string;
}

/**
 * Create a token row and return BOTH the stored row and the one-time plaintext
 * bearer. The caller is responsible for handing the plaintext to the owner
 * immediately — it cannot be retrieved again.
 */
export async function createMcpToken(
  input: CreateMcpTokenInput,
): Promise<{ token: string; row: McpToken }> {
  const token = generateMcpToken();
  const id = generateUlid();
  const [row] = await database()
    .insert(mcpTokens)
    .values({
      id,
      tokenHash: hashMcpToken(token),
      vaultId: input.vaultId,
      agentId: input.agentId,
      role: input.role,
      label: input.label ?? null,
    })
    .returning();
  return { token, row };
}

/** Soft-revoke: sets `revoked_at`, after which `lookupMcpToken` returns null (→ 401). */
export async function revokeMcpToken(id: string): Promise<void> {
  await database()
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(eq(mcpTokens.id, id));
}

/** All tokens for a vault (dashboard listing). Includes revoked rows so the UI can show history. */
export async function listMcpTokens(vaultId: string): Promise<McpToken[]> {
  return database()
    .select()
    .from(mcpTokens)
    .where(eq(mcpTokens.vaultId, vaultId));
}
