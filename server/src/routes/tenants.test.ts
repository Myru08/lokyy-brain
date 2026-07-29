import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const exec = promisify(execFile);

/**
 * Story 1.13 AC#7 — regression guard for `POST /api/tenants` after the route
 * was rewired from hand-rolled `exec("git", …)` onto the shared
 * `provisionVaultDir` primitive in `@lokyy/core`.
 *
 * Covers the LOCAL-ONLY path (no FORGEJO_ADMIN_TOKEN / FORGEJO_TENANTS_ORG /
 * FORGEJO_BASE_URL configured → `useForgejo` is false), which needs no Forgejo
 * API mocking. It asserts the caller-visible contract is unchanged — response
 * shape, registry rows, folder skeleton, scopes file — AND that the working
 * copy actually carries gitService's provisioning commit, which is the proof
 * that the rewire went through the shared primitive rather than a local
 * re-implementation.
 *
 * GATED behind `LOKYY_TEST_DATABASE_URL`, matching the convention already
 * established by `packages/core/src/memory/searchHardening.db.test.ts`: the
 * handler does real `database().insert`s, so it needs a live Postgres, and runs
 * without one must stay green. Run it with a THROWAWAY database (the migrations
 * need the `vector` + `pg_search` extensions, so use the same ParadeDB image
 * docker-compose.yml uses — never point this at a real vault's database):
 *
 *   docker run -d --rm --name lokyy-test-pg \
 *     -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=lokyy_test \
 *     -p 55432:5432 paradedb/paradedb:latest-pg17
 *   LOKYY_TEST_DATABASE_URL=postgres://postgres:testpw@localhost:55432/lokyy_test \
 *     pnpm --filter server test
 */

