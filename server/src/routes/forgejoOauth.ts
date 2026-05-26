import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  database,
  forgejoOauthState,
  forgejoOauthTokens,
  generateUlid,
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
 * GET /api/auth/forgejo/start
 *
 * Generates a CSRF state token, persists it bound to the current user,
 * then 302s to Forgejo's authorize endpoint.
 */
forgejoOauthRoutes.get("/start", async (c) => {
  if (!isFullyConfigured()) {
    return c.json({ error: "forgejo-not-configured" }, 503);
  }
  const user = await requireUser(c);
  if (!user) return c.json({ error: "unauthenticated" }, 401);

  const state = randomBytes(16).toString("hex"); // 32 hex chars
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
        Authorization: `token ${tokenJson.access_token}`,
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

  await upsertToken({
    userId: stateRow.userId,
    forgejoBaseUrl: config.forgejoBaseUrl,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token ?? null,
    expiresAt,
    forgejoUserLogin: forgejoUser.login,
  });

  const wizardUrl = buildSameOriginUrl(c, "/setup?forgejo=connected");
  return c.redirect(wizardUrl, 302);
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

  const token = await findToken(user.id);
  if (!token) return c.json({ connected: false });
  return c.json({
    connected: true,
    forgejoUserLogin: token.forgejoUserLogin,
    baseUrl: token.forgejoBaseUrl,
  });
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

  const token = await findToken(user.id);
  if (!token) return c.json({ error: "forgejo-not-connected" }, 412);

  const reposUrl = new URL(
    "/api/v1/user/repos",
    ensureTrailingSlash(token.forgejoBaseUrl),
  );
  reposUrl.searchParams.set("limit", "50");
  reposUrl.searchParams.set("sort", "updated");

  const res = await forgejoFetch(reposUrl.toString(), {
    headers: {
      Authorization: `token ${token.accessToken}`,
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

  const token = await findToken(user.id);
  if (!token) return c.json({ error: "forgejo-not-connected" }, 412);

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
    ensureTrailingSlash(token.forgejoBaseUrl),
  );
  const res = await forgejoFetch(createUrl.toString(), {
    method: "POST",
    headers: {
      Authorization: `token ${token.accessToken}`,
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

async function findToken(userId: string) {
  const rows = await database()
    .select()
    .from(forgejoOauthTokens)
    .where(
      and(
        eq(forgejoOauthTokens.userId, userId),
        eq(forgejoOauthTokens.forgejoBaseUrl, config.forgejoBaseUrl),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function upsertToken(input: {
  userId: string;
  forgejoBaseUrl: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  forgejoUserLogin: string;
}) {
  const existing = await database()
    .select()
    .from(forgejoOauthTokens)
    .where(
      and(
        eq(forgejoOauthTokens.userId, input.userId),
        eq(forgejoOauthTokens.forgejoBaseUrl, input.forgejoBaseUrl),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await database()
      .update(forgejoOauthTokens)
      .set({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt,
        forgejoUserLogin: input.forgejoUserLogin,
      })
      .where(eq(forgejoOauthTokens.id, existing[0].id));
    return;
  }
  await database()
    .insert(forgejoOauthTokens)
    .values({
      id: generateUlid(),
      userId: input.userId,
      forgejoBaseUrl: input.forgejoBaseUrl,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      forgejoUserLogin: input.forgejoUserLogin,
    });
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
    const proto = fwdProto ?? "https";
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
