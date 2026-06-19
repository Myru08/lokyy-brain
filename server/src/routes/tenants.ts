import { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  database,
  users,
  vaults,
  vaultMemberships,
  generateUlid,
  vaultWorkingCopyPath,
  getVaultById,
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  type McpRole,
} from "@lokyy/core";
import { config } from "../config.js";

const exec = promisify(execFile);

export const tenantRoutes = new Hono();

/**
 * Default folder model for a shared customer vault (Design-Doc 10.3): the
 * customer sees `Freigabe/` (collaboration, both r/w) + `RAW/kunde/` (their
 * inbox). Everything else (`Wiki/`, `RAW/intern/`, …) is invisible — the scope
 * never lists it, so the customer's MCP can't even name those paths (10.2).
 */
const DEFAULT_READ_GLOBS = ["Freigabe/**", "RAW/kunde/**"];
const DEFAULT_WRITE_GLOBS = ["Freigabe/**", "RAW/kunde/**"];

/**
 * Strip any embedded credentials (`user:token@`) from a git remote before it
 * leaves the server — `gitRemote` can carry a Forgejo PAT/OAuth token baked
 * into the URL, which must never appear in an API response.
 */
function maskRemote(remote: string): string {
  if (!remote) return "";
  try {
    const u = new URL(remote);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return remote.includes("@") ? remote.replace(/\/\/[^@]*@/, "//") : remote;
  }
}

interface CreateTenantBody {
  name: string;
  slug: string;
  kind?: "shared" | "company" | "personal";
  agentId: string;
  role?: McpRole;
  readGlobs?: string[];
  writeGlobs?: string[];
}

/**
 * POST /api/tenants — provision an isolated customer/shared vault (LBMT-1.4).
 *
 * Creates a working copy at `<vaultsRoot>/<vaultId>` (physically separate from
 * every other vault), writes the folder-scope for the customer's agent-id,
 * registers the vault + an MCP token, and returns the token ONCE. Presenting
 * that token to `/mcp` routes the request to THIS vault, scoped to the
 * configured folders (enforced in LBMT-1.3).
 *
 * With `FORGEJO_ADMIN_TOKEN` + `FORGEJO_TENANTS_ORG` set, each customer gets a
 * real private Forgejo repo `<org>/<slug>` (created + cloned, push/pull live);
 * without them it falls back to a local-only working copy (demo).
 *
 * HARDENING TODO: like the rest of `/api/admin`, this route is not yet
 * auth-gated — wire owner-session gating before real customer onboarding.
 */