const DB_URL = process.env.LOKYY_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("POST /api/tenants — local-only provisioning (Story 1.13)", () => {
  let core: typeof import("@lokyy/core");
  let app: Hono;
  let base: string;
  let adminId: string;
  let sessionId: string;
  let cookie: string;

  // The single provisioning call under test — issued once in beforeAll, then
  // asserted from several angles below (provisioning is expensive; re-POSTing
  // per assertion would just be slower, not stronger).
  let status: number;
  let body: {
    vaultId: string;
    slug: string;
    kind: string;
    agentId: string;
    role: string;
    scope: { read: string[]; write: string[] };
    token: string;
    connector: string;
  };
  let vaultDir: string;

  const slug = `acme-${Date.now().toString(36)}`;
  const agentId = "kunde-acme";

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "lokyy-tenants-"));

    // `server/src/config.ts` reads process.env at MODULE-IMPORT time and throws
    // without DATABASE_URL, so the environment must be complete before the
    // dynamic imports below — hence no static import of the route.
    process.env.DATABASE_URL = DB_URL!;
    process.env.VAULT_DIR = join(base, "vault");
    process.env.GIT_AUTHOR_NAME = "lokyy-test";
    process.env.GIT_AUTHOR_EMAIL = "test@localhost";
    // The local-only path is exactly "none of these three are set".
    delete process.env.FORGEJO_ADMIN_TOKEN;
    delete process.env.FORGEJO_TENANTS_ORG;
    delete process.env.FORGEJO_BASE_URL;

    core = await import("@lokyy/core");
    core.initDb(DB_URL!);
    await core.runMigrations(DB_URL!);
    core.initCore({
      vaultDir: join(base, "vault"),
      // Tenant working copies land under `<vaultsRoot>/<vaultId>` — pinned into
      // the temp dir so the test never writes near a real vault.
      vaultsRoot: join(base, "vaults"),
      gitRemote: "",
      gitBranch: "main",
      gitAuthorName: "lokyy-test",
      gitAuthorEmail: "test@localhost",
    });

    // `requireAdmin` resolves the `lokyy_session` cookie through the DB, so a
    // real admin user + session row is the least-mocking way past the gate.
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

    const { tenantRoutes } = await import("./tenants.js");
    app = new Hono();
    app.route("/api/tenants", tenantRoutes);

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Acme GmbH", slug, agentId }),
    });
    status = res.status;
    body = await res.json();
    vaultDir = core.vaultWorkingCopyPath(body.vaultId);
  }, 120_000);

  afterAll(async () => {
    // Leave no rows behind — the gate allows pointing at a shared dev DB.
    if (core && body?.vaultId) {
      await core
        .database()
        .delete(core.vaultMemberships)
        .where(eq(core.vaultMemberships.vaultId, body.vaultId));
      // mcp_tokens cascade with the vault row (FK ON DELETE CASCADE).
      await core.database().delete(core.vaults).where(eq(core.vaults.id, body.vaultId));
    }
    if (core && adminId) {
      await core.database().delete(core.sessions).where(eq(core.sessions.id, sessionId));
      await core.database().delete(core.users).where(eq(core.users.id, adminId));
    }
    if (core) await core.closeDb();
    if (base) await rm(base, { recursive: true, force: true });
  });

  it("returns 200 with the documented response shape", () => {
    expect(status).toBe(200);
    expect(body).toMatchObject({
      slug,
      kind: "shared",
      agentId,
      role: "write",
      scope: {
        read: ["Freigabe/**", "RAW/kunde/**"],
        write: ["Freigabe/**", "RAW/kunde/**"],
      },
      connector: "/mcp",
    });
    // ULID (Crockford base32, 26 chars) + a plaintext token shown exactly once.
    expect(body.vaultId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  it("writes the vaults row with an EMPTY, untokenized gitRemote on the local path", async () => {
    const rows = await core
      .database()
      .select()
      .from(core.vaults)
      .where(eq(core.vaults.id, body.vaultId));

    expect(rows).toHaveLength(1);
    const vault = rows[0]!;
    expect(vault.name).toBe("Acme GmbH");
    expect(vault.slug).toBe(slug);
    expect(vault.kind).toBe("shared");
    expect(vault.ownerId).toBe(adminId);
    // Local-only → no remote at all; and never a credential at rest.
    expect(vault.gitRemote).toBe("");
    expect(vault.gitRemote).not.toContain("oauth2:");
    expect(vault.gitBranch).toBe("main");
  });

  it("registers the owner membership and exactly one MCP token (hash only)", async () => {
    const memberships = await core
      .database()
      .select()
      .from(core.vaultMemberships)
      .where(eq(core.vaultMemberships.vaultId, body.vaultId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.userId).toBe(adminId);
    expect(memberships[0]!.role).toBe("admin");

    const tokens = await core.listMcpTokens(body.vaultId);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.agentId).toBe(agentId);
    expect(tokens[0]!.role).toBe("write");
    // The plaintext is returned once and must never be persisted.
    expect(JSON.stringify(tokens)).not.toContain(body.token);
    // …but it must still resolve to THIS vault.
    const ctx = await core.lookupMcpToken(body.token);
    expect(ctx?.vaultId).toBe(body.vaultId);
  });

  it("scaffolds the customer folder skeleton on disk", () => {
    for (const dir of ["00_meta", "Freigabe", "RAW/kunde", "RAW/intern", "Wiki"]) {
      expect(existsSync(join(vaultDir, dir))).toBe(true);
      expect(existsSync(join(vaultDir, dir, ".gitkeep"))).toBe(true);
    }
  });

  it("writes 00_meta/mcp-scopes.yaml with the agent's read/write globs", async () => {
    const yaml = await readFile(join(vaultDir, "00_meta", "mcp-scopes.yaml"), "utf8");
    expect(yaml).toContain(`  ${agentId}:`);
    expect(yaml).toContain(`read: ["Freigabe/**","RAW/kunde/**"]`);
    expect(yaml).toContain(`write: ["Freigabe/**","RAW/kunde/**"]`);
    expect(yaml).toContain(`commit_prefix: "[agent:${agentId}]"`);
  });

  it("provisioned the working copy through gitService, not a local re-implementation", async () => {
    const { stdout: log } = await exec("git", ["-C", vaultDir, "log", "--pretty=%s"]);
    // gitService.provisionVaultDir's local-only bootstrap commit — the proof the
    // route delegates to the shared primitive (Story 1.13 AC#4).
    expect(log).toContain("chore: initialize lokyy vault (local-only)");
    // …followed by the route's own scaffolding commit.
    expect(log).toContain("chore: provision tenant vault");

    // Local-only path: no origin was added and nothing was pushed.
    await expect(
      exec("git", ["-C", vaultDir, "remote", "get-url", "origin"]),
    ).rejects.toBeTruthy();
  });

  it("rejects a duplicate slug with 409 without provisioning again", async () => {
    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Acme GmbH (dup)", slug, agentId }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "slug-exists", slug });
  });

  it("refuses an unauthenticated caller (requireAdmin gate still in front)", async () => {
    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No Session", slug: `${slug}-x`, agentId }),
    });
    expect(res.status).toBe(401);
  });
});

/**
 * Story 1.14 AC#7 — `PUT /api/tenants/:vaultId/scope` after the handler was
 * rewired from raw `exec("git", …)` inside a swallowing `try/catch` onto the
 * shared `saveVaultFile` primitive in `@lokyy/core`.
 *
 * The load-bearing case is the LAST one: a genuine remote divergence now
 * surfaces as a 409 instead of the old silent `{ ok: true }`. Scope data is
 * security-relevant — reporting a failed push as success is the bug this
 * story fixes.
 *
 * Same gate and setup convention as the suite above (`LOKYY_TEST_DATABASE_URL`,
 * real Postgres, real admin session). The vault is provisioned local-only via
 * POST and then given a REAL bare remote, so push/pull actually happen without
 * needing the Forgejo API.
 */
