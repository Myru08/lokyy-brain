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
// Header logo (pwa/public/logo-header.png, 200x60 transparent PNG) inlined as
// a data URI so the consent page stays self-contained — no extra asset route.
// ---------------------------------------------------------------------------

const LOGO_DATA_URI =
  "data:image/png;base64,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";

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

/**
 * Is the OAuth flow configured at all?
 *
 * Both secrets derive from env vars that MAY now be absent: since Story 7.10 an
 * installation can run purely on DB-backed MCP tokens with no `LOKYY_MCP_TOKEN`
 * at all. Without this gate that configuration would be catastrophic:
 *
 *   - `signingSecret()` would collapse to the constant `"derived:"`, so ANYONE
 *     could forge a valid access JWT and `verifyToken` would accept it, and
 *   - `consentPassword()` would be `""`, which an empty form field matches.
 *
 * So: no signing secret AND no consent password configured → OAuth is OFF.
 * `/mcp` still works via bearer tokens; only the claude.ai connector flow
 * requires the operator to set `LOKYY_OAUTH_PASSWORD` +
 * `LOKYY_OAUTH_SIGNING_SECRET` explicitly.
 */
export function isOAuthConfigured(): boolean {
  const secret =
    process.env.LOKYY_OAUTH_SIGNING_SECRET ?? process.env.LOKYY_MCP_TOKEN ?? "";
  const password =
    process.env.LOKYY_OAUTH_PASSWORD ?? process.env.LOKYY_MCP_TOKEN ?? "";
  return secret.length > 0 && password.length > 0;
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
  // No OAuth config → no forgeable well-known secret to accept. See above.
  if (!isOAuthConfigured()) return false;
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
    ? `<p style="color:#EF4444;margin-bottom:12px">${escHtml(error)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Lokyy Brain — Authorize</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap">
  <style>
    *{box-sizing:border-box}
    body{font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;background:#13171D;color:#FFFFFF;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:#1A1F26;border:1px solid #2A323D;border-radius:12px;padding:32px 40px;width:100%;max-width:420px;box-shadow:0 8px 32px #0006}
    h1{margin:0 0 8px;font-family:'Fraunces',Georgia,serif;font-size:1.5rem;font-weight:700;color:#FFFFFF}
    .sub{color:#8B9099;font-size:.875rem;margin-bottom:24px}
    label{display:block;font-size:.8125rem;font-weight:500;color:#8B9099;margin-bottom:6px}
    input[type=password]{width:100%;padding:10px 14px;border:1px solid #2A323D;border-radius:8px;background:#13171D;color:#FFFFFF;font-size:1rem;outline:none;transition:border-color .15s,box-shadow .15s}
    input[type=password]:focus{border-color:#F97316;box-shadow:0 0 0 3px #F9731633}
    button{width:100%;margin-top:20px;padding:12px;background:#F97316;color:#FFFFFF;font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:1rem;font-weight:600;border:none;border-radius:8px;cursor:pointer;transition:background .15s}
    button:hover{background:#FB923C}
  </style>
</head>
<body>
  <div class="card">
    <img src="${LOGO_DATA_URI}" alt="Lokyy Brain" style="height:44px;width:auto;display:block;margin:0 0 16px 0">
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

    // Verify password — gate before any code issuance. An UNCONFIGURED install
    // has an empty consent password, which an empty form field would match —
    // so refuse outright rather than compare (Story 7.10).
    if (!isOAuthConfigured() || password !== consentPassword()) {
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
