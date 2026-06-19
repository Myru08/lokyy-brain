import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  database,
  forgejoOauthState,
  forgejoOauthTokens,
  generateUlid,
  getValidForgejoToken,
  loadToken,
  upsertForgejoToken,
} from "@lokyy/core";
import { config } from "../config.js";
import { getSessionUser } from "../auth/sessions.js";

/**
 * Forgejo OAuth2 integration for the setup wizard + ongoing repo work.
 *
 * Two routers because they have different mountpoints and slightly
 * different concerns:
 *
 *   /api/auth/forgejo/*   — the OAuth2 dance itself: `info`, `start`,
 *                           `callback`. `info` is public (the wizard hits
 *                           it before login is even relevant in some
 *                           flows); `start` requires a logged-in session;
 *                           `callback` is hit by Forgejo's redirect.
 *
 *   /api/forgejo/*        — authenticated, post-OAuth helpers: list the
 *                           user's repos, create a new one, and check
 *                           whether they already have a stored token.
 *
 * Sessions: cookie-based (`lokyy_session`), same as the rest of the app.
 * Forgejo calls use `fetch` with `AbortSignal.timeout(10_000)`.
 */

const COOKIE = "lokyy_session";
const FORGEJO_TIMEOUT_MS = 10_000;
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── /api/auth/forgejo ──────────────────────────────────────────────────

export const forgejoOauthRoutes = new Hono();

/**
 * GET /api/auth/forgejo/info
 *
 * Public. Tells the wizard whether the operator has wired up an OAuth app
 * (i.e. set FORGEJO_BASE_URL + FORGEJO_OAUTH_CLIENT_ID +
 * FORGEJO_OAUTH_CLIENT_SECRET in the environment) and what redirect URI
 * they need to paste into the Forgejo app config.
 */
forgejoOauthRoutes.get("/info", (c) => {
  const configured = isFullyConfigured();
  const redirectUri = buildRedirectUri(c);
  const clientId = config.forgejoOauthClientId;
  const clientIdPreview = clientId
    ? `${clientId.slice(0, 8)}${clientId.length > 8 ? "…" : ""}`
    : "";
  return c.json({
    configured,
    baseUrl: config.forgejoBaseUrl,
    redirectUri,
    clientIdPreview,
  });
});

/**
 * GET /api/auth/forgejo/start?next=/settings?forgejo=connected
 *
 * Generates a CSRF state token, persists it bound to the current user,
 * then 302s to Forgejo's authorize endpoint.
 *
 * The optional `next` query parameter is the same-origin path the
 * callback should redirect to after a successful token exchange. It is
 * encoded into the state value (format: `<randomHex>.<base64urlNext>`)
 * so no schema migration is needed and the state row remains the only
 * trust anchor. Default is `/setup?forgejo=connected` for backwards
 * compatibility with the wizard.
 */
