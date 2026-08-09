import type { Hono } from "hono";
import { requireAuth } from "./auth.js";
import { setupGate } from "./setupGate.js";

/**
 * Session sweep over every data-bearing `/api` prefix (Story
 * „Session-Auth-Sweep", issue #37).
 *
 * Before this module the data routes carried `setupGate` ONLY: once setup was
 * complete, anyone who could reach the port could read notes, walk the graph,
 * list the vault tree and hit the write routes. A beta tester found it by
 * curling his own box without a cookie and getting 200s back with note bodies.
 *
 * The table below is the single place that answers "is this prefix behind a
 * login?". Adding a route group means adding it here — `apiGuards.test.ts`
 * reads `app.ts` and fails if a mounted `/api` prefix is neither listed here
 * nor in {@link OPEN_API_PREFIXES}, so a forgotten entry is a red test, not a
 * silent hole.
 */

/**
 * Prefixes that require a valid `lokyy_session` AND completed setup.
 *
 * Both the bare prefix (`/api/notes`) and its subtree (`/api/notes/*`) get the
 * guards — Hono treats those as two different patterns, and `GET /api/notes`
 * is exactly the request that leaked.
 */
export const GUARDED_API_PREFIXES = [
  "/api/notes",
  "/api/vault",
  "/api/graph",
  "/api/pipes",
  "/api/llm",
  "/api/diagnostics",
  "/api/logs",
  "/api/scoring",
  "/api/intent",
  "/api/hyde",
  "/api/self-rag",
  "/api/traces",
  "/api/sleep-agent",
  "/api/backfill",
  "/api/mem0",
  "/api/ppr",
  "/api/rerank",
  "/api/surface",
  "/api/working-memory",
  "/api/layout",
  "/api/encoding",
  "/api/edges",
  "/api/temporal-edges",
  "/api/lint",
  "/api/agent-review",
  "/api/entities",
  "/api/peers",
  "/api/skills",
  "/api/search",
  "/api/dataview",
  "/api/templates",
  "/api/voice",
  "/api/system",
  "/api/workspace",
  "/api/dashboard",
  "/api/settings",
] as const;

/**
 * Prefixes that stay reachable without a session — each for a reason that only
 * holds because the endpoint itself is either public by nature or brings its
 * own, stricter check. The drift guard in `apiGuards.test.ts` consults this
 * list, so anything added here is a deliberate, reviewed decision.
 *
 * - `/health` — liveness. The updater sidecar polls it during a restart
 *   (`LOKYY_UPDATER_HEALTH_URL`, default `http://lokyy-brain:8787/health`);
 *   putting a login in front would break every update.
 * - `/api/setup` — runs BEFORE the first user exists. There is no session to
 *   demand yet. `POST /api/setup/*` is self-limiting: `isSetupComplete()`
 *   closes the wizard once it has run.
 * - `/api/auth` — login/register/logout/me. Demanding a session to obtain one
 *   is a deadlock. `/me` answers its own 401.
 * - `/api/auth/forgejo`, `/api/forgejo` — the OAuth wizard, by design usable
 *   before setup completes. Every handler in `forgejoOauth.ts` calls
 *   `requireUser(c)` itself and answers 401 without it.
 * - `/api/tenants` — `requireAdmin` inside `tenants.ts` (stricter than
 *   `requireAuth`; stacking both would only cost a second session lookup).
 * - `/api/vaults` — `requireAuth` inside `vaults.ts`, applied to `*`.
 * - `/api/admin` — `requireAdmin` inside `admin.ts`, applied to `*`. Same
 *   reasoning as `/api/tenants`; it keeps `setupGate` in `app.ts`.
 * - `/mcp` — bearer token per request (DB-backed `mcp_tokens` or the legacy
 *   `LOKYY_MCP_TOKEN`). Cookie auth does not apply and must not be added:
 *   claude.ai connects with a token, never with a browser session.
 */
export const OPEN_API_PREFIXES = [
  "/health",
  "/api/setup",
  "/api/auth",
  "/api/forgejo",
  "/api/tenants",
  "/api/vaults",
  "/api/admin",
  "/mcp",
] as const;

/**
 * Install the guards. MUST run before the route groups are mounted — Hono
 * dispatches middleware and handlers in registration order, so a `use()` added
 * after a `route()` never sees that route's requests.
 *
 * Order within a prefix is `requireAuth` THEN `setupGate`, and that order is
 * load-bearing twice over:
 *
 *   1. An anonymous caller gets 401 without a single database query — the
 *      session cookie is missing, so `requireAuth` short-circuits before
 *      `isSetupComplete()` would hit Postgres. An unauthenticated request now
 *      costs nothing, and the setup state of the box stops being something a
 *      stranger can probe.
 *   2. 401 lands before ANY handler runs, which is what makes
 *      `PUT /api/notes/x.md` with a broken body answer 401 instead of 400 —
 *      body validation is not a thing unauthenticated callers get to reach.
 */
export function applyApiGuards(app: Hono): void {
  for (const prefix of GUARDED_API_PREFIXES) {
    app.use(prefix, requireAuth, setupGate);
    app.use(`${prefix}/*`, requireAuth, setupGate);
  }
}
