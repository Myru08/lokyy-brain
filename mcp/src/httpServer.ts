import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleOAuthRoute, verifyToken, deriveBase } from "./oauth.js";
import {
  lookupMcpToken,
  vaultConfigFor,
  withCoreConfig,
  coreConfig,
  getVaultById,
  type CoreConfig,
} from "@lokyy/core";
import { getActiveVaultId } from "./server.js";
import { resolveScopeFor } from "./scopes.js";
import {
  withMcpSession,
  type McpSession,
  type McpSessionRole,
} from "./sessionContext.js";

/**
 * lokyy-brain MCP HTTP transport (companion to stdio).
 *
 * - Exposes a single POST/GET/DELETE `/mcp` endpoint per the MCP spec.
 * - Auth: Bearer token accepted as either:
 *     1. Legacy static LOKYY_MCP_TOKEN (keeps existing CLI/Desktop header configs working)
 *     2. OAuth-issued access_token JWT (verified via HMAC-SHA256, checked exp+aud)
 * - On 401: includes WWW-Authenticate header with resource_metadata URI (RFC 9728).
 * - OAuth endpoints (/.well-known/*, /register, /authorize, /token) are served
 *   by oauth.ts BEFORE the /mcp block — no auth required on those paths.
 * - Per-client session management via StreamableHTTPServerTransport.
 * - CORS allow-all for browser-based MCP clients.
 *
 * Use cases:
 *   - Remote Claude Desktop instances behind `mcp-remote` bridge
 *   - claude.ai Custom Connector (OAuth flow)
 *   - Self-hosted lokyy-brain on a server, multiple clients per user
 *   - Docker-deployed instance with public ingress
 */

const sessions = new Map<string, StreamableHTTPServerTransport>();

/**
 * Resolve a per-customer registry bearer token (`mcp_tokens`) to its request
 * context (LBMT-1.3). Returns null for unknown/revoked tokens or a missing
 * vault row → the caller 401s and reveals nothing. Builds the vault-bound
 * CoreConfig (LBMT-1.2) + the folder-scope with the role gate applied.
 */
async function resolveRegistrySession(
  bearerToken: string,
): Promise<{ coreConfig: CoreConfig; mcp: McpSession } | null> {
  const ctx = await lookupMcpToken(bearerToken);
  if (!ctx) return null;
  const vault = await getVaultById(ctx.vaultId);
  if (!vault) return null;
  // A token that points at the SINGLETON/personal vault must NOT be rebound to
  // `vaultsRoot/<id>` — that path doesn't exist; the personal vault lives at the
  // boot `VAULT_DIR`. Only real customer vaults live under `vaultsRoot/<id>`.
  const isSingleton = ctx.vaultId === getActiveVaultId();
  const cfg: CoreConfig = isSingleton
    ? coreConfig()
    : vaultConfigFor({
        vaultId: ctx.vaultId,
        gitRemote: vault.gitRemote,
        gitBranch: vault.gitBranch,
      });
  const role = ctx.role as McpSessionRole; // registry role: "read" | "write"
  const scope = await resolveScopeFor(cfg.vaultDir, ctx.agentId, role);
  return {
    coreConfig: cfg,
    mcp: {
      vaultId: ctx.vaultId,
      vaultDir: cfg.vaultDir,
      agentId: ctx.agentId,
      role,
      scope,
    },
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

/**
 * Handle a single MCP HTTP request against the raw Node `req`/`res`. Extracted
 * from the standalone listener so the SAME logic can be mounted INSIDE another
 * Node process (e.g. the brain's Hono app) without spinning up a second
 * `http.createServer`/port — see `inProcess.ts` and the server's `mcpMount.ts`.
 *
 * Writes the full response to `res` (including CORS, auth, session, streaming)
 * and resolves once handed off to the transport. Callers mounting this in Hono
 * must signal "response already sent" so Hono does not write a second time.
 */
export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  serverFactory: () => Server | Promise<Server>,
  token: string,
): Promise<void> {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const oauthHandled = await handleOAuthRoute(req, res);
  if (oauthHandled) return;

  if (!req.url || !req.url.startsWith("/mcp")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not-found", hint: "POST /mcp" }));
    return;
  }

  if (req.url === "/mcp/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  const auth = req.headers["authorization"];
  const bearerToken = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const isLegacyToken = bearerToken === token;
  const isOAuthToken = bearerToken ? verifyToken(bearerToken, "access") : false;

  // Multi-tenant (LBMT-1.3): a bearer that is neither the owner's static token
  // nor an OAuth JWT may be a per-customer registry token → resolve it to its
  // vault + folder-scope. Owner tokens keep full, unscoped access on the boot
  // singleton vault (no session → singleton fallback everywhere).
  let registry: { coreConfig: CoreConfig; mcp: McpSession } | null = null;
  if (bearerToken && !isLegacyToken && !isOAuthToken) {
    registry = await resolveRegistrySession(bearerToken);
  }

  if (!isLegacyToken && !isOAuthToken && !registry) {
    const base = deriveBase(req);
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", error="invalid_token"`,
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // The full session/transport/handleRequest dance. Bound to the request's
  // vault + scope when a registry token is in play; the legacy singleton path
  // otherwise. createServer() (inside serverFactory) reads the active session,
  // so a customer session captures ITS vault; every tool call runs scoped.
  const run = async (): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions.has(sessionId)) {
      transport = sessions.get(sessionId)!;
    } else if (req.method === "POST") {
      // New session — build a FRESH Server for this session. The MCP SDK
      // forbids one Server/Protocol instance from connecting to more than one
      // transport, so every session gets its own instance. The heavy global
      // init (core/db/repo/scopes) already ran once via initServerDeps.
      const sessionServer = await serverFactory();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, transport);
          console.error(`[lokyy-mcp-http] session opened: ${sid}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          console.error(`[lokyy-mcp-http] session closed: ${transport.sessionId}`);
        }
      };
      await sessionServer.connect(transport);
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no-session", hint: "POST to initialize" }));
      return;
    }

    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("[lokyy-mcp-http] request handling failed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal", message: (err as Error).message }));
      }
    }
  };

  if (registry) {
    await withCoreConfig(registry.coreConfig, () =>
      withMcpSession(registry.mcp, run),
    );
  } else {
    await run();
  }
}

export async function startHttpServer(
  serverFactory: () => Server | Promise<Server>,
  port: number,
  token: string,
): Promise<void> {
  if (!token) {
    console.error("[lokyy-mcp-http] LOKYY_MCP_TOKEN required — refusing to start with anonymous access.");
    process.exit(2);
  }

  const http = createServer((req, res) => {
    void handleMcpHttpRequest(req, res, serverFactory, token);
  });

  http.listen(port, () => {
    console.error(`[lokyy-mcp-http] listening on http://localhost:${port}/mcp (bearer + OAuth auth)`);
  });
}
