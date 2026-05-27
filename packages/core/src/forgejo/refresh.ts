/**
 * Forgejo OAuth — refresh-token flow + decrypt helpers.
 *
 * Self-hosted Forgejo issues a JWT access token that expires after ~1h.
 * Without a refresh flow the user has to click "Reconnect" in Settings →
 * Vault every hour. We already store the refresh_token at OAuth-callback
 * time; this module wraps it with two responsibilities:
 *
 *   1. Decrypt the at-rest envelope (`forgejo_oauth_tokens.*_encrypted`)
 *      so callers get plain `access_token` / `refresh_token` strings.
 *
 *   2. Lazily exchange the refresh_token for a fresh access_token when the
 *      stored one is within 60s of expiry (or already past it). The fresh
 *      access + refresh pair is written back, encrypted at rest.
 *
 * The result: every server-side caller that used to read
 * `findToken(userId).accessToken` switches to `getValidForgejoToken(userId, ...)`
 * and stops worrying about the JWT lifetime entirely.
 *
 * ## Failure modes
 *
 *   - Stored row has no refresh_token (some Forgejo OAuth-App configs
 *     disable them): helper returns the existing access_token if it is
 *     still within the validity window, else null (caller surfaces
 *     "reconnect needed").
 *
 *   - Refresh exchange fails with 4xx (refresh_token revoked/expired):
 *     the row is deleted (it's useless) and the helper returns null. The
 *     caller surfaces "reconnect needed" — same UX as no-token-stored.
 *
 *   - Refresh exchange fails with 5xx / network: we DO NOT delete the row
 *     (the refresh_token might still be valid, this is transient). Caller
 *     receives null and can retry next request.
 *
 * ## Concurrency
 *
 * Two parallel requests can both observe an expired access_token and both
 * try to refresh. Forgejo's refresh endpoint accepts the same refresh_token
 * multiple times within a short window for exactly this reason — both
 * exchanges succeed, both update the row, last-write-wins on the
 * access_token. The previous access_token from the first refresh is
 * superseded but still valid until it ages out; no requests are lost.
 *
 * We do not add a per-user mutex here because the cost of a redundant
 * refresh is negligible and the alternative (process-local mutex) doesn't
 * help across server processes.
 */

import { and, eq } from "drizzle-orm";
import { database } from "../db/index.js";
import { forgejoOauthTokens } from "../db/schema/forgejoOauthTokens.js";
import { decrypt, encrypt } from "../crypto/secrets.js";

/** Margin around `expires_at` where we still consider the token "valid". */
const REFRESH_LEAD_MS = 60_000; // refresh ≥60s before expiry
const FORGEJO_TIMEOUT_MS = 10_000;

export interface ForgejoOauthConfig {
  forgejoBaseUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface DecryptedToken {
  id: string;
  userId: string;
  forgejoBaseUrl: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  forgejoUserLogin: string;
  createdAt: Date;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Load the stored token row for `(userId, forgejoBaseUrl)` and decrypt the
 * envelope columns in-memory. Returns null when no row exists.
 *
 * The returned object is a plain copy of the row — mutating it does NOT
 * write back to the database. Use `getValidForgejoToken` for the
 * "give me a usable access_token, refreshing if needed" path.
 */
export async function loadToken(
  userId: string,
  forgejoBaseUrl: string,
): Promise<DecryptedToken | null> {
  const rows = await database()
    .select()
    .from(forgejoOauthTokens)
    .where(
      and(
        eq(forgejoOauthTokens.userId, userId),
        eq(forgejoOauthTokens.forgejoBaseUrl, forgejoBaseUrl),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    forgejoBaseUrl: row.forgejoBaseUrl,
    accessToken: decrypt(row.accessTokenEncrypted),
    refreshToken: row.refreshTokenEncrypted ? decrypt(row.refreshTokenEncrypted) : null,
    expiresAt: row.expiresAt,
    forgejoUserLogin: row.forgejoUserLogin,
    createdAt: row.createdAt,
  };
}

/**
 * Load ALL token rows for a user, regardless of `forgejo_base_url`.
 *
 * Used by `admin.ts` `findOauthTokenForHost` which needs to enumerate rows
 * and match by URL host (operators sometimes set FORGEJO_BASE_URL with
 * trailing slash drift, so exact-base-url match isn't reliable there).
 */
export async function loadAllTokensForUser(
  userId: string,
): Promise<DecryptedToken[]> {
  const rows = await database()
    .select()
    .from(forgejoOauthTokens)
    .where(eq(forgejoOauthTokens.userId, userId));
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    forgejoBaseUrl: row.forgejoBaseUrl,
    accessToken: decrypt(row.accessTokenEncrypted),
    refreshToken: row.refreshTokenEncrypted ? decrypt(row.refreshTokenEncrypted) : null,
    expiresAt: row.expiresAt,
    forgejoUserLogin: row.forgejoUserLogin,
    createdAt: row.createdAt,
  }));
}

/**
 * Return a Forgejo access_token that is currently valid, refreshing it via
 * the stored refresh_token if necessary. Transparent to callers — they go
 * from "I might be expired" to "I'm definitely usable for the next hour".
 *
 * Returns `null` when:
 *   - no row exists for this `(userId, forgejoBaseUrl)`, OR
 *   - the access_token is expired AND no refresh_token is stored, OR
 *   - the refresh exchange failed in a non-recoverable way (4xx). In this
 *     case the row is deleted; caller should surface "needs reconnect".
 *
 * Soft failures (network, 5xx) ALSO return null but leave the row intact
 * so a later retry can succeed.
 */
