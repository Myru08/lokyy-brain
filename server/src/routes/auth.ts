import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { count as countFn } from "drizzle-orm";
import {
  database,
  users,
  vaults,
  vaultMemberships,
  generateUlid,
  invalidateActiveVaultId,
} from "@lokyy/core";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import { createSession, deleteSession, getSessionUser } from "../auth/sessions.js";

const COOKIE = "lokyy_session";

export const authRoutes = new Hono();

// POST /api/auth/register
authRoutes.post("/register", async (c) => {
  const { email, password, name } = await c.req.json<{
    email: string;
    password: string;
    name: string;
  }>();
  if (!email || !password || !name) {
    return c.json({ error: "email, password, name required" }, 400);
  }

  const existing = await database().select().from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) {
    return c.json({ error: "email-taken" }, 409);
  }

  const passwordHash = await hashPassword(password);
  const id = generateUlid();
  await database().insert(users).values({ id, email, passwordHash, name, role: "user" });

  await autoProvisionPersonalVault(id, name);

  const session = await createSession(id);
  setCookie(c, COOKIE, session.id, sessionCookieOpts(session.expiresAt));
  return c.json({ userId: id, email, name });
});

// POST /api/auth/login
authRoutes.post("/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: "email and password required" }, 400);
  const row = await database().select().from(users).where(eq(users.email, email)).limit(1);
  const user = row[0];
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: "invalid-credentials" }, 401);
  }
  const session = await createSession(user.id);
  setCookie(c, COOKIE, session.id, sessionCookieOpts(session.expiresAt));
  return c.json({
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });
});

// POST /api/auth/logout
authRoutes.post("/logout", async (c) => {
  const sid = getCookie(c, COOKIE);
  if (sid) await deleteSession(sid);
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// GET /api/auth/me
authRoutes.get("/me", async (c) => {
  const sid = getCookie(c, COOKIE);
  if (!sid) return c.json({ error: "unauthenticated" }, 401);
  const user = await getSessionUser(sid);
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  return c.json({
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });
});

/**
 * Resolve the `secure` flag for the session cookie.
 *
 * `LOKYY_COOKIE_SECURE=true|false` is an explicit override and always wins.
 * Otherwise we default to secure in production (`NODE_ENV === "production"`)
 * and insecure in dev — a `secure` cookie is dropped by the browser over
 * plain HTTP, which would lock out the local HTTP login, so dev must stay
 * `false` while a prod deployment behind an HTTPS reverse proxy gets `true`.
 */
export function resolveCookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.LOKYY_COOKIE_SECURE?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return env.NODE_ENV === "production";
}

function sessionCookieOpts(expires: Date) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    // Env-driven: secure behind HTTPS/reverse-proxy in prod, off for local
    // HTTP dev. See resolveCookieSecure() for the derivation.
    secure: resolveCookieSecure(),
    expires,
  };
}

/**
 * Story 3.2 — Personal Vault Auto-Provision.
 * On user creation we create a vaults row + admin membership.
 * The actual Forgejo repo provisioning is out of scope here (the user's
 * existing Forgejo instance is assumed; the row holds whatever git_remote
 * the admin enters when they first sign in and configure their vault).
 *
 * issue #43 — accidental-second-vault guard.
 * This runs for EVERY new registration, which is correct for a legitimate
 * multi-tenant deployment (each user owns their vault). But in a single-user /
 * local setup a stray second registration (a mistyped login, an agent hitting
 * `/register`) used to SILENTLY add a second vault row, making the active-vault
 * choice ambiguous — search and indexing could then diverge across vaults.
 *
 * We deliberately do NOT hard-block the second vault: that would break real
 * multi-tenant use, and we cannot reliably tell "legitimate second tenant" from
 * "accidental re-register" here. Instead we make it SAFE and VISIBLE:
 *   - the deterministic resolver (see `indexVaultId` / `selectActiveVault`)
 *     keeps search and index on ONE real vault (the oldest) regardless;
 *   - we invalidate the active-vault cache so that choice re-resolves; and
 *   - we log a loud warning when an unpinned install grows a second vault.
 * The `/api/vaults` list surfaces the same `ambiguous` flag for the UI.
 *
 * PRODUCT DECISION (for Oliver to confirm): should `/register` be gated in a
 * single-user install — e.g. refuse a second vault unless `LOKYY_VAULT_ID` is
 * pinned or multi-tenant is explicitly enabled? Until decided, the safe
 * non-breaking behaviour above stands.
 */
async function autoProvisionPersonalVault(userId: string, name: string): Promise<void> {
  // Count BEFORE inserting so we can tell a first vault from a subsequent one.
  // `Number(...)` guards against the driver surfacing a bigint aggregate as a
  // string (would otherwise make `existingVaults + 1` a string concat).
  const [row] = await database().select({ n: countFn() }).from(vaults);
  const existingVaults = Number(row?.n ?? 0);

  const vaultId = generateUlid();
  const slug = `personal-${userId.toLowerCase().slice(-8)}`;
  await database().insert(vaults).values({
    id: vaultId,
    name: `${name}'s Personal Vault`,
    slug,
    kind: "personal",
    ownerId: userId,
    gitRemote: "", // user fills via Settings later
    gitBranch: "main",
  });
  await database().insert(vaultMemberships).values({
    userId,
    vaultId,
    role: "admin",
  });

  // A new vault row changes the deterministic active-vault choice — drop the
  // cache so the next search/index resolution reflects reality (still the
  // oldest, so this registration cannot hijack the active vault).
  invalidateActiveVaultId();

  const pinned = (process.env.LOKYY_VAULT_ID ?? "").trim().length > 0;
  if (existingVaults >= 1 && !pinned) {
    console.warn(
      `[auth/register] a vault already existed and no LOKYY_VAULT_ID is pinned — ` +
        `registration created an ADDITIONAL vault (${vaultId}). Now ${existingVaults + 1} ` +
        `vaults exist; search/index deterministically stay on the OLDEST. If this ` +
        `is a single-user install this second vault is probably accidental — pin ` +
        `LOKYY_VAULT_ID or remove the stray vault.`,
    );
  }
}
