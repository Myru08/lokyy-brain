import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { UpdaterFetch } from "./systemUpdate.js";

/**
 * Story 7.12 Task 4 — `/api/system/update`.
 *
 * The properties worth protecting here are not "does the proxy proxy". They
 * are the three ways this endpoint can hurt someone:
 *
 *   1. **Admin-only** (AC#10). The server is the authority; the UI is only the
 *      convenience. Tested against the real `requireAdmin`, not a mock.
 *   2. **A missing updater is an ANSWER, not a failure.** On Coolify there is
 *      no sidecar and there never will be — `canUpdate: false, reason:
 *      "managed"` in bounded time, never a 500, never a hang.
 *   3. **No job state in the brain.** The brain restarts in the middle of an
 *      update. Every poll must go to the updater, including for a job this
 *      process never saw.
 */

// `@lokyy/core` pulls in modules that read DATABASE_URL at import time.
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

type Mod = typeof import("./systemUpdate.js");

let mod: Mod;

/** `${method} ${path}` → canned answer. Records every call it receives. */
interface Route {
  status: number;
  body?: unknown;
}
function fakeFetch(routes: Record<string, Route>, calls: string[]): UpdaterFetch {
  return async (url, init) => {
    const path = new URL(url).pathname;
    const key = `${init.method} ${path}`;
    calls.push(`${key} auth=${init.headers.authorization ?? ""}`);
    const route = routes[key];
    if (!route) throw new Error(`fake updater has no route for ${key}`);
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body ?? {},
    };
  };
}

/** Never answers; only settles when the abort signal fires. */
const hangingFetch: UpdaterFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

const dead: UpdaterFetch = async () => {
  throw new Error("getaddrinfo ENOTFOUND lokyy-updater");
};

const SNAPSHOT = {
  id: "job-1",
  phase: "build",
  running: true,
  startedAt: "2026-08-03T10:00:00.000Z",
  project: "lokyy-brain",
  targetServices: ["lokyy-brain", "lokyy-pwa"],
  log: ["#1 building"],
};

const LOCAL_ENV = {
  LOKYY_UPDATER_URL: "http://lokyy-updater:8799",
  LOKYY_UPDATER_TOKEN: "a-token-at-least-16-chars",
};

beforeAll(async () => {
  mod = await import("./systemUpdate.js");
});

afterEach(() => {
  delete process.env.LOKYY_UPDATE_MODE;
  delete process.env.LOKYY_UPDATER_URL;
  delete process.env.LOKYY_UPDATER_TOKEN;
});

describe("resolveUpdateMode", () => {
  it("accepts the three documented values, case- and space-insensitively", () => {
    expect(mod.resolveUpdateMode({ LOKYY_UPDATE_MODE: "local" })).toBe("local");
    expect(mod.resolveUpdateMode({ LOKYY_UPDATE_MODE: " MANAGED " })).toBe("managed");
    expect(mod.resolveUpdateMode({ LOKYY_UPDATE_MODE: "Off" })).toBe("off");
  });

  it("treats anything else as 'no override' rather than guessing", () => {
    expect(mod.resolveUpdateMode({})).toBeNull();
    expect(mod.resolveUpdateMode({ LOKYY_UPDATE_MODE: "" })).toBeNull();
    expect(mod.resolveUpdateMode({ LOKYY_UPDATE_MODE: "yes" })).toBeNull();
  });
});