forgejoOauthRoutes.get("/start", async (c) => {
  if (!isFullyConfigured()) {
    return c.json({ error: "forgejo-not-configured" }, 503);
  }
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthenticated" }, 401);

  const rawNext = c.req.query("next") ?? "/setup?forgejo=connected";
  // Validate to a same-origin path BEFORE we ship it through the OAuth
  // round-trip. The callback validates again as defence-in-depth.
  const safeNext = sanitizeNextPath(rawNext) ?? "/setup?forgejo=connected";

  const randomPart = randomBytes(16).toString("hex"); // 32 hex chars
  const state = `${randomPart}.${encodeNext(safeNext)}`;
  await database().insert(forgejoOauthState).values({
    state,
    userId: user.id,
  });

  const redirectUri = buildRedirectUri(c);
  const authorizeUrl = new URL(
    "/login/oauth/authorize",
    ensureTrailingSlash(config.forgejoBaseUrl),
  );
  authorizeUrl.searchParams.set("client_id", config.forgejoOauthClientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", "write:repository");

  return c.redirect(authorizeUrl.toString(), 302);
});

/**
 * GET /api/auth/forgejo/callback?code=...&state=...
 *
 * Public — Forgejo redirects the browser here. Verifies the state row,
 * exchanges the code for an access token, fetches the Forgejo user login,
 * and UPSERTs the token row. Finally 302s back to the wizard.
 */
forgejoOauthRoutes.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.json({ error: "missing-code-or-state" }, 400);
  }
  if (!isFullyConfigured()) {
    return c.json({ error: "forgejo-not-configured" }, 503);
  }

  // Verify + consume state (one-shot).
  const stateRows = await database()
    .select()
    .from(forgejoOauthState)
    .where(eq(forgejoOauthState.state, state))
    .limit(1);
  const stateRow = stateRows[0];
  if (!stateRow) {
    return c.json({ error: "invalid-state" }, 400);
  }
  await database()
    .delete(forgejoOauthState)
    .where(eq(forgejoOauthState.state, state));

  if (Date.now() - stateRow.createdAt.getTime() > STATE_TTL_MS) {
    return c.json({ error: "state-expired" }, 400);
  }

  const redirectUri = buildRedirectUri(c);

  // Exchange code → access token.
  const tokenRes = await forgejoFetch(
    new URL(
      "/login/oauth/access_token",
      ensureTrailingSlash(config.forgejoBaseUrl),
    ).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.forgejoOauthClientId,
        client_secret: config.forgejoOauthClientSecret,
        redirect_uri: redirectUri,
      }).toString(),
    },
  );
  if (!tokenRes.ok) {
    const text = await safeReadText(tokenRes);
    return c.json(
      { error: "token-exchange-failed", status: tokenRes.status, body: text },
      502,
    );
  }
  const tokenJson = (await tokenRes.json()) as TokenResponse;
  if (!tokenJson.access_token) {
    return c.json({ error: "no-access-token-in-response" }, 502);
  }

  // Lookup Forgejo user login with the new token.
  const userRes = await forgejoFetch(
    new URL(
      "/api/v1/user",
      ensureTrailingSlash(config.forgejoBaseUrl),
    ).toString(),
    {
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        Accept: "application/json",
      },
    },
  );
  if (!userRes.ok) {
    const text = await safeReadText(userRes);
    return c.json(
      { error: "forgejo-user-lookup-failed", status: userRes.status, body: text },
      502,
    );
  }
  const forgejoUser = (await userRes.json()) as ForgejoUserResponse;
  if (!forgejoUser.login) {
    return c.json({ error: "forgejo-user-missing-login" }, 502);
  }

  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + tokenJson.expires_in * 1000)
    : null;

  await upsertForgejoToken({
    id: generateUlid(),
    userId: stateRow.userId,
    forgejoBaseUrl: config.forgejoBaseUrl,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token ?? null,
    expiresAt,
    forgejoUserLogin: forgejoUser.login,
  });

  // Decode the post-OAuth redirect target from the state value. Format
  // is `<randomHex>.<base64urlNext>`; the dot is reserved (hex chars
  // never produce one). Legacy states without a dot fall back to the
  // wizard URL. Any decoded next is re-validated to a same-origin path.
  const decodedNext = decodeNextFromState(state);
  const safeNext =
    (decodedNext && sanitizeNextPath(decodedNext)) ?? "/setup?forgejo=connected";
  const targetUrl = buildSameOriginUrl(c, safeNext);
  return c.redirect(targetUrl, 302);
});

// ─── /api/forgejo ───────────────────────────────────────────────────────

export const forgejoApiRoutes = new Hono();

/**
 * GET /api/forgejo/connection
 *
 * Lightweight UI gate: did this user complete OAuth yet?
 */
forgejoApiRoutes.get("/connection", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthenticated" }, 401);

  // Connection check is metadata-only — no need to decrypt access_token /
  // refresh expiry just to surface "are we wired up at all?".
  const token = await loadToken(user.id, config.forgejoBaseUrl);
  if (!token) return c.json({ connected: false });
  return c.json({
    connected: true,
    forgejoUserLogin: token.forgejoUserLogin,
    baseUrl: token.forgejoBaseUrl,
  });
});