describe.skipIf(!DB_URL)("PUT /api/tenants/:vaultId/scope — error surfacing (Story 1.14)", () => {
  let core: typeof import("@lokyy/core");
  let app: Hono;
  let base: string;
  let adminId: string;
  let sessionId: string;
  let cookie: string;
  let vaultId: string;
  let vaultDir: string;
  let bareRemote: string;
  let otherClone: string;

  const slug = `scope-${Date.now().toString(36)}`;
  const agentId = "kunde-scope";

  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "lokyy-test",
    GIT_AUTHOR_EMAIL: "test@localhost",
    GIT_COMMITTER_NAME: "lokyy-test",
    GIT_COMMITTER_EMAIL: "test@localhost",
    LC_ALL: "C",
    LANG: "C",
  };
  const g = async (cwd: string, args: string[]): Promise<string> => {
    const { stdout } = await exec("git", args, { cwd, env: GIT_ENV });
    return stdout.trim();
  };

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "lokyy-scope-"));

    process.env.DATABASE_URL = DB_URL!;
    process.env.VAULT_DIR = join(base, "vault");
    process.env.GIT_AUTHOR_NAME = "lokyy-test";
    process.env.GIT_AUTHOR_EMAIL = "test@localhost";
    delete process.env.FORGEJO_ADMIN_TOKEN;
    delete process.env.FORGEJO_TENANTS_ORG;
    delete process.env.FORGEJO_BASE_URL;

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

    const { tenantRoutes } = await import("./tenants.js");
    app = new Hono();
    app.route("/api/tenants", tenantRoutes);

    const res = await app.request("/api/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Scope GmbH", slug, agentId }),
    });
    vaultId = (await res.json()).vaultId;
    vaultDir = core.vaultWorkingCopyPath(vaultId);

    // Give the local-only working copy a REAL remote so push/pull actually run
    // (the Forgejo API is not involved — a bare repo behaves identically here).
    bareRemote = join(base, "tenant-remote.git");
    await g(base, ["init", "--bare", "--initial-branch=main", bareRemote]);
    await g(vaultDir, ["remote", "add", "origin", bareRemote]);
    await g(vaultDir, ["push", "-u", "origin", "main"]);

    // The concurrent writer used by the conflict case below.
    otherClone = join(base, "other");
    await g(base, ["clone", bareRemote, otherClone]);
  }, 120_000);

  afterAll(async () => {
    if (core && vaultId) {
      await core
        .database()
        .delete(core.vaultMemberships)
        .where(eq(core.vaultMemberships.vaultId, vaultId));
      await core.database().delete(core.vaults).where(eq(core.vaults.id, vaultId));
    }
    if (core && adminId) {
      await core.database().delete(core.sessions).where(eq(core.sessions.id, sessionId));
      await core.database().delete(core.users).where(eq(core.users.id, adminId));
    }
    if (core) await core.closeDb();
    if (base) await rm(base, { recursive: true, force: true });
  });

  const putScope = (readGlobs: string[], writeGlobs: string[]) =>
    app.request(`/api/tenants/${vaultId}/scope`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ agentId, readGlobs, writeGlobs }),
    });

  it("commits AND pushes the scope through gitService on the happy path", async () => {
    const res = await putScope(["Freigabe/**"], ["Freigabe/**"]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, agentId });

    const yaml = await readFile(join(vaultDir, "00_meta", "mcp-scopes.yaml"), "utf8");
    expect(yaml).toContain(`read: ["Freigabe/**"]`);
    // The change actually reached the remote — the old raw-exec path swallowed
    // a failed push here.
    expect(await g(bareRemote, ["log", "-1", "--pretty=%s", "main"])).toBe(
      "chore: update tenant scope",
    );
    expect(await g(bareRemote, ["show", "main:00_meta/mcp-scopes.yaml"])).toContain(
      `read: ["Freigabe/**"]`,
    );
  });

  it("still succeeds when the scope is unchanged (nothing to commit)", async () => {
    const res = await putScope(["Freigabe/**"], ["Freigabe/**"]);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    // No second commit was created for identical content.
    const log = await g(vaultDir, ["log", "--pretty=%s"]);
    expect(log.split("\n").filter((l) => l === "chore: update tenant scope")).toHaveLength(1);
  });

  it("returns 409 instead of silently swallowing a real merge conflict (AC#5)", async () => {
    // A concurrent writer publishes DIFFERENT scope bytes first.
    await g(otherClone, ["pull", "origin", "main"]);
    await writeFile(
      join(otherClone, "00_meta", "mcp-scopes.yaml"),
      `scopes:\n  ${agentId}:\n    read: ["RAW/intern/**"]\n`,
      "utf8",
    );
    await g(otherClone, ["add", "-A"]);
    await g(otherClone, ["commit", "-m", "their scope"]);
    await g(otherClone, ["push", "origin", "main"]);

    const res = await putScope(["Wiki/**"], ["Wiki/**"]);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "merge-conflict" });
  });
});