describe("detectCapability", () => {
  it("LOKYY_UPDATE_MODE=off wins and never touches the network", async () => {
    const calls: string[] = [];
    const cap = await mod.detectCapability({
      env: { ...LOCAL_ENV, LOKYY_UPDATE_MODE: "off" },
      fetchImpl: fakeFetch({}, calls),
    });
    expect(cap).toMatchObject({ canUpdate: false, mode: "off", reason: "off" });
    expect(cap.message).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("LOKYY_UPDATE_MODE=managed wins over a reachable updater", async () => {
    const calls: string[] = [];
    const cap = await mod.detectCapability({
      env: { ...LOCAL_ENV, LOKYY_UPDATE_MODE: "managed" },
      fetchImpl: fakeFetch({ "GET /status": { status: 200, body: { canUpdate: true } } }, calls),
    });
    expect(cap).toMatchObject({ canUpdate: false, mode: "managed", reason: "managed" });
    expect(calls).toEqual([]);
  });

  it("no LOKYY_UPDATER_URL (the Coolify case) → managed, without probing", async () => {
    const calls: string[] = [];
    const cap = await mod.detectCapability({ env: {}, fetchImpl: fakeFetch({}, calls) });
    expect(cap).toMatchObject({ canUpdate: false, mode: "managed", reason: "managed", blockers: [] });
    expect(cap.message).toMatch(/Plattform/);
    expect(calls).toEqual([]);
  });

  it("configured but unreachable → managed, not an error", async () => {
    const cap = await mod.detectCapability({ env: LOCAL_ENV, fetchImpl: dead });
    expect(cap).toMatchObject({ canUpdate: false, reason: "managed", mode: "managed" });
  });

  it("an unreachable updater aborts on the timeout instead of hanging", async () => {
    const started = Date.now();
    const cap = await mod.detectCapability({
      env: LOCAL_ENV,
      fetchImpl: hangingFetch,
      timeoutMs: 50,
    });
    expect(cap.canUpdate).toBe(false);
    expect(cap.reason).toBe("managed");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("the default budget is short enough to sit in a request path", () => {
    expect(mod.CAPABILITY_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  });

  it("mode=local + unreachable → 'unreachable', because the operator asserted it should work", async () => {
    const cap = await mod.detectCapability({
      env: { ...LOCAL_ENV, LOKYY_UPDATE_MODE: "local" },
      fetchImpl: dead,
    });
    expect(cap).toMatchObject({ canUpdate: false, mode: "local", reason: "unreachable" });
    expect(cap.message).toContain("http://lokyy-updater:8799");
  });

  it("a reachable, ready updater → canUpdate with project and running job id", async () => {
    const calls: string[] = [];
    const cap = await mod.detectCapability({
      env: LOCAL_ENV,
      fetchImpl: fakeFetch(
        {
          "GET /status": {
            status: 200,
            body: { canUpdate: true, blockers: [], project: "lokyy-brain", currentJobId: "job-9" },
          },
        },
        calls,
      ),
    });
    expect(cap).toEqual({
      canUpdate: true,
      mode: "local",
      reason: null,
      message: null,
      blockers: [],
      currentJobId: "job-9",
      project: "lokyy-brain",
    });
    expect(calls).toEqual(["GET /status auth=Bearer a-token-at-least-16-chars"]);
  });

  it("reachable but blocked → 'blocked' with the updater's own reasons, NOT 'managed'", async () => {
    // Telling a broken local install "your platform handles updates" would send
    // the operator looking in the wrong place forever.
    const cap = await mod.detectCapability({
      env: LOCAL_ENV,
      fetchImpl: fakeFetch(
        {
          "GET /status": {
            status: 200,
            body: { canUpdate: false, blockers: ["the compose project name could not be determined"] },
          },
        },
        [],
      ),
    });
    expect(cap).toMatchObject({ canUpdate: false, mode: "local", reason: "blocked" });
    expect(cap.blockers).toEqual(["the compose project name could not be determined"]);
  });

  it("updater present but the brain has no token → blocked, naming the variable", async () => {
    const calls: string[] = [];
    const cap = await mod.detectCapability({
      env: { LOKYY_UPDATER_URL: LOCAL_ENV.LOKYY_UPDATER_URL },
      fetchImpl: fakeFetch({ "GET /health": { status: 200, body: { ok: true } } }, calls),
    });
    expect(cap.reason).toBe("blocked");
    expect(cap.blockers.join(" ")).toContain("LOKYY_UPDATER_TOKEN");
    expect(calls).toEqual(["GET /health auth="]);
  });

  it("no token AND no updater answering → managed (there simply is no sidecar)", async () => {
    const cap = await mod.detectCapability({
      env: { LOKYY_UPDATER_URL: LOCAL_ENV.LOKYY_UPDATER_URL },
      fetchImpl: dead,
    });
    expect(cap.reason).toBe("managed");
  });

  it("401 from the updater → blocked with a token-mismatch explanation", async () => {
    const cap = await mod.detectCapability({
      env: LOCAL_ENV,
      fetchImpl: fakeFetch({ "GET /status": { status: 401, body: { error: "unauthorized" } } }, []),
    });
    expect(cap.reason).toBe("blocked");
    expect(cap.blockers.join(" ")).toMatch(/token/i);
  });

  it("asks the updater every time — capability is not cached in the brain", async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch({ "GET /status": { status: 200, body: { canUpdate: true } } }, calls);
    await mod.detectCapability({ env: LOCAL_ENV, fetchImpl });
    await mod.detectCapability({ env: LOCAL_ENV, fetchImpl });
    expect(calls).toHaveLength(2);
  });
});

describe("die Sprachgrenze", () => {
  // Als Satz gerendert → deutsch. Maschinenlesbar → englischer Code. Ohne
  // diesen Test wandert beides mit der Zeit auseinander: entweder landet ein
  // englischer Satz in der deutschen Oberflaeche, oder jemand uebersetzt
  // `reason` und bricht damit die Fallunterscheidung in der PWA.
  it("liefert deutsche Prosa, aber englische Codes", async () => {
    const cases = await Promise.all([
      mod.detectCapability({ env: {}, fetchImpl: dead }),
      mod.detectCapability({ env: { ...LOCAL_ENV, LOKYY_UPDATE_MODE: "off" }, fetchImpl: dead }),
      mod.detectCapability({ env: { ...LOCAL_ENV, LOKYY_UPDATE_MODE: "local" }, fetchImpl: dead }),
      mod.detectCapability({
        env: LOCAL_ENV,
        fetchImpl: fakeFetch({ "GET /status": { status: 401, body: {} } }, []),
      }),
    ]);

    for (const cap of cases) {
      // Ein deutscher Satz — erkennbar an einem der haeufigen Funktionswoerter.
      expect(cap.message, JSON.stringify(cap.reason)).toMatch(
        /\b(nicht|ist|kann|der|die|das|dir|du)\b/,
      );
      // Der Code bleibt ein Code: klein, ASCII, aus der bekannten Menge.
      expect(["managed", "off", "blocked", "unreachable"]).toContain(cap.reason);
    }

    const job = await mod.fetchJob("job-1", { env: LOCAL_ENV, fetchImpl: dead });
    expect(job.body.error).toBe("updater-unreachable");
    expect(String(job.body.message)).toMatch(/Updater hat nicht geantwortet/);
  });
});

describe("startUpdate", () => {
  it("refuses without reaching the updater when it cannot update", async () => {
    const calls: string[] = [];
    const res = await mod.startUpdate({ env: {}, fetchImpl: fakeFetch({}, calls) });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "update-unavailable", reason: "managed" });
    expect(calls).toEqual([]);
  });

  it("passes the updater's job snapshot through 1:1 with 202", async () => {
    const res = await mod.startUpdate({
      env: LOCAL_ENV,
      fetchImpl: fakeFetch(
        {
          "GET /status": { status: 200, body: { canUpdate: true, project: "lokyy-brain" } },
          "POST /update": { status: 202, body: SNAPSHOT },
        },
        [],
      ),
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual(SNAPSHOT);
  });

  it("a job already running is a 409 carrying the id to poll, not an error page", async () => {
    const res = await mod.startUpdate({
      env: LOCAL_ENV,
      fetchImpl: fakeFetch(
        {
          "GET /status": { status: 200, body: { canUpdate: true, currentJobId: "job-7" } },
          "POST /update": { status: 409, body: { error: "an update is already running" } },
        },
        [],
      ),
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "job-running", currentJobId: "job-7" });
  });

  it("distinguishes the updater's OTHER 409 — blocked is not 'already running'", async () => {
    // updater/src/index.ts answers 409 for both cases. Sending someone whose
    // compose project cannot be determined off to poll a nonexistent job would
    // be a lie the UI cannot recover from.
    const res = await mod.startUpdate({
      env: LOCAL_ENV,
      fetchImpl: fakeFetch(
        {
          "GET /status": { status: 200, body: { canUpdate: true } },
          "POST /update": {
            status: 409,
            body: { error: "the compose project name could not be determined" },
          },
        },
        [],
      ),
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "update-unavailable", reason: "blocked" });
    expect(res.body.blockers).toEqual(["the compose project name could not be determined"]);
  });

  it("an updater that dies between the probe and the POST → 503, never a 500", async () => {
    let call = 0;
    const res = await mod.startUpdate({
      env: LOCAL_ENV,
      fetchImpl: async (url, init) => {
        call += 1;
        if (call === 1) {
          return { ok: true, status: 200, json: async () => ({ canUpdate: true }) };
        }
        void url;
        void init;
        throw new Error("socket hang up");
      },
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "updater-unreachable" });
  });

  it("an unexpected updater status stays inside the documented vocabulary", async () => {
    const res = await mod.startUpdate({
      env: LOCAL_ENV,
      fetchImpl: fakeFetch(
        {
          "GET /status": { status: 200, body: { canUpdate: true } },
          "POST /update": { status: 500, body: { error: "boom" } },
        },
        [],
      ),
    });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "update-unavailable", reason: "blocked" });
  });
});

describe("fetchJob", () => {
  it("rejects a malformed id before it can reach the updater's URL", async () => {
    const calls: string[] = [];
    for (const bad of ["../status", "a b", "", "x".repeat(65)]) {
      const res = await mod.fetchJob(bad, { env: LOCAL_ENV, fetchImpl: fakeFetch({}, calls) });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid-job-id" });
    }
    expect(calls).toEqual([]);
  });

  it("passes the snapshot through 1:1", async () => {
    const res = await mod.fetchJob("job-1", {
      env: LOCAL_ENV,
      fetchImpl: fakeFetch({ "GET /update/job-1": { status: 200, body: SNAPSHOT } }, []),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SNAPSHOT);
  });

  it("resolves a job this process never started — state lives in the updater", async () => {
    // The brain restarts mid-update. A fresh module instance, no memory of the
    // job, must still be able to report on it.
    const calls: string[] = [];
    const fresh = (await import("./systemUpdate.js")) as Mod;
    const res = await fresh.fetchJob("job-started-before-the-restart", {
      env: LOCAL_ENV,
      fetchImpl: fakeFetch(
        { "GET /update/job-started-before-the-restart": { status: 200, body: SNAPSHOT } },
        calls,
      ),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("hits the updater on every poll — no snapshot is ever cached", async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch({ "GET /update/job-1": { status: 200, body: SNAPSHOT } }, calls);
    await mod.fetchJob("job-1", { env: LOCAL_ENV, fetchImpl });
    await mod.fetchJob("job-1", { env: LOCAL_ENV, fetchImpl });
    expect(calls).toHaveLength(2);
  });

  it("an unknown job is a 404, not a retryable state", async () => {
    const res = await mod.fetchJob("job-x", {
      env: LOCAL_ENV,
      fetchImpl: fakeFetch({ "GET /update/job-x": { status: 404, body: { error: "unknown job" } } }, []),
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "unknown-job" });
  });

  it("an unreachable updater is 503 + retryable — the poller must keep going", async () => {
    const res = await mod.fetchJob("job-1", { env: LOCAL_ENV, fetchImpl: dead });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "updater-unreachable", retryable: true });
  });

  it("an unconfigured updater is 503 but explicitly NOT retryable", async () => {
    const res = await mod.fetchJob("job-1", { env: {}, fetchImpl: dead });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "update-unavailable", retryable: false });
  });
});

describe("routing and the admin gate", () => {
  it("every endpoint is closed to an unauthenticated caller", async () => {
    const app = new Hono();
    app.route("/api/system/update", mod.systemUpdateRoutes);

    for (const [method, path] of [
      ["GET", "/api/system/update"],
      ["POST", "/api/system/update"],
      ["GET", "/api/system/update/job-1"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("serves capability, start and poll through the router for an admin", async () => {
    const calls: string[] = [];
    const app = new Hono();
    app.route(
      "/api/system/update",
      mod.createSystemUpdateRoutes({
        guard: (_c, next) => next(), // stands in for a logged-in admin
        deps: {
          env: LOCAL_ENV,
          fetchImpl: fakeFetch(
            {
              "GET /status": { status: 200, body: { canUpdate: true, project: "lokyy-brain" } },
              "POST /update": { status: 202, body: SNAPSHOT },
              "GET /update/job-1": { status: 200, body: SNAPSHOT },
            },
            calls,
          ),
        },
      }),
    );

    const cap = await app.request("/api/system/update");
    expect(cap.status).toBe(200);
    expect(await cap.json()).toMatchObject({ canUpdate: true, project: "lokyy-brain" });

    const start = await app.request("/api/system/update", { method: "POST" });
    expect(start.status).toBe(202);
    expect(await start.json()).toEqual(SNAPSHOT);

    const poll = await app.request("/api/system/update/job-1");
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual(SNAPSHOT);
  });

  it("is mounted under /api/system/update by the system router", async () => {
    const system = await import("./system.js");
    const app = new Hono();
    app.route("/api/system", system.systemRoutes);
    // 401 (not 404) proves both the mount point and the gate.
    const res = await app.request("/api/system/update", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