export async function getValidForgejoToken(
  userId: string,
  cfg: ForgejoOauthConfig,
): Promise<string | null> {
  const token = await loadToken(userId, cfg.forgejoBaseUrl);
  if (!token) return null;

  // No expiry recorded → assume the token is long-lived (older Forgejo
  // versions return tokens without `expires_in`; we treat the stored value
  // as authoritative until a 401 surfaces from a real request).
  if (token.expiresAt === null) {
    return token.accessToken;
  }

  const msUntilExpiry = token.expiresAt.getTime() - Date.now();
  if (msUntilExpiry > REFRESH_LEAD_MS) {
    return token.accessToken;
  }

  // Expired (or about to). Refresh if we have the material to do it.
  if (!token.refreshToken) {
    return null;
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    // Operator wiped the OAuth-app config from env. Nothing we can do.
    return null;
  }

  return refreshAndStore(token, cfg);
}

/**
 * Perform the refresh-token exchange and persist the new envelope.
 *
 * Separated from `getValidForgejoToken` mostly for clarity but also so a
 * future proactive-refresh background loop can call it directly without
 * re-walking the expiry check.
 */
export async function refreshAndStore(
  token: DecryptedToken,
  cfg: ForgejoOauthConfig,
): Promise<string | null> {
  const tokenUrl = new URL(
    "/login/oauth/access_token",
    ensureTrailingSlash(cfg.forgejoBaseUrl),
  ).toString();

  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken!,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(FORGEJO_TIMEOUT_MS),
    });
  } catch (err) {
    // Network / timeout. Don't drop the row — could be transient.
    console.warn(
      `[forgejo/refresh] refresh exchange network error for user=${token.userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (!res.ok) {
    // 4xx → refresh_token is dead. 5xx → server hiccup, keep the row and
    // let the caller retry later.
    if (res.status >= 400 && res.status < 500) {
      const body = await safeReadText(res);
      console.warn(
        `[forgejo/refresh] refresh rejected (status=${res.status}) for user=${token.userId} — dropping row. body=${body.slice(0, 200)}`,
      );
      await database()
        .delete(forgejoOauthTokens)
        .where(eq(forgejoOauthTokens.id, token.id));
      return null;
    }
    const body = await safeReadText(res);
    console.warn(
      `[forgejo/refresh] refresh transient failure (status=${res.status}) for user=${token.userId}. body=${body.slice(0, 200)}`,
    );
    return null;
  }

  let json: TokenResponse;
  try {
    json = (await res.json()) as TokenResponse;
  } catch (err) {
    console.warn(
      `[forgejo/refresh] refresh response parse failed for user=${token.userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (!json.access_token) {
    console.warn(
      `[forgejo/refresh] refresh response missing access_token for user=${token.userId}`,
    );
    return null;
  }

  const newExpiresAt = json.expires_in
    ? new Date(Date.now() + json.expires_in * 1000)
    : null;
  // Forgejo may or may not rotate the refresh_token. If absent in the
  // response, keep the existing one (it's still valid).
  const newRefreshToken = json.refresh_token ?? token.refreshToken;

  await database()
    .update(forgejoOauthTokens)
    .set({
      accessTokenEncrypted: encrypt(json.access_token),
      refreshTokenEncrypted: newRefreshToken ? encrypt(newRefreshToken) : null,
      expiresAt: newExpiresAt,
    })
    .where(eq(forgejoOauthTokens.id, token.id));

  return json.access_token;
}

/**
 * Persist a freshly-issued token (callback path). Encrypts the envelope
 * columns and UPSERTS the `(userId, forgejoBaseUrl)` row.
 *
 * Kept here so the OAuth callback in `forgejoOauth.ts` doesn't need to
 * know about the encryption envelope — it hands plaintext, we encrypt.
 */
export async function upsertForgejoToken(input: {
  id: string; // ULID — used only on insert
  userId: string;
  forgejoBaseUrl: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  forgejoUserLogin: string;
}): Promise<void> {
  const existing = await database()
    .select({ id: forgejoOauthTokens.id })
    .from(forgejoOauthTokens)
    .where(
      and(
        eq(forgejoOauthTokens.userId, input.userId),
        eq(forgejoOauthTokens.forgejoBaseUrl, input.forgejoBaseUrl),
      ),
    )
    .limit(1);

  const accessEncrypted = encrypt(input.accessToken);
  const refreshEncrypted = input.refreshToken ? encrypt(input.refreshToken) : null;

  if (existing[0]) {
    await database()
      .update(forgejoOauthTokens)
      .set({
        accessTokenEncrypted: accessEncrypted,
        refreshTokenEncrypted: refreshEncrypted,
        expiresAt: input.expiresAt,
        forgejoUserLogin: input.forgejoUserLogin,
      })
      .where(eq(forgejoOauthTokens.id, existing[0].id));
    return;
  }
  await database()
    .insert(forgejoOauthTokens)
    .values({
      id: input.id,
      userId: input.userId,
      forgejoBaseUrl: input.forgejoBaseUrl,
      accessTokenEncrypted: accessEncrypted,
      refreshTokenEncrypted: refreshEncrypted,
      expiresAt: input.expiresAt,
      forgejoUserLogin: input.forgejoUserLogin,
    });
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