tenantRoutes.post("/", async (c) => {
  const body = await c.req.json<CreateTenantBody>();
  const { name, slug, agentId } = body;
  const kind = body.kind ?? "shared";
  const role: McpRole = body.role ?? "write";
  if (!name || !slug || !agentId) {
    return c.json({ error: "name, slug, agentId required" }, 400);
  }

  // Owner = the admin user; the customer is NOT a brain user (token only).
  const admin = (
    await database().select().from(users).where(eq(users.role, "admin")).limit(1)
  )[0];
  if (!admin) return c.json({ error: "no-admin-user" }, 400);

  // vaults.slug is unique — reject duplicates up front with a clear 409.
  const existing = (
    await database().select().from(vaults).where(eq(vaults.slug, slug)).limit(1)
  )[0];
  if (existing) return c.json({ error: "slug-exists", slug }, 409);

  const vaultId = generateUlid();
  const vaultDir = vaultWorkingCopyPath(vaultId);
  const readGlobs = body.readGlobs ?? DEFAULT_READ_GLOBS;
  const writeGlobs = body.writeGlobs ?? DEFAULT_WRITE_GLOBS;

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: config.gitAuthorName,
    GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
    GIT_COMMITTER_NAME: config.gitAuthorName,
    GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
  };
  const git = (args: string[]) =>
    exec("git", ["-C", vaultDir, ...args], { env: gitEnv });

  // 1) Working copy. With a Forgejo admin token + tenants-org configured, the
  // customer gets a REAL private Forgejo repo `<org>/<slug>` that we clone (the
  // token-URL stays in .git/config so push/pull work). Otherwise we fall back
  // to a local-only repo (demo / not yet configured). gitRemote stored in the
  // DB is ALWAYS untokenised — no credential at rest in the registry.
  let gitRemote = "";
  const useForgejo = Boolean(
    config.forgejoAdminToken && config.forgejoTenantsOrg && config.forgejoBaseUrl,
  );
  if (useForgejo) {
    const baseOrigin = new URL(config.forgejoBaseUrl).origin;
    const org = config.forgejoTenantsOrg;
    const fjHeaders = {
      Authorization: `Bearer ${config.forgejoAdminToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    // Ensure the tenants org exists — Lokyy owns it, no manual Forgejo step.
    // Idempotent: 422/409 = already there.
    const orgRes = await fetch(`${baseOrigin}/api/v1/orgs`, {
      method: "POST",
      headers: fjHeaders,
      body: JSON.stringify({ username: org, visibility: "private" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!orgRes.ok && orgRes.status !== 422 && orgRes.status !== 409) {
      const text = await orgRes.text().catch(() => "");
      return c.json(
        { error: "forgejo-org-failed", status: orgRes.status, body: text.slice(0, 300) },
        502,
      );
    }
    const createUrl = `${baseOrigin}/api/v1/orgs/${encodeURIComponent(org)}/repos`;
    const res = await fetch(createUrl, {
      method: "POST",
      headers: fjHeaders,
      body: JSON.stringify({
        name: slug,
        private: true,
        auto_init: true,
        default_branch: "main",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // 409 = repo already exists → reuse it (idempotent re-provision).
    if (!res.ok && res.status !== 409) {
      const text = await res.text().catch(() => "");
      return c.json(
        { error: "forgejo-create-failed", status: res.status, body: text.slice(0, 300) },
        502,
      );
    }
    gitRemote = `${baseOrigin}/${org}/${slug}.git`;
    const tokenUrl = gitRemote.replace(
      "://",
      `://oauth2:${config.forgejoAdminToken}@`,
    );
    await exec("git", ["clone", "--branch", "main", tokenUrl, vaultDir], { env: gitEnv });
  } else {
    await mkdir(vaultDir, { recursive: true });
    await git(["init", "-b", "main"]);
  }

  // 2) Baseline folders + customer folder-scope (Design 10.3). Owner unscoped.
  for (const dir of ["00_meta", "Freigabe", "RAW/kunde", "RAW/intern", "Wiki"]) {
    await mkdir(join(vaultDir, dir), { recursive: true });
    await writeFile(join(vaultDir, dir, ".gitkeep"), "", "utf8");
  }
  const scopesYaml =
    `scopes:\n` +
    `  ${agentId}:\n` +
    `    read: ${JSON.stringify(readGlobs)}\n` +
    `    write: ${JSON.stringify(writeGlobs)}\n` +
    `    commit_prefix: "[agent:${agentId}]"\n`;
  await writeFile(join(vaultDir, "00_meta", "mcp-scopes.yaml"), scopesYaml, "utf8");

  // 3) Commit, and push to Forgejo when a remote was provisioned.
  await git(["add", "-A"]);
  await git(["commit", "-m", "chore: provision tenant vault"]);
  if (useForgejo) {
    await git(["push", "origin", "main"]);
  }

  // 4) Registry: vault row + owner membership + customer MCP token (once).
  await database().insert(vaults).values({
    id: vaultId,
    name,
    slug,
    kind,
    ownerId: admin.id,
    gitRemote,
    gitBranch: "main",
  });
  await database().insert(vaultMemberships).values({
    userId: admin.id,
    vaultId,
    role: "admin",
  });
  const { token } = await createMcpToken({ vaultId, agentId, role, label: name });

  return c.json({
    vaultId,
    slug,
    kind,
    agentId,
    role,
    scope: { read: readGlobs, write: writeGlobs },
    token, // plaintext — shown ONCE, only the hash is stored
    connector: "/mcp",
  });
});

