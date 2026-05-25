import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { database, vaultMemberships, type User } from "@lokyy/core";
import { getSessionUser } from "../auth/sessions.js";

type Role = "read" | "write" | "admin";

const ROLE_RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };

declare module "hono" {
  interface ContextVariableMap {
    user: User;
    vaultId: string;
    vaultRole: Role;
  }
}

/**
 * Story 3.3 — Server-side vault access enforcement.
 *
 * Guards every `/api/vaults/:vaultId/...` route. Loads the session, looks
 * up the membership for (user, vaultId), enforces minimum role. Non-member
 * → 404 (avoids leaking vault existence). Member but insufficient role → 403.
 */
export function vaultGuard(requiredRole: Role = "read"): MiddlewareHandler {
  return async (c, next) => {
    const sid = getCookie(c, "lokyy_session");
    if (!sid) return c.json({ error: "unauthenticated" }, 401);
    const user = await getSessionUser(sid);
    if (!user) return c.json({ error: "unauthenticated" }, 401);

    const vaultId = c.req.param("vaultId");
    if (!vaultId) return c.json({ error: "vaultId required" }, 400);

    const membership = await database()
      .select()
      .from(vaultMemberships)
      .where(
        and(eq(vaultMemberships.userId, user.id), eq(vaultMemberships.vaultId, vaultId)),
      )
      .limit(1);
    const m = membership[0];

    if (!m) {
      // 404 — don't leak existence to non-members.
      return c.json({ error: "not-found" }, 404);
    }

    if (ROLE_RANK[m.role as Role] < ROLE_RANK[requiredRole]) {
      return c.json({ error: "vault-permission" }, 403);
    }

    c.set("user", user);
    c.set("vaultId", vaultId);
    c.set("vaultRole", m.role as Role);
    return next();
  };
}
