import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";

/**
 * Story „Session-Auth-Sweep" (issue #37) — the regression guard for the hole a
 * beta tester found: `GET /api/notes` answered an anonymous caller with 200 and
 * note bodies, and the write routes got as far as body validation (400) before
 * anyone asked who was calling.
 *
 * These cases run against the REAL app from `app.ts` — the same mount table the
 * container serves — not a stand-in. That is the whole point: a test over a
 * hand-built app would pass while production stayed open.
 *
 * No database is needed and none must be reachable. `requireAuth` runs ahead of
 * `setupGate` and short-circuits on the missing cookie, so an anonymous request
 * never gets far enough to open a connection. If someone reorders those two
 * middlewares, this suite starts failing with a connection error rather than
 * quietly passing — which is the correct outcome, because that order is what
 * keeps an unauthenticated request free.
 */

// `server/src/config.ts` reads process.env at import time and throws without
// DATABASE_URL. Nothing here ever connects — see the note above.
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

let app: Hono;

beforeAll(async () => {
  const mod = await import("../app.js");
  app = mod.createApp();
});

/**
 * One representative request per guarded route group (AC#1/AC#8). Reads and
 * writes both, because the bug had two faces: leaked GETs and write routes that
 * reached their validators.
 */
const GUARDED_REQUESTS: ReadonlyArray<[string, string, RequestInit?]> = [
  ["GET", "/api/notes"],
  ["GET", "/api/notes/10_projects/lokyy/README.md"],
  ["GET", "/api/vault/tree"],
  ["GET", "/api/graph"],
  ["GET", "/api/graph/tags"],
  ["GET", "/api/pipes"],
  ["GET", "/api/llm/config"],
  ["GET", "/api/diagnostics"],
  ["GET", "/api/logs"],
  ["GET", "/api/scoring"],
  ["GET", "/api/intent"],
  ["GET", "/api/hyde"],
  ["GET", "/api/self-rag"],
  ["GET", "/api/traces"],
  ["GET", "/api/sleep-agent/runs"],
  ["GET", "/api/backfill/status"],
  ["GET", "/api/mem0/review"],
  ["GET", "/api/ppr"],
  ["GET", "/api/rerank"],
  ["GET", "/api/surface"],
  ["GET", "/api/working-memory"],
  ["GET", "/api/layout"],
  ["GET", "/api/encoding"],
  ["GET", "/api/edges/pruned"],
  ["GET", "/api/temporal-edges/from/abc"],
  ["GET", "/api/lint/findings"],
  ["GET", "/api/agent-review/queue"],
  ["GET", "/api/entities"],
  ["GET", "/api/peers"],
  ["GET", "/api/skills"],
  ["GET", "/api/dataview"],
  ["GET", "/api/templates"],
  ["GET", "/api/voice/settings"],
  ["GET", "/api/system/version"],
  ["GET", "/api/workspace/menu"],
  ["GET", "/api/dashboard"],
  ["GET", "/api/settings/runtime"],
  // Writes — these are the ones that used to answer 400 after reading a body.
  [
    "POST",
    "/api/search",
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "geheim" }) },
  ],
  // Sub-paths of the `app.route("/api", searchRoutes)` mount. These carried NO
  // gate at all before the sweep — the old `setupGate` was pinned to the exact
  // path `/api/search` and never saw `/api/search/hybrid`.
  [
    "POST",
    "/api/search/hybrid",
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "geheim" }) },
  ],
  ["GET", "/api/notes/x.md/related"],
  [
    "POST",
    "/api/notes",
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "x.md", body: "pwned" }),
    },
  ],
  [
    "POST",
    "/api/notes/x.md/forget",
    { headers: { "Content-Type": "application/json" }, body: "{}" },
  ],
  [
    "PUT",
    "/api/workspace/menu",
    { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [] }) },
  ],
];

