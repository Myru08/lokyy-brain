import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";

/**
 * Story „Session-Auth-Sweep" (issue #37), the other half: the sweep must not
 * have locked out the people who ARE logged in (AC#4).
 *
 * Separate file because the fixture is a module mock, and `vi.mock` is hoisted
 * to the top of whatever file it appears in — the anonymous suite in
 * `apiGuards.test.ts` has to see the real `getSessionUser` to be worth
 * anything.
 *
 * Two seams are faked, both of them the ones that would otherwise need a live
 * Postgres, and neither of them the code under test:
 *   - `getSessionUser` resolves exactly one fixture session id;
 *   - `setupGate` passes, standing in for a completed setup.
 * The guard chain itself, the routing and the handlers are real.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

const SESSION_ID = "01JQ0000000000000000000000";

const FIXTURE_USER = {
  id: "01JQAAAAAAAAAAAAAAAAAAAAAA",
  email: "operator@test.local",
  name: "Test Operator",
  role: "admin",
  passwordHash: "not-a-real-hash",
  createdAt: new Date(0),
  lastLoginAt: null,
};

vi.mock("../auth/sessions.js", () => ({
  getSessionUser: async (id: string) => (id === SESSION_ID ? FIXTURE_USER : null),
  createSession: async () => ({ id: SESSION_ID, expiresAt: new Date() }),
  deleteSession: async () => {},
}));

vi.mock("./setupGate.js", () => ({
  setupGate: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const COOKIE = { Cookie: `lokyy_session=${SESSION_ID}` };

let app: Hono;

beforeAll(async () => {
  const mod = await import("../app.js");
  app = mod.createApp();
});

describe("a valid session passes the gate", () => {
  /**
   * `/api/logs` is the honest end-to-end case available without a vault on
   * disk: the handler reads the in-process ring buffer, so a 200 here proves
   * the whole chain — CORS, vault switcher, `requireAuth`, `setupGate`, routing
   * — carries a logged-in request through to a real response body.
   */
  it("serves GET /api/logs with a session cookie", async () => {
    const res = await app.request("/api/logs", { headers: COOKIE });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it("still refuses the same request without the cookie", async () => {
    const res = await app.request("/api/logs");

    expect(res.status).toBe(401);
  });

  /**
   * The routes that need the vault (notes, graph, tree) cannot answer 200 in a
   * unit test — there is no working copy — but the property that matters here
   * is that the GUARD is no longer what stops them. Anything other than 401
   * means the request reached its handler.
   */
  it.each([
    ["GET", "/api/notes"],
    ["GET", "/api/graph"],
    ["GET", "/api/vault/tree"],
  ])("lets %s %s reach its handler", async (method, path) => {
    const res = await app.request(path, { method, headers: COOKIE });

    expect(res.status).not.toBe(401);
  });

  /**
   * Mirror of the "401 before body validation" case in the anonymous suite: the
   * SAME broken body, now with a session, gets as far as the validator. Without
   * this the 401 above would also be satisfied by a route that is simply dead.
   */
  it("reaches body validation on a write once authenticated", async () => {
    const res = await app.request("/api/notes/inbox/note.md", {
      method: "PUT",
      headers: { ...COOKIE, "Content-Type": "application/json" },
      body: "{ this is not json",
    });

    expect(res.status).not.toBe(401);
  });
});
