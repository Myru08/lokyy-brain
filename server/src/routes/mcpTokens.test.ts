import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

/**
 * Story 7.10 — own-vault MCP token lifecycle over `/api/admin/mcp-tokens`.
 *
 * Covers AC#9's three named guarantees:
 *   1. the setup completion mints a real token (no shared default left behind),
 *   2. the plaintext is NEVER persisted — only its SHA-256,
 *   3. a revoked token stops authenticating (lookup → null → 401 at `/mcp`).
 *
 * GATED behind `LOKYY_TEST_DATABASE_URL` exactly like `tenants.test.ts`: the
 * handlers do real `database()` writes, so a run without a Postgres must stay
 * green. Use a THROWAWAY database (ParadeDB image, same as docker-compose.yml):
 *
 *   docker run -d --rm --name lokyy-test-pg \
 *     -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=lokyy_test \
 *     -p 55432:5432 paradedb/paradedb:latest-pg17
 *   LOKYY_TEST_DATABASE_URL=postgres://postgres:testpw@localhost:55432/lokyy_test \
 *     pnpm --filter server test
 */

const DB_URL = process.env.LOKYY_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("own-vault MCP tokens (Story 7.10)", () => {
  let core: typeof import("@lokyy/core");
  let app: Hono;
  let base: string;
  let adminId: string;
  let sessionId: string;
  let cookie: string;
  let vaultId: string;
  let foreignVaultId: string;
  let foreignTokenId: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "lokyy-mcp-tokens-"));

    // `server/src/config.ts` reads process.env at MODULE-IMPORT time and throws
    // without DATABASE_URL → env first, dynamic imports after.
    process.env.DATABASE_URL = DB_URL!;
    process.env.VAULT_DIR = join(base, "vault");
    process.env.GIT_AUTHOR_NAME = "lokyy-test";
    process.env.GIT_AUTHOR_EMAIL = "test@localhost";
    delete process.env.LOKYY_VAULT_ID;
    // AC#7: the shared public default in use → the API must flag it insecure.
    process.env.LOKYY_MCP_TOKEN = "local_dev_token_change_me_32_chars_min";

    core = await import("@lokyy/core");
    core.initDb(DB_URL!);
    await core.runMigrations(DB_URL!);
    core.initCore({
      vaultDir: join(base, "vault"),
      vaultsRoot: join(base, "vaults"),
      gitRemote: "",
      gitBranch: "main",
      gitAuthorName: "lokyy-test",
      gitAuthorEmail: "test@localhost",
    });

    adminId = core.generateUlid();
    await core.database().insert(core.users).values({
      id: adminId,
      email: `admin-${adminId}@test.local`,
      passwordHash: "not-a-real-hash",
      name: "Test Admin",
      role: "admin",
    });
    sessionId = core.generateUlid();
    await core.database().insert(core.sessions).values({
      id: sessionId,
      userId: adminId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    cookie = `lokyy_session=${sessionId}`;

    // The operator's OWN vault (kind: personal) …
    vaultId = core.generateUlid();
    await core.database().insert(core.vaults).values({
      id: vaultId,
      name: "Mein Vault",
      slug: `mein-vault-${Date.now().toString(36)}`,
      kind: "personal",
      ownerId: adminId,
      gitRemote: "",
      gitBranch: "main",
    });
    // … plus an unrelated CUSTOMER vault, to prove the own-vault surface can
    // neither list nor revoke another vault's tokens.
    foreignVaultId = core.generateUlid();
    await core.database().insert(core.vaults).values({
      id: foreignVaultId,
      name: "Kunde GmbH",
      slug: `kunde-${Date.now().toString(36)}`,
      kind: "shared",
      ownerId: adminId,
      gitRemote: "",
      gitBranch: "main",
    });
    const foreign = await core.createMcpToken({
      vaultId: foreignVaultId,
      agentId: "kunde-acme",
      role: "write",
      label: "Kunde",
    });
    foreignTokenId = foreign.row.id;

    const { adminRoutes } = await import("./admin.js");
    app = new Hono();
    app.route("/api/admin", adminRoutes);
  }, 120_000);

  afterAll(async () => {
    if (core) {
      for (const id of [vaultId, foreignVaultId].filter(Boolean)) {
        // mcp_tokens cascade with the vault row (FK ON DELETE CASCADE).
        await core.database().delete(core.vaults).where(eq(core.vaults.id, id));
      }
      if (adminId) {
        await core
          .database()
          .delete(core.sessions)
          .where(eq(core.sessions.id, sessionId));
        await core.database().delete(core.users).where(eq(core.users.id, adminId));
      }
      await core.closeDb();
    }
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("requires an admin session (AC#8)", async () => {
    const res = await app.request("/api/admin/mcp-tokens");
    expect(res.status).toBe(401);
  });

  it("flags the shared public default token as insecure (AC#7)", async () => {
    const res = await app.request("/api/admin/mcp-tokens", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vaultId).toBe(vaultId);
    expect(body.envToken).toMatchObject({ configured: true, shared: true });
    // The env value itself must never leave the server.
    expect(JSON.stringify(body)).not.toContain(
      "local_dev_token_change_me_32_chars_min",
    );
  });

  it("issues a plaintext bearer ONCE and stores only its hash (AC#3, AC#9)", async () => {
    const res = await app.request("/api/admin/mcp-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ label: "Claude Desktop" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^lokyy_mcp_/);
    expect(body.vaultId).toBe(vaultId);
    expect(body.role).toBe("write");

    // Nothing in the row may contain the plaintext — only the SHA-256.
    const rows = await core.listMcpTokens(vaultId);
    const row = rows.find((r) => r.id === body.id);
    expect(row).toBeDefined();
    expect(row!.tokenHash).toBe(core.hashMcpToken(body.token));
    expect(JSON.stringify(row)).not.toContain(body.token);

    // The listing hands back metadata only — never a plaintext bearer.
    const listRes = await app.request("/api/admin/mcp-tokens", {
      headers: { Cookie: cookie },
    });
    const list = await listRes.json();
    expect(JSON.stringify(list)).not.toContain(body.token);
    expect(list.tokens.map((t: { id: string }) => t.id)).toContain(body.id);
    expect(list.tokens[0]).not.toHaveProperty("tokenHash");
  });

  it("stops authenticating a token once revoked (AC#4, AC#9)", async () => {
    const created = await app
      .request("/api/admin/mcp-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ label: "Rotation" }),
      })
      .then((r) => r.json());

    // Live before revoke …
    const before = await core.lookupMcpToken(created.token);
    expect(before).toMatchObject({ vaultId, role: "write" });

    const del = await app.request(`/api/admin/mcp-tokens/${created.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);

    // … dead immediately after, with no restart in between (AC#4).
    expect(await core.lookupMcpToken(created.token)).toBeNull();
  });

  it("never touches another vault's tokens", async () => {
    const list = await app
      .request("/api/admin/mcp-tokens", { headers: { Cookie: cookie } })
      .then((r) => r.json());
    expect(list.tokens.map((t: { id: string }) => t.id)).not.toContain(
      foreignTokenId,
    );

    const del = await app.request(`/api/admin/mcp-tokens/${foreignTokenId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(404);
    // Still alive — the own-vault surface must not reach into customer vaults.
    const rows = await core.listMcpTokens(foreignVaultId);
    expect(rows.find((r) => r.id === foreignTokenId)?.revokedAt).toBeNull();
  });

  it("mcp-info no longer emits the env placeholder (AC#5)", async () => {
    const res = await app.request("/api/admin/mcp-info", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("<set-LOKYY_MCP_TOKEN-env-and-restart>");
  });
});

/**
 * AC#1 — completing the setup mints a real token for the own vault, and a
 * failure to do so must NOT fail the setup (the `seedSkills` best-effort
 * pattern). Separate describe: it mutates `system_config.setup_complete`.
 */
describe.skipIf(!DB_URL)("POST /api/setup/complete mints an MCP token (Story 7.10 AC#1)", () => {
  let core: typeof import("@lokyy/core");
  let app: Hono;
  let base: string;
  let adminId: string;
  let vaultId: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "lokyy-setup-token-"));
    process.env.DATABASE_URL = DB_URL!;
    process.env.VAULT_DIR = join(base, "vault");
    core = await import("@lokyy/core");
    core.initDb(DB_URL!);
    await core.runMigrations(DB_URL!);

    adminId = core.generateUlid();
    await core.database().insert(core.users).values({
      id: adminId,
      email: `setup-${adminId}@test.local`,
      passwordHash: "not-a-real-hash",
      name: "Setup Admin",
      role: "admin",
    });
    vaultId = core.generateUlid();
    await core.database().insert(core.vaults).values({
      id: vaultId,
      name: "Setup Vault",
      slug: `setup-vault-${Date.now().toString(36)}`,
      kind: "personal",
      ownerId: adminId,
      gitRemote: "",
      gitBranch: "main",
    });

    const { setupRoutes } = await import("./setup.js");
    app = new Hono();
    app.route("/api/setup", setupRoutes);
  }, 120_000);

  afterAll(async () => {
    if (core) {
      await core.database().delete(core.vaults).where(eq(core.vaults.id, vaultId));
      await core.database().delete(core.users).where(eq(core.users.id, adminId));
      await core.closeDb();
    }
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("creates a working token and reports it once", async () => {
    const res = await app.request("/api/setup/complete", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.setupComplete).toBe(true);
    expect(body.mcpTokenError).toBeNull();
    expect(body.mcpToken).toMatch(/^lokyy_mcp_/);

    // It authenticates against the own vault right away — no restart.
    expect(await core.lookupMcpToken(body.mcpToken)).toMatchObject({
      vaultId,
      role: "write",
    });
  });

  it("is idempotent — a second completion does not mint another token", async () => {
    const before = (await core.listMcpTokens(vaultId)).length;
    const res = await app.request("/api/setup/complete", { method: "POST" });
    const body = await res.json();
    expect(body.mcpToken).toBeNull();
    expect((await core.listMcpTokens(vaultId)).length).toBe(before);
  });
});