/**
 * GET /api/tenants — list provisioned vaults + their token metadata for the
 * dashboard (LBMT-1.5 extends this with copy/revoke). Token plaintext is never
 * returned — only metadata.
 */
tenantRoutes.get("/", async (c) => {
  const rows = await database().select().from(vaults);
  const tenants = await Promise.all(
    rows.map(async (v) => ({
      vaultId: v.id,
      name: v.name,
      slug: v.slug,
      kind: v.kind,
      gitRemote: maskRemote(v.gitRemote),
      tokens: (await listMcpTokens(v.id)).map((t) => ({
        id: t.id,
        agentId: t.agentId,
        role: t.role,
        label: t.label,
        lastUsedAt: t.lastUsedAt,
        revokedAt: t.revokedAt,
      })),
    })),
  );
  return c.json({ tenants });
});

/**
 * DELETE /api/tenants/tokens/:id — revoke an MCP token (LBMT-1.5).
 * Soft-revoke: after this the token's next /mcp request resolves to null → 401.
 */
tenantRoutes.delete("/tokens/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "token id required" }, 400);
  await revokeMcpToken(id);
  return c.json({ ok: true });
});

/**
 * POST /api/tenants/:vaultId/tokens — issue an ADDITIONAL MCP token for a
 * vault (e.g. after revoking one). Returns the plaintext ONCE.
 */
tenantRoutes.post("/:vaultId/tokens", async (c) => {
  const vaultId = c.req.param("vaultId");
  const vault = await getVaultById(vaultId);
  if (!vault) return c.json({ error: "not-found" }, 404);
  const body = await c.req
    .json<{ agentId?: string; role?: McpRole; label?: string }>()
    .catch(() => ({}) as { agentId?: string; role?: McpRole; label?: string });
  const agentId = (body.agentId ?? "").trim() || `kunde-${vault.slug}`;
  const role: McpRole = body.role ?? "write";
  const { token } = await createMcpToken({
    vaultId,
    agentId,
    role,
    label: body.label ?? vault.name,
  });
  return c.json({ vaultId, agentId, role, token, connector: "/mcp" });
});

/**
 * DELETE /api/tenants/:vaultId — delete a customer/company vault entirely:
 * its Forgejo repo (best-effort), its working copy, and its registry rows
 * (mcp_tokens cascade via FK). The personal vault is protected.
 */
