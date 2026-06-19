/**
 * Per-request MCP session context (multi-tenant, M3 / LBMT-1.3).
 *
 * The MCP server was built single-vault: `initServerDeps` captures one
 * vault-id + scope at boot and every handler closes over that module-level
 * state. Multi-tenant needs each request bound to ITS token's vault + role +
 * folder-scope instead.
 *
 * This is the carrier: the HTTP layer resolves the bearer token to an
 * `McpSession` and runs the request inside `withMcpSession(ctx, …)`. The scope
 * accessors (`scopes.ts`) and the few vault-id/dir reads in `server.ts` then
 * prefer the active session over the boot singleton — so a customer token sees
 * only its vault + its folders, while the legacy static/OAuth path (no session
 * set) keeps the exact old single-vault behaviour.
 *
 * AsyncLocalStorage propagates through the awaited tool-call chain, so handlers
 * (and the core services they call, which already read the ALS-bound
 * `coreConfig()` from LBMT-1.2) all see the same vault for the whole request.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentScope } from "./scopes.js";

/**
 * Coarse capability of a token:
 *   - `owner` — full, unscoped access (the operator's own MCP). Never filtered.
 *   - `write` — read + write, bounded by the vault's folder globs.
 *   - `read`  — read-only, bounded by the folder globs (write tools rejected).
 */
export type McpSessionRole = "owner" | "write" | "read";

export interface McpSession {
  vaultId: string;
  /** Absolute working-copy path for this request's vault. */
  vaultDir: string;
  /** Writer identity (`mcp_tokens.agent_id`), matched against the vault scopes. */
  agentId: string;
  role: McpSessionRole;
  /** Resolved read/write globs for this token (role gate already applied). */
  scope: AgentScope;
}

const store = new AsyncLocalStorage<McpSession>();

/** Run `fn` (and its whole async tree) bound to `ctx`. Nestable. */
export function withMcpSession<T>(ctx: McpSession, fn: () => T): T {
  return store.run(ctx, fn);
}

/** The active session, or `null` when running on the legacy single-vault path. */
export function currentMcpSession(): McpSession | null {
  return store.getStore() ?? null;
}
