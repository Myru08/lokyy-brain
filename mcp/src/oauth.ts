/**
 * oauth.ts — Minimal OAuth 2.1 authorization layer for lokyy-brain MCP server.
 *
 * Implements:
 *   - RFC 9728  /.well-known/oauth-protected-resource
 *   - RFC 8414  /.well-known/oauth-authorization-server
 *   - RFC 7591  POST /register (Dynamic Client Registration)
 *   - GET/POST  /authorize  (consent page + code mint)
 *   - POST      /token      (authorization_code + refresh_token)
 *
 * Token strategy: stateless HS256 JWT via node:crypto (no external dep).
 * Client registry and auth-code store: in-memory Maps (ephemeral, restart-safe
 * for live connections because tokens are stateless).
 *
 * Config:
 *   LOKYY_PUBLIC_MCP_URL       — explicit base URL override
 *   LOKYY_OAUTH_PASSWORD       — consent password (default: LOKYY_MCP_TOKEN)
 *   LOKYY_OAUTH_SIGNING_SECRET — JWT signing secret  (default: "derived:" + LOKYY_MCP_TOKEN)
 */

import { createHmac, randomBytes, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Helpers — base64url
// ---------------------------------------------------------------------------

function b64uEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64uDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

// ---------------------------------------------------------------------------
// Compact HS256 JWT — no external dep
// ---------------------------------------------------------------------------

interface JwtPayload {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  typ: "access" | "refresh";
}

function signingSecret(): string {
  return (
    process.env.LOKYY_OAUTH_SIGNING_SECRET ??
    "derived:" + (process.env.LOKYY_MCP_TOKEN ?? "")
  );
}

export function issueToken(
  base: string,
  typ: "access" | "refresh",
): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = typ === "access" ? now + 3600 : now + 30 * 24 * 3600;
  const header = b64uEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64uEncode(
    Buffer.from(
      JSON.stringify({
        iss: base,
        aud: `${base}/mcp`,
        sub: "lokyy-owner",
        iat: now,
        exp,
        typ,
      } satisfies JwtPayload),
    ),
  );
  const sig = b64uEncode(
    createHmac("sha256", signingSecret())
      .update(`${header}.${payload}`)
      .digest(),
  );
  return `${header}.${payload}.${sig}`;
}

export function verifyToken(token: string, expectedTyp: "access" | "refresh"): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [header, payload, sig] = parts;
    // Verify signature
    const expected = b64uEncode(
      createHmac("sha256", signingSecret())
        .update(`${header}.${payload}`)
        .digest(),
    );
    if (sig !== expected) return false;
    // Verify claims
    const claims = JSON.parse(b64uDecode(payload).toString("utf8")) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now) return false;
    if (claims.typ !== expectedTyp) return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  clientIdIssuedAt: number;
}

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number; // Unix ms
}

const clients = new Map<string, RegisteredClient>();
const codes = new Map<string, AuthCode>();

// Periodic cleanup of expired codes (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, code] of codes) {
    if (code.expiresAt < now) codes.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Base URL derivation
// ---------------------------------------------------------------------------

export function deriveBase(req: IncomingMessage): string {
  if (process.env.LOKYY_PUBLIC_MCP_URL) {
    return process.env.LOKYY_PUBLIC_MCP_URL.replace(/\/+$/, "");
  }
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ??
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    (req.headers["host"] as string | undefined) ??
    "localhost";
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// PKCE verification
// ---------------------------------------------------------------------------

function verifyPkce(verifier: string, challenge: string): boolean {
  const digest = b64uEncode(createHash("sha256").update(verifier).digest());
  return digest === challenge;
}

// ---------------------------------------------------------------------------
// Body parsing helpers
// ---------------------------------------------------------------------------

async function readBodyRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBodyRaw(req);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseFormEncoded(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split("&")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, " "));
    const val = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, " "));
    result[key] = val;
  }
  return result;
}

async function readFormOrJson(
  req: IncomingMessage,
): Promise<Record<string, string | unknown>> {
  const raw = await readBodyRaw(req);
  const ct = (req.headers["content-type"] ?? "").split(";")[0]?.trim();
  if (ct === "application/x-www-form-urlencoded") {
    return parseFormEncoded(raw);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Query string parser
// ---------------------------------------------------------------------------

function parseQs(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const result: Record<string, string> = {};
  for (const pair of url.slice(idx + 1).split("&")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, " "));
    const val = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, " "));
    result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTML consent page
// ---------------------------------------------------------------------------

