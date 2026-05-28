import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleOAuthRoute, verifyToken, deriveBase } from "./oauth.js";

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

export async function startHttpServer(
  serverFactory: () => Server | Promise<Server>,
  port: number,
  token: string,
): Promise<void> {
  if (!token) {
    console.error("[lokyy-mcp-http] LOKYY_MCP_TOKEN required — refusing to start with anonymous access.");
    process.exit(2);
  }

  const http = createServer(async (req, res) => {
    setCors(res);

    // ------------------------------------------------------------------
    // OPTIONS preflight — handled globally for CORS; OAuth handler also
    // short-circuits its own paths, so we handle top-level here first.
    // ------------------------------------------------------------------
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    // ------------------------------------------------------------------
    // OAuth endpoints — must be checked BEFORE the /mcp block.
    // handleOAuthRoute returns true if it handled the request.
    // ------------------------------------------------------------------
    const oauthHandled = await handleOAuthRoute(req, res);
    if (oauthHandled) return;

    // ------------------------------------------------------------------
    // Unknown paths (not OAuth, not /mcp*)
    // ------------------------------------------------------------------
    if (!req.url || !req.url.startsWith("/mcp")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not-found", hint: "POST /mcp" }));
      return;
    }

    // ------------------------------------------------------------------
    // Health check — unauthenticated
    // ------------------------------------------------------------------
    if (req.url === "/mcp/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
      return;
    }

    // ------------------------------------------------------------------
    // Auth — Bearer token required on every /mcp request.
    // Accepts: (1) legacy static LOKYY_MCP_TOKEN, (2) OAuth JWT access token.
    // ------------------------------------------------------------------
    const auth = req.headers["authorization"];
    const bearerToken = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const isLegacyToken = bearerToken === token;
    const isOAuthToken = bearerToken ? verifyToken(bearerToken, "access") : false;

    if (!isLegacyToken && !isOAuthToken) {
      const base = deriveBase(req);
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", error="invalid_token"`,
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

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
  });

  http.listen(port, () => {
    console.error(`[lokyy-mcp-http] listening on http://localhost:${port}/mcp (bearer + OAuth auth)`);
  });
}
