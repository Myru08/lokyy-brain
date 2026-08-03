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
 * Auth: two equal paths (Story 7.10) —
 *   1. DB-backed tokens from Einstellungen → MCP (`mcp_tokens`, resolved per
 *      request → take effect immediately, no restart), and
 *   2. the legacy static bearer `LOKYY_MCP_TOKEN`.
 *
 * The endpoint therefore stays ENABLED when no env token is configured: an
 * install can (and should) run on its own generated tokens instead of the
 * shared default that ships in the public compose file. With an empty env
 * token the legacy comparison is disabled outright — see `isLegacyBearer`.
 */

const token = process.env.LOKYY_MCP_TOKEN ?? "";
let ready = false;
/**
 * Shared in-flight init promise (Story 7.11 / issue #14 AC#4). A bare boolean
 * would not do: the lazy retry below can be entered by several concurrent
 * requests before the first `await` resolves, and each would run a second
 * `initServerDeps`. Every caller awaits THIS promise instead, so an init runs
 * at most once at a time. It is cleared on settle, so a failed attempt (empty
 * DB, DB not up yet) can be retried by a later request — that retry is exactly
 * what makes the endpoint go live after the wizard.
 */
let initInFlight: Promise<void> | null = null;
/** Throttles the lazy-retry warning so an unconfigured install can't spam the log. */
let lastLazyWarnAt = 0;

/**
 * 503 body for an install that has no vault yet (AC#3). Named after the wizard
 * on purpose — this is the one message an operator sees when the endpoint is
 * genuinely not serviceable, and it has to say what to do about it.
 */
const UNAVAILABLE_BODY = {
  error: "mcp-unavailable",
  message:
    "Kein Vault vorhanden — /mcp kann nichts ausliefern. Bitte zuerst den Setup-Wizard abschließen.",
} as const;

/**
 * The actual init work: resolve the vault-id and wire core/db/repo/scopes for
 * the MCP tool handlers. Reuses the brain's own config (NOT separate LOKYY_*
 * vars). Never call directly — go through {@link initMcp}, which owns the
 * single-flight guard.
 */
async function runInit(): Promise<void> {
  if (!token) {
    console.warn(
      "[mcp-mount] LOKYY_MCP_TOKEN not set — /mcp accepts DB-backed tokens only (Einstellungen → MCP).",
    );
  }
  const envVaultId = process.env.LOKYY_VAULT_ID;
  const vaultId =
    envVaultId && envVaultId.length > 0
      ? envVaultId
      : await resolveVaultId(config.databaseUrl);
  const coreConfig = {
    vaultDir: config.vaultDir,
    gitRemote: config.gitRemote,
    gitBranch: config.gitBranch,
    gitAuthorName: config.gitAuthorName,
    gitAuthorEmail: config.gitAuthorEmail,
    // Story 5.8 AC#2: pass the ALREADY-resolved id through to core so
    // notesService indexes into the same vault the MCP tools read from. This
    // reuses the existing resolution above — it does not add or change any
    // fallback logic.
    vaultId,
  };
  const agentId = process.env.LOKYY_AGENT_ID ?? "claude-code";
  await initServerDeps(coreConfig, config.databaseUrl, vaultId, agentId);
  ready = true;
  console.log(`[mcp-mount] MCP mounted at /mcp (vault ${vaultId})`);
}

/**
 * MCP init, single-flight. Called at boot by `index.ts` (best-effort, a
 * rejection must NOT abort startup) and lazily by the `/mcp` handler while the
 * mount is not ready.
 *
 * Resolves immediately once ready; concurrent callers share one attempt.
 * Rejects with the underlying error so the boot path keeps logging the real
 * reason ("no vault rows in DB … Run setup wizard first").
 */
export function initMcp(): Promise<void> {
  if (ready) return Promise.resolve();
  if (!initInFlight) {
    // `.finally` clears the slot on settle — success leaves `ready === true`
    // so the guard above short-circuits, failure allows a later retry.
    initInFlight = runInit().finally(() => {
      initInFlight = null;
    });
  }
  return initInFlight;
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
    if (!ready) {
      // Lazy re-init (Story 7.11 / issue #14): on a fresh install the boot-time
      // init ran against an empty DB and failed. Retry here so the endpoint
      // goes live as soon as the setup wizard has written the vault row — the
      // wizard shows a freshly minted token and promises it works WITHOUT a
      // restart. Best-effort: a still-failing init leaves the 503 below intact.
      try {
        await initMcp();
      } catch (err) {
        const now = Date.now();
        if (now - lastLazyWarnAt > 60_000) {
          lastLazyWarnAt = now;
          console.warn(
            `[mcp-mount] /mcp requested but MCP not initialised — ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    if (!ready) {
      return c.json(UNAVAILABLE_BODY, 503);
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