tenantRoutes.delete("/:vaultId", async (c) => {
  const vaultId = c.req.param("vaultId");
  const vault = await getVaultById(vaultId);
  if (!vault) return c.json({ error: "not-found" }, 404);
  if (vault.kind === "personal") {
    return c.json(
      { error: "cannot-delete-personal", message: "Der eigene Vault kann nicht geloescht werden." },
      400,
    );
  }

  // 1) Forgejo repo (best-effort — never block local cleanup on a remote error).
  if (config.forgejoAdminToken && config.forgejoTenantsOrg && config.forgejoBaseUrl) {
    const baseOrigin = new URL(config.forgejoBaseUrl).origin;
    const org = config.forgejoTenantsOrg;
    if (vault.gitRemote.includes(`/${org}/`)) {
      try {
        await fetch(
          `${baseOrigin}/api/v1/repos/${org}/${encodeURIComponent(vault.slug)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${config.forgejoAdminToken}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
      } catch {
        // best-effort
      }
    }
  }

  // 2) Working copy.
  await rm(vaultWorkingCopyPath(vaultId), { recursive: true, force: true });

  // 3) Registry: memberships + vault (mcp_tokens cascade via FK ON DELETE CASCADE).
  await database().delete(vaultMemberships).where(eq(vaultMemberships.vaultId, vaultId));
  await database().delete(vaults).where(eq(vaults.id, vaultId));

  return c.json({ ok: true });
});

/**
 * GET /api/tenants/:vaultId/scope — current folder-scope (read/write globs) for
 * the vault's customer agent, so the tree-lock UI can render per-folder state.
 */
tenantRoutes.get("/:vaultId/scope", async (c) => {
  const vaultId = c.req.param("vaultId");
  const vault = await getVaultById(vaultId);
  if (!vault) return c.json({ error: "not-found" }, 404);
  const vaultDir = vaultWorkingCopyPath(vaultId);
  let agentId = "";
  let readGlobs: string[] = [];
  let writeGlobs: string[] = [];
  try {
    const raw = await readFile(join(vaultDir, "00_meta", "mcp-scopes.yaml"), "utf8");
    agentId = raw.match(/scopes:\s*\n\s+([^:\s]+):/)?.[1] ?? "";
    readGlobs = JSON.parse(raw.match(/\bread:\s*(\[[^\]]*\])/)?.[1] ?? "[]");
    writeGlobs = JSON.parse(raw.match(/\bwrite:\s*(\[[^\]]*\])/)?.[1] ?? "[]");
  } catch {
    const toks = await listMcpTokens(vaultId);
    agentId = toks[0]?.agentId ?? `kunde-${vault.slug}`;
  }
  return c.json({ vaultId, agentId, readGlobs, writeGlobs });
});

/**
 * PUT /api/tenants/:vaultId/scope { readGlobs, writeGlobs } — rewrite the
 * customer's folder-scope (e.g. from tree-lock toggles), commit + push. The MCP
 * reads the scope file fresh per request, so the change is live immediately.
 */
tenantRoutes.put("/:vaultId/scope", async (c) => {
  const vaultId = c.req.param("vaultId");
  const vault = await getVaultById(vaultId);
  if (!vault) return c.json({ error: "not-found" }, 404);
  const body = await c.req
    .json<{ agentId?: string; readGlobs?: string[]; writeGlobs?: string[] }>()
    .catch(() => ({}) as { agentId?: string; readGlobs?: string[]; writeGlobs?: string[] });
  const readGlobs = Array.isArray(body.readGlobs) ? body.readGlobs : [];
  const writeGlobs = Array.isArray(body.writeGlobs) ? body.writeGlobs : [];
  const vaultDir = vaultWorkingCopyPath(vaultId);

  let agentId = (body.agentId ?? "").trim();
  if (!agentId) {
    try {
      const raw = await readFile(join(vaultDir, "00_meta", "mcp-scopes.yaml"), "utf8");
      agentId = raw.match(/scopes:\s*\n\s+([^:\s]+):/)?.[1] ?? "";
    } catch {
      /* none yet */
    }
  }
  if (!agentId) {
    const toks = await listMcpTokens(vaultId);
    agentId = toks[0]?.agentId ?? `kunde-${vault.slug}`;
  }

  const yaml =
    `scopes:\n  ${agentId}:\n    read: ${JSON.stringify(readGlobs)}\n` +
    `    write: ${JSON.stringify(writeGlobs)}\n    commit_prefix: "[agent:${agentId}]"\n`;
  await mkdir(join(vaultDir, "00_meta"), { recursive: true });
  await writeFile(join(vaultDir, "00_meta", "mcp-scopes.yaml"), yaml, "utf8");

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: config.gitAuthorName,
    GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
    GIT_COMMITTER_NAME: config.gitAuthorName,
    GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
  };
  const git = (args: string[]) => exec("git", ["-C", vaultDir, ...args], { env: gitEnv });
  try {
    await git(["add", "--", "00_meta/mcp-scopes.yaml"]);
    await git(["commit", "-m", "chore: update tenant scope"]);
    if (vault.gitRemote) await git(["push", "origin", "main"]);
  } catch {
    // "nothing to commit" / transient push error — file is written, scope is
    // already live for the MCP (which reads it per request).
  }

  return c.json({ ok: true, agentId, readGlobs, writeGlobs });
});