describe("unauthenticated callers get 401 on every data route", () => {
  it.each(GUARDED_REQUESTS)("%s %s → 401", async (method, path, init) => {
    const res = await app.request(path, { method, ...(init ?? {}) });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  /**
   * AC#3, stated as its own case because it is the property that was violated
   * most visibly: an unparseable body must not be parsed at all. A 400 here
   * would prove the handler ran before anyone checked for a session.
   */
  it("rejects a write with a broken body as 401, never 400", async () => {
    const res = await app.request("/api/notes/inbox/note.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not json",
    });

    expect(res.status).toBe(401);
  });

  it("ignores a bogus session cookie", async () => {
    const res = await app.request("/api/notes", {
      headers: { Cookie: "lokyy_session=not-a-real-session-id" },
    });

    // A cookie that does not resolve to a live session row is the one case that
    // DOES reach the database — so this only asserts that it never yields data.
    expect([401, 500]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});

describe("routes that stay open", () => {
  it("serves /health without a session (the updater polls it during restarts)", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("does not put the session gate in front of /api/auth", async () => {
    // `/api/auth/me` answers its own 401 for a guest — the distinguishing
    // property is that the request reaches the handler, so it must not be
    // possible to reach it via the guard. Asserted through the guard table
    // rather than the status code, which is 401 either way.
    const { GUARDED_API_PREFIXES } = await import("./apiGuards.js");
    expect(GUARDED_API_PREFIXES).not.toContain("/api/auth");
    expect(GUARDED_API_PREFIXES).not.toContain("/api/setup");
  });
});

/**
 * CORS (AC#5). The wildcard is gone from the cookie-authenticated surface: an
 * unlisted origin gets no `Access-Control-Allow-Origin` header at all, so the
 * browser refuses to hand the response to the calling page.
 */
describe("CORS on /api", () => {
  it("never answers a foreign origin with an allow header", async () => {
    const res = await app.request("/api/notes", {
      headers: { Origin: "https://evil.example.com" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes a configured origin and allows credentials", async () => {
    const res = await app.request("/api/notes", {
      headers: { Origin: "http://localhost:5173" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  /**
   * A preflight carries no cookies — browsers never attach them to OPTIONS. If
   * the guard ran first, every cross-origin PUT/DELETE would die at the
   * preflight with a 401 that no amount of logging in could fix. CORS is
   * therefore registered ahead of the guards, and this pins that order.
   */
  it("answers a preflight without demanding a session", async () => {
    const res = await app.request("/api/notes/x.md", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "PUT",
      },
    });

    expect(res.status).not.toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  /**
   * /mcp keeps the wildcard it always had — it is bearer-authenticated, never
   * cookie-authenticated, so the risk the /api rules address does not exist
   * there. Tightening it would break the claude.ai connector for no gain.
   */
  it("leaves the MCP endpoint's permissive CORS alone", async () => {
    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://claude.ai", "Access-Control-Request-Method": "POST" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("reads the allowed origins from LOKYY_CORS_ORIGINS", async () => {
    const { corsOrigins } = await import("../app.js");

    expect(corsOrigins({} as NodeJS.ProcessEnv)).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
    expect(
      corsOrigins({
        LOKYY_CORS_ORIGINS: " https://brain.example.com/ , https://lokyy.example.com ",
      } as NodeJS.ProcessEnv),
    ).toEqual(["https://brain.example.com", "https://lokyy.example.com"]);
  });
});

/**
 * Drift guard, default-deny. The behavioural cases above only cover the
 * prefixes someone remembered to list; this one asks the LIVE router what it
 * actually serves and fails when ANY `/api` path is neither guarded nor on the
 * documented open list. Same idea as the schema drift-guard in
 * `packages/core/src/frontmatter/frontmatter.test.ts`.
 *
 * It reads `createApp().routes` — Hono's runtime registry of every registered
 * route and middleware, each entry a `{ method, path }` with the mount prefix
 * already prepended (`app.route("/api/notes", …)` → `/api/notes`,
 * `/api/notes/:id{.+}`, …). This is strictly stronger than the old test, which
 * grepped `app.route("…")` string literals out of `app.ts`: a mount added in a
 * DIFFERENT file, or via `app.use`/`app.get` rather than `app.route`, was
 * invisible to the text scan but shows up here the moment it is registered.
 *
 * Coverage is decided by {@link unclassifiedApiPaths} using segment-prefix
 * matching (a path is covered when it equals a table prefix or begins with
 * `${prefix}/`); the only paths exempt by construction are the full-surface
 * wildcards in {@link API_SURFACE_WILDCARDS} (the CORS + vault-switcher
 * `/api/*` middleware), documented there.
 */
describe("guard table covers every registered /api path (default-deny)", () => {
  it("has no unclassified path in the live router registry", async () => {
    const { unclassifiedApiPaths } = await import("./apiGuards.js");

    const registered = app.routes.map((route) => route.path);
    // Sanity: the registry is populated (guards against a silently empty app
    // that would make the assertion below pass vacuously).
    expect(registered.filter((path) => path.startsWith("/api")).length).toBeGreaterThan(20);

    // The message names the offending path(s) so a forgotten entry reads as
    // "classify /api/newthing", not an opaque array-mismatch.
    expect(unclassifiedApiPaths(registered)).toEqual([]);
  });

  /**
   * Calibration in the opposite direction: prove the guard actually goes red.
   * Feeding the pure classifier a synthetic registry that includes an
   * unguarded mount must surface exactly that path — a green-only test would
   * pass even if the matching rule were `() => true`. Isolated (no app
   * mutation) so it can never leave the real router in a rogue state.
   */
  it("flags an unguarded mount that is on neither list", async () => {
    const { unclassifiedApiPaths } = await import("./apiGuards.js");

    const synthetic = [
      "/api/notes", // guarded — must NOT be flagged
      "/api/auth/me", // open — must NOT be flagged
      "/api/rogue", // unguarded bare mount
      "/api/rogue/:id{.+}", // …and its subtree
    ];

    expect(unclassifiedApiPaths(synthetic)).toEqual(["/api/rogue", "/api/rogue/:id{.+}"]);
  });
});