// TEMP DEBUG: server-seitige Reachability zu Forgejo via undici (gleicher
// fetch-Mechanismus wie der OAuth-Callback). Öffentlich, zum Diagnostizieren
// des Callback-502. Wird nach dem Fix wieder entfernt.
forgejoApiRoutes.get("/_probe", async (c) => {
  const url = new URL(
    "/api/v1/version",
    ensureTrailingSlash(config.forgejoBaseUrl),
  ).toString();
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = await r.text();
    return c.json({ ok: true, url, status: r.status, ms: Date.now() - t0, body: body.slice(0, 200) });
  } catch (e) {
    return c.json({
      ok: false,
      url,
      ms: Date.now() - t0,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
  }
});

/**
 * GET /api/forgejo/probe
 *
 * Calls Forgejo's `/api/v1/user` with the stored OAuth token to
 * determine whether the token is actually still valid (Forgejo JWTs
 * expire after ~1h). The Settings page uses this to show "Token
 * abgelaufen" and prompt for a reconnect-flow.
 *
 *   { ok: true, forgejoUserLogin: string }                   – live
 *   { ok: false, reason: 'no-token' }                        – never connected
 *   { ok: false, reason: 'expired', error?: string }         – 401 from Forgejo
 *   { ok: false, reason: 'network', error?: string }         – fetch failed
 */
forgejoApiRoutes.get("/probe", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthenticated" }, 401);

  // Need the row metadata (baseUrl) to find a token at all — call loadToken
  // first to distinguish "no row" from "expired + couldn't refresh".
  const stored = await loadToken(user.id, config.forgejoBaseUrl);
  if (!stored) {
    return c.json({ ok: false, reason: "no-token" as const });
  }
  const accessToken = await getValidForgejoToken(user.id, oauthConfigFromEnv());
  if (!accessToken) {
    return c.json({
      ok: false as const,
      reason: "expired" as const,
      error: "refresh_token unavailable or rejected",
    });
  }

  try {
    const userRes = await forgejoFetch(
      new URL(
        "/api/v1/user",
        ensureTrailingSlash(stored.forgejoBaseUrl),
      ).toString(),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
    );
    if (userRes.status === 401 || userRes.status === 403) {
      return c.json({
        ok: false as const,
        reason: "expired" as const,
        error: `forgejo returned ${userRes.status}`,
      });
    }
    if (!userRes.ok) {
      return c.json({
        ok: false as const,
        reason: "network" as const,
        error: `forgejo returned ${userRes.status}`,
      });
    }
    const forgejoUser = (await userRes.json()) as ForgejoUserResponse;
    return c.json({
      ok: true as const,
      forgejoUserLogin: forgejoUser.login ?? stored.forgejoUserLogin,
    });
  } catch (err) {
    return c.json({
      ok: false as const,
      reason: "network" as const,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * DELETE /api/forgejo/connection
 *
 * Forgets the stored Forgejo OAuth token(s) for the current user. Used by
 * the UI when the operator wants to re-authenticate (expired JWT, scope
 * change, account switch). Deletes all `forgejo_oauth_tokens` rows for the
 * user, then sweeps any leftover `forgejo_oauth_state` rows for the same
 * user. Tokens first, state second — order matters if anything depends on
 * cascade behavior, which we don't rely on.
 */
forgejoApiRoutes.delete("/connection", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ ok: false, error: "unauthenticated" }, 401);

  try {
    await database()
      .delete(forgejoOauthTokens)
      .where(eq(forgejoOauthTokens.userId, user.id));
    await database()
      .delete(forgejoOauthState)
      .where(eq(forgejoOauthState.userId, user.id));
    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: message }, 500);
  }
});

/**
 * GET /api/forgejo/repos
 *
 * Lists the authenticated user's repos on the Forgejo instance, sorted by
 * recent activity. Limited to 50 — enough for the wizard's picker; if
 * someone has more they can always create a new one.
 */
forgejoApiRoutes.get("/repos", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthenticated" }, 401);

  const accessToken = await getValidForgejoToken(user.id, oauthConfigFromEnv());
  if (!accessToken) {
    return c.json({ error: "forgejo-not-connected" }, 412);
  }

  const reposUrl = new URL(
    "/api/v1/user/repos",
    ensureTrailingSlash(config.forgejoBaseUrl),
  );
  reposUrl.searchParams.set("limit", "50");
  reposUrl.searchParams.set("sort", "updated");

  const res = await forgejoFetch(reposUrl.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    return c.json(
      { error: "forgejo-list-repos-failed", status: res.status, body: text },
      502,
    );
  }
  const repos = (await res.json()) as ForgejoRepoResponse[];
  return c.json(repos.map(projectRepo));
});

/**
 * POST /api/forgejo/repos
 * Body: { name: string, description?: string, private?: boolean }
 *
 * Creates a new repo under the authenticated Forgejo user.
 */
forgejoApiRoutes.post("/repos", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthenticated" }, 401);

  const accessToken = await getValidForgejoToken(user.id, oauthConfigFromEnv());
  if (!accessToken) {
    return c.json({ error: "forgejo-not-connected" }, 412);
  }

  const body = await c.req.json<{
    name?: string;
    description?: string;
    private?: boolean;
  }>();
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name-required" }, 400);
  }

  const createUrl = new URL(
    "/api/v1/user/repos",
    ensureTrailingSlash(config.forgejoBaseUrl),
  );
  const res = await forgejoFetch(createUrl.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      name: body.name,
      description: body.description ?? "",
      private: body.private ?? true,
      auto_init: true,
      default_branch: "main",
    }),
  });
  if (!res.ok) {
    const text = await safeReadText(res);
    return c.json(
      { error: "forgejo-create-repo-failed", status: res.status, body: text },
      res.status === 409 ? 409 : 502,
    );
  }
  const repo = (await res.json()) as ForgejoRepoResponse;
  return c.json(projectRepo(repo), 201);
});

