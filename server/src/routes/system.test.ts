import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";

/**
 * Story 7.12 — `GET /api/system/version`.
 *
 * Two properties are asserted here, both of them AC#3 ("a failed check is
 * invisible and folgenlos"):
 *   1. The handler answers from the in-memory cache only — it never awaits a
 *      network request, so a page view cannot hang on GitHub being slow.
 *   2. With the check disabled (or never run), the response is a well-formed
 *      object with `updateAvailable: false` — not an error, not a 500.
 */

// `server/src/config.ts` reads process.env at import time; the route module
// itself doesn't need it, but @lokyy/core pulls in modules that do.
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

type CoreMod = typeof import("@lokyy/core");
type SystemMod = typeof import("./system.js");

let core: CoreMod;
let app: Hono;

const SAMPLE_CHANGELOG = ["# Changelog", "", "## v99.0 — 2099-01-01", "", "- future", ""].join(
  "\n",
);

beforeAll(async () => {
  core = await import("@lokyy/core");
  const mod: SystemMod = await import("./system.js");
  app = new Hono();
  app.route("/api/system", mod.systemRoutes);
});

afterEach(() => {
  core.resetUpdateCheckCacheForTests();
  delete process.env.LOKYY_UPDATE_CHECK;
});

describe("GET /api/system/version", () => {
  it("reports the running build version and a well-formed payload", async () => {
    // Disabled → the handler must not kick off any background network call.
    process.env.LOKYY_UPDATE_CHECK = "off";

    const res = await app.request("/api/system/version");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      updateAvailable: false,
      latest: null,
      highlights: [],
      status: "disabled",
    });
    expect(typeof body.running === "string" || body.running === null).toBe(true);
    expect(core.parseVersion(body.running)).not.toBeNull();
  });

  it("serves the cached check result without touching the network", async () => {
    let fetches = 0;
    await core.refreshUpdateCheck({
      env: {},
      runningVersion: "1.11.0",
      fetchImpl: async () => {
        fetches += 1;
        return { ok: true, status: 200, text: async () => SAMPLE_CHANGELOG };
      },
    });

    const res = await app.request("/api/system/version");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.latest).toBe("v99.0");
    expect(body.updateAvailable).toBe(true);
    expect(body.highlights).toEqual(["- future"]);
    expect(typeof body.checkedAt).toBe("string");
    // One refresh in the arrange step, none added by serving the request.
    expect(fetches).toBe(1);
  });

  it("answers immediately — no awaiting of a remote request in the UI path", async () => {
    process.env.LOKYY_UPDATE_CHECK = "off";
    const started = Date.now();
    const res = await app.request("/api/system/version");
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