function renderConsentPage(params: Record<string, string>, error?: string): string {
  const hiddenFields = [
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "state",
    "scope",
  ]
    .filter((k) => params[k] !== undefined)
    .map(
      (k) =>
        `<input type="hidden" name="${k}" value="${escHtml(params[k])}">`,
    )
    .join("\n        ");

  const errorHtml = error
    ? `<p style="color:#c0392b;margin-bottom:12px">${escHtml(error)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lokyy Brain — Authorize</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px 40px;width:100%;max-width:420px;box-shadow:0 8px 32px #0004}
    h1{margin:0 0 8px;font-size:1.4rem;font-weight:700;color:#f1f5f9}
    .sub{color:#94a3b8;font-size:.875rem;margin-bottom:24px}
    label{display:block;font-size:.8125rem;font-weight:500;color:#94a3b8;margin-bottom:6px}
    input[type=password]{width:100%;padding:10px 14px;border:1px solid #475569;border-radius:8px;background:#0f172a;color:#f1f5f9;font-size:1rem;outline:none;transition:border-color .15s}
    input[type=password]:focus{border-color:#6366f1}
    button{width:100%;margin-top:20px;padding:12px;background:#6366f1;color:#fff;font-size:1rem;font-weight:600;border:none;border-radius:8px;cursor:pointer;transition:background .15s}
    button:hover{background:#4f46e5}
  </style>
</head>
<body>
  <div class="card">
    <h1>Lokyy Brain</h1>
    <p class="sub">A client is requesting access to your knowledge vault.<br>Enter your access password to authorize.</p>
    ${errorHtml}
    <form method="POST" action="/authorize">
      ${hiddenFields}
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

function escHtml(s: string | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Consent password
// ---------------------------------------------------------------------------

function consentPassword(): string {
  return process.env.LOKYY_OAUTH_PASSWORD ?? process.env.LOKYY_MCP_TOKEN ?? "";
}

// ---------------------------------------------------------------------------
// Route handler — main entry point called from httpServer.ts
// ---------------------------------------------------------------------------

/**
 * Returns true if this request was handled by an OAuth endpoint, false if the
 * caller should continue to the /mcp handling block.
 */
export async function handleOAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const base = deriveBase(req);

  // ------------------------------------------------------------------
  // OPTIONS preflight for all OAuth paths
  // ------------------------------------------------------------------
  if (method === "OPTIONS") {
    // The main handler catches /mcp OPTIONS; here we catch the others
    if (
      url === "/.well-known/oauth-protected-resource" ||
      url.startsWith("/.well-known/oauth-protected-resource/") ||
      url === "/.well-known/oauth-authorization-server" ||
      url === "/register" ||
      url === "/authorize" ||
      url === "/token"
    ) {
      res.writeHead(204).end();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // RFC 9728 — Protected Resource Metadata
  // ------------------------------------------------------------------
  if (
    method === "GET" &&
    (url === "/.well-known/oauth-protected-resource" ||
      url.startsWith("/.well-known/oauth-protected-resource/"))
  ) {
    const body = JSON.stringify({
      resource: `${base}/mcp`,
      authorization_servers: [base],
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
    return true;
  }

  // ------------------------------------------------------------------
  // RFC 8414 — Authorization Server Metadata
  // ------------------------------------------------------------------
  if (method === "GET" && url === "/.well-known/oauth-authorization-server") {
    const body = JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
    return true;
  }

  // ------------------------------------------------------------------
  // RFC 7591 — Dynamic Client Registration
  // ------------------------------------------------------------------
  if (method === "POST" && url === "/register") {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      jsonError(res, 400, "invalid_request", "Malformed JSON body");
      return true;
    }
    const redirectUris = body["redirect_uris"];
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.some((u) => typeof u !== "string")
    ) {
      jsonError(res, 400, "invalid_redirect_uri", "redirect_uris must be a non-empty string array");
      return true;
    }
    const clientId = randomBytes(16).toString("hex");
    const now = Math.floor(Date.now() / 1000);
    const client: RegisteredClient = {
      clientId,
      redirectUris: redirectUris as string[],
      clientName: typeof body["client_name"] === "string" ? body["client_name"] : undefined,
      clientIdIssuedAt: now,
    };
    clients.set(clientId, client);
    const response: Record<string, unknown> = {
      client_id: clientId,
      redirect_uris: client.redirectUris,
      client_id_issued_at: now,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    if (client.clientName) response["client_name"] = client.clientName;
    res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(response));
    return true;
  }

  // ------------------------------------------------------------------
  // GET /authorize — render consent page
  // ------------------------------------------------------------------
  if (method === "GET" && url.startsWith("/authorize")) {
    const qs = parseQs(url);
    const { client_id, redirect_uri, code_challenge, code_challenge_method, state, response_type } = qs;

    // Validate required params
    if (!client_id || !redirect_uri || !code_challenge || !response_type) {
      jsonError(res, 400, "invalid_request", "Missing required authorization parameters");
      return true;
    }
    if (response_type !== "code") {
      jsonError(res, 400, "unsupported_response_type", "Only response_type=code supported");
      return true;
    }
    if (code_challenge_method && code_challenge_method !== "S256") {
      jsonError(res, 400, "invalid_request", "Only code_challenge_method=S256 supported");
      return true;
    }

    // Validate client and exact-match redirect_uri
    const client = clients.get(client_id);
    if (!client) {
      jsonError(res, 400, "invalid_client", "Unknown client_id");
      return true;
    }
    if (!client.redirectUris.includes(redirect_uri)) {
      jsonError(res, 400, "invalid_request", "redirect_uri does not match registered URIs");
      return true;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderConsentPage(qs));
    return true;
  }

  // ------------------------------------------------------------------
  // POST /authorize — process consent form submission
  // ------------------------------------------------------------------
  if (method === "POST" && url === "/authorize") {
    const rawBody = await readBodyRaw(req);
    const ct = (req.headers["content-type"] ?? "").split(";")[0]?.trim();
    let params: Record<string, string>;
    if (ct === "application/x-www-form-urlencoded") {
      params = parseFormEncoded(rawBody);
    } else {
      // Try JSON fallback
      try {
        params = JSON.parse(rawBody) as Record<string, string>;
      } catch {
        params = {};
      }
    }

    const { client_id, redirect_uri, code_challenge, code_challenge_method, state, password, response_type } = params;

    // Validate params (same as GET)
    if (!client_id || !redirect_uri || !code_challenge || !response_type) {
      jsonError(res, 400, "invalid_request", "Missing required authorization parameters");
      return true;
    }
    if (code_challenge_method && code_challenge_method !== "S256") {
      jsonError(res, 400, "invalid_request", "Only code_challenge_method=S256 supported");
      return true;
    }

    // Validate client and exact-match redirect_uri
    const client = clients.get(client_id);
    if (!client) {
      jsonError(res, 400, "invalid_client", "Unknown client_id");
      return true;
    }
    if (!client.redirectUris.includes(redirect_uri)) {
      jsonError(res, 400, "invalid_request", "redirect_uri does not match registered URIs");
      return true;
    }

    // Verify password — gate before any code issuance
    if (password !== consentPassword()) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderConsentPage(params, "Incorrect password. Please try again."));
      return true;
    }

    // Mint single-use auth code (TTL: 120 seconds)
    const code = randomBytes(24).toString("hex");
    codes.set(code, {
      code,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      expiresAt: Date.now() + 120_000,
    });

    // Redirect with code + state
    const target = new URL(redirect_uri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
    res.end();
    return true;
  }

  // ------------------------------------------------------------------
  // POST /token
  // ------------------------------------------------------------------
  if (method === "POST" && url === "/token") {
    const body = await readFormOrJson(req) as Record<string, string>;
    const grantType = body["grant_type"];

    if (grantType === "authorization_code") {
      const { code, client_id, redirect_uri, code_verifier } = body;

      if (!code || !client_id || !redirect_uri || !code_verifier) {
        jsonError(res, 400, "invalid_request", "Missing required token parameters");
        return true;
      }

      // Validate code — single-use: delete on first lookup
      const stored = codes.get(code);
      if (!stored) {
        jsonError(res, 400, "invalid_grant", "Authorization code not found or already used");
        return true;
      }
      // Delete immediately — single-use
      codes.delete(code);

      if (stored.expiresAt < Date.now()) {
        jsonError(res, 400, "invalid_grant", "Authorization code expired");
        return true;
      }
      if (stored.clientId !== client_id) {
        jsonError(res, 400, "invalid_grant", "client_id mismatch");
        return true;
      }
      if (stored.redirectUri !== redirect_uri) {
        jsonError(res, 400, "invalid_grant", "redirect_uri mismatch");
        return true;
      }

      // PKCE verification — mandatory S256
      if (!verifyPkce(code_verifier, stored.codeChallenge)) {
        jsonError(res, 400, "invalid_grant", "PKCE verification failed");
        return true;
      }

      const accessToken = issueToken(base, "access");
      const refreshToken = issueToken(base, "refresh");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(
        JSON.stringify({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: refreshToken,
        }),
      );
      return true;
    }

    if (grantType === "refresh_token") {
      const refreshToken = body["refresh_token"];
      if (!refreshToken) {
        jsonError(res, 400, "invalid_request", "Missing refresh_token");
        return true;
      }
      if (!verifyToken(refreshToken, "refresh")) {
        jsonError(res, 400, "invalid_grant", "Invalid or expired refresh_token");
        return true;
      }
      // Rotate: issue fresh access + refresh token
      const newAccessToken = issueToken(base, "access");
      const newRefreshToken = issueToken(base, "refresh");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(
        JSON.stringify({
          access_token: newAccessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: newRefreshToken,
        }),
      );
      return true;
    }

    jsonError(res, 400, "unsupported_grant_type", "Only authorization_code and refresh_token supported");
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helper — JSON error response
// ---------------------------------------------------------------------------

function jsonError(
  res: ServerResponse,
  status: number,
  error: string,
  description: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error, error_description: description }));
}