// ─── Helpers ────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

interface ForgejoUserResponse {
  login?: string;
  id?: number;
  email?: string;
}

interface ForgejoRepoResponse {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  html_url: string;
}

function projectRepo(r: ForgejoRepoResponse) {
  return {
    full_name: r.full_name,
    clone_url: r.clone_url,
    default_branch: r.default_branch,
    private: r.private,
    html_url: r.html_url,
  };
}

function isFullyConfigured(): boolean {
  return (
    !!config.forgejoBaseUrl &&
    !!config.forgejoOauthClientId &&
    !!config.forgejoOauthClientSecret
  );
}

async function requireUser(c: Context) {
  const sid = getCookie(c, COOKIE);
  if (!sid) return null;
  return getSessionUser(sid);
}

/**
 * Bundle the env-driven OAuth-app config into the shape
 * `@lokyy/core`'s refresh-token helpers expect. Centralising the read keeps
 * route handlers from sprinkling `config.forgejo*` references.
 */
function oauthConfigFromEnv() {
  return {
    forgejoBaseUrl: config.forgejoBaseUrl,
    clientId: config.forgejoOauthClientId,
    clientSecret: config.forgejoOauthClientSecret,
  };
}

/**
 * Build the OAuth `redirect_uri` from the request. Honors the nginx proxy
 * headers (`X-Forwarded-Host`, `X-Forwarded-Proto`) so the wizard shows
 * the correct external URL the operator has to paste into the Forgejo
 * OAuth app config. Falls back to the `Host` header and `https` when
 * `X-Forwarded-*` are absent.
 */
function buildRedirectUri(c: Context): string {
  const origin = detectOrigin(c);
  return `${origin}/api/auth/forgejo/callback`;
}

function buildSameOriginUrl(c: Context, path: string): string {
  return `${detectOrigin(c)}${path}`;
}

function detectOrigin(c: Context): string {
  const fwdHost = c.req.header("x-forwarded-host");
  const fwdProto = c.req.header("x-forwarded-proto");
  if (fwdHost) {
    const proto = fwdProto || "https";
    return `${proto}://${fwdHost.split(",")[0]?.trim()}`;
  }
  const host = c.req.header("host");
  if (host) {
    // Default to https — the nginx proxy is expected in production. In
    // dev (no X-Forwarded headers, no proxy) operators usually run the
    // wizard against localhost via http, so honor that.
    const proto = host.startsWith("localhost") || host.startsWith("127.")
      ? "http"
      : "https";
    return `${proto}://${host}`;
  }
  // Last resort: fall back to a relative URL — Forgejo will reject this,
  // but it's better than throwing here. The /info endpoint will reflect
  // the same broken value so the operator can see it.
  return "";
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function forgejoFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FORGEJO_TIMEOUT_MS),
  });
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ─── `next` encoding / validation ────────────────────────────────────────
//
// The OAuth callback redirects to a path provided by the start endpoint
// (`?next=...`). To avoid a DB schema change we tunnel that path through
// the existing `state` column by joining `<randomHex>.<base64urlNext>`;
// hex never produces a literal `.`, so the dot reliably partitions the
// two halves.
//
// Open-redirect defence: `sanitizeNextPath` rejects everything except
// rooted same-origin paths. No scheme/host allowed, no protocol-relative
// `//evil.com`, no backslash tricks.

function encodeNext(path: string): string {
  return Buffer.from(path, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeNext(b64: string): string | null {
  try {
    // Restore base64 from base64url and pad to a multiple of 4.
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    return Buffer.from(padded + pad, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function decodeNextFromState(state: string): string | null {
  const dot = state.indexOf(".");
  if (dot === -1) return null;
  const next = decodeNext(state.slice(dot + 1));
  return next;
}

/**
 * Validate a candidate post-OAuth `next` path. Returns the normalized
 * path on success, or null when the input would enable an open-redirect
 * (absolute URL, scheme, protocol-relative, control characters).
 */
function sanitizeNextPath(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  // Reject control characters and whitespace — they have no place in a URL
  // and are a common parser-confusion vector.
  if (/[\x00-\x1f\x7f\s]/.test(raw)) return null;
  // Must be a rooted path. Reject absolute URLs (`http://…`,
  // `https://…`, `javascript:…`) and scheme-relative (`//evil.com/x`).
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  // Reject backslash, which Chrome historically normalises to `/`.
  if (raw.includes("\\")) return null;
  return raw;
}
