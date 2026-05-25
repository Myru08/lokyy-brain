import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import {
  database,
  users,
  vaults,
  vaultMemberships,
  generateUlid,
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

function sessionCookieOpts(expires: Date) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: false, // Dev: HTTP. Set true behind HTTPS reverse proxy in prod.
    expires,
  };
}

/**
 * Story 3.2 — Personal Vault Auto-Provision.
 * On user creation we create a vaults row + admin membership.
 * The actual Forgejo repo provisioning is out of scope here (the user's
 * existing Forgejo instance is assumed; the row holds whatever git_remote
 * the admin enters when they first sign in and configure their vault).
 */
async function autoProvisionPersonalVault(userId: string, name: string): Promise<void> {
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
}
