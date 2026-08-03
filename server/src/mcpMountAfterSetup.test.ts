import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

/**
 * Story 7.11 / issue #14 — `/mcp` must become usable after the setup wizard
 * WITHOUT a container restart.
 *
 * The bug: `initMcp()` ran exactly once at boot. On a fresh install the DB is
 * empty at that moment, `resolveVaultId` throws, `ready` stays `false`, and the
 * `/mcp` handler answered 503 forever — including for the token the wizard had
 * just minted and advertised as "gilt sofort, ohne Neustart".
 *
 * This test walks the real sequence against a REAL Postgres: boot with an empty
 * DB → 503 → run `POST /api/setup/complete` → `/mcp` live, same process.
 *
 * GATED behind `LOKYY_TEST_DATABASE_URL` like `tenants.test.ts` / the Story 7.10
 * suite. It provisions its OWN throwaway database (the fixture needs a
 * guaranteed-empty `vaults` table, which a shared DB cannot promise) and drops
 * it again in `afterAll`:
 *
 *   docker run -d --rm --name lokyy-test-pg \
 *     -e POSTGRES_PASSWORD=testpw -p 55432:5432 paradedb/paradedb:latest-pg17
 *   LOKYY_TEST_DATABASE_URL=postgres://postgres:testpw@localhost:55432/postgres \
 *     pnpm --filter server test
 *
 * Only the MCP SDK surface is mocked (`initServerDeps`, `handleMcpHttp`) — the
 * vault resolution under test runs for real against the database.
 */

const ADMIN_URL = process.env.LOKYY_TEST_DATABASE_URL;

// `vi.hoisted` so the spy survives the `vi.resetModules()` in the race test —
// the mock factory is re-evaluated per module graph, the counter must not be.
const mcpSdk = vi.hoisted(() => ({
  initServerDeps: vi.fn(async () => {}),
  handleMcpHttp: vi.fn(async () => {}),
}));

vi.mock("@lokyy/mcp/dist/server.js", () => ({ initServerDeps: mcpSdk.initServerDeps }));
vi.mock("@lokyy/mcp/dist/inProcess.js", () => ({ handleMcpHttp: mcpSdk.handleMcpHttp }));

describe.skipIf(!ADMIN_URL)("/mcp after setup, no restart (Story 7.11)", () => {
  let dbName: string;
  let dbUrl: string;
  let admin: ReturnType<typeof postgres>;
  let base: string;
  let core: typeof import("@lokyy/core");
  let app: Hono;
  let mintedToken: string | null = null;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "lokyy-mcp-after-setup-"));

    // A dedicated, guaranteed-empty database — the whole point of the fixture.
    dbName = `lokyy_t711_${Date.now().toString(36)}`;
    admin = postgres(ADMIN_URL!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const parsed = new URL(ADMIN_URL!);
    parsed.pathname = `/${dbName}`;
    dbUrl = parsed.toString();

    // `server/src/config.ts` reads process.env at MODULE-IMPORT time → env
    // first, dynamic imports after. No LOKYY_MCP_TOKEN: this is the fresh-
    // install shape from the issue, where /mcp runs on DB-backed tokens only.
    process.env.DATABASE_URL = dbUrl;
    process.env.VAULT_DIR = join(base, "vault");
    process.env.GIT_AUTHOR_NAME = "lokyy-test";
    process.env.GIT_AUTHOR_EMAIL = "test@localhost";
    process.env.GIT_REMOTE = "";
    delete process.env.LOKYY_VAULT_ID;
    delete process.env.LOKYY_MCP_TOKEN;

    core = await import("@lokyy/core");
    core.initDb(dbUrl);
    await core.runMigrations(dbUrl);
    core.initCore({
      vaultDir: join(base, "vault"),
      vaultsRoot: join(base, "vaults"),
      gitRemote: "",
      gitBranch: "main",
      gitAuthorName: "lokyy-test",
      gitAuthorEmail: "test@localhost",
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  }, 180_000);

  afterAll(async () => {
    if (admin) {
      try {
        await admin.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`,
        );
        await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
      } catch {
        /* throwaway database — a leftover must not fail the suite */
      }
      await admin.end();
    }
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("boots with an empty DB and answers 503 naming the setup wizard (AC#2, AC#3)", async () => {
    const { initMcp, mountMcp } = await import("./mcpMount.js");
    const { setupRoutes } = await import("./routes/setup.js");

    app = new Hono();
    mountMcp(app);
    app.route("/api/setup", setupRoutes);

    // Mirrors index.ts main(): best-effort, a failure must not abort startup.
    let aborted = false;
    try {
      await initMcp();
    } catch {
      aborted = false;
    }
    expect(aborted).toBe(false);

    const res = await app.request("/mcp", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("mcp-unavailable");
    expect(body.message).toMatch(/Setup/i);
  });

  it("goes live on the next request once the wizard completed — no restart (AC#1)", async () => {
    // The wizard's effect: an admin user and the operator's own vault exist.
    const adminId = core.generateUlid();
    await core.database().insert(core.users).values({
      id: adminId,
      email: `admin-${adminId}@test.local`,
      passwordHash: "not-a-real-hash",
      name: "Test Admin",
      role: "admin",
    });
    await core.database().insert(core.vaults).values({
      id: core.generateUlid(),
      name: "Mein Vault",
      slug: `mein-vault-${Date.now().toString(36)}`,
      kind: "personal",
      ownerId: adminId,
      gitRemote: "",
      gitBranch: "main",
    });

    const complete = await app.request("/api/setup/complete", { method: "POST" });
    expect(complete.status).toBe(200);
    const completeBody = (await complete.json()) as { mcpToken: string | null };
    mintedToken = completeBody.mcpToken;
    expect(mintedToken).toBeTruthy();

    // Same process, no re-import, no restart — exactly what the issue asked for.
    // The `{}` third arg stands in for the Hono env: in production
    // @hono/node-server puts the raw `incoming`/`outgoing` there, `app.request()`
    // leaves it undefined, so we hand over an empty one deliberately.
    const res = await app.request(
      "/mcp",
      { method: "POST", headers: { authorization: `Bearer ${mintedToken}` } },
      {},
    );

    // Not 503 any more. `hono`'s `app.request()` has no raw Node req/res, so the
    // handler stops at the `mcp-no-raw-io` guard — which it can only reach once
    // `ready` is true. That IS the assertion: the mount initialised lazily.
    expect(res.status).not.toBe(503);
    expect(await res.json()).toEqual({ error: "mcp-no-raw-io" });
  });

  it("concurrent first requests initialise exactly once (AC#4)", async () => {
    vi.resetModules();
    mcpSdk.initServerDeps.mockClear();

    const { mountMcp } = await import("./mcpMount.js");
    const fresh = new Hono();
    mountMcp(fresh);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fresh.request("/mcp", { method: "POST" }, {})),
    );

    for (const res of responses) expect(res.status).not.toBe(503);
    expect(mcpSdk.initServerDeps).toHaveBeenCalledTimes(1);
  });
});
