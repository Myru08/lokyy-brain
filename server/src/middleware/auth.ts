import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { User } from "@lokyy/core";
import { getSessionUser } from "../auth/sessions.js";

/**
 * Owner/session auth gates (LBMT — security hardening).
 *
 * The tenant-management API (`/api/tenants`), the vault list (`/api/vaults`)
 * and the admin API (`/api/admin`) were reachable by anyone who knew the URL.
 * These gates bind them to the operator's login session (cookie `lokyy_session`,
 * same mechanism as the rest of the app). The MCP endpoint (`/mcp`) is NOT
 * affected — it routes by bearer token, not session.
 */
async function sessionUser(c: Context): Promise<User | null> {
  const sid = getCookie(c, "lokyy_session");
  if (!sid) return null;
  return getSessionUser(sid);
}

/** Any logged-in user. 401 otherwise. Sets `c.var.user`. */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const user = await sessionUser(c);
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  c.set("user", user);
  return next();
};

/** Logged-in AND role=admin (the operator/owner). 401 unauth, 403 non-admin. */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const user = await sessionUser(c);
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  if (user.role !== "admin") return c.json({ error: "forbidden" }, 403);
  c.set("user", user);
  return next();
};
