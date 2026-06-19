import { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  database,
  users,
  vaults,
  vaultMemberships,
  generateUlid,
  vaultWorkingCopyPath,
  createMcpToken,
  listMcpTokens,
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
 * HARDENING TODO: like the rest of `/api/admin`, this route is not yet
 * auth-gated — wire owner-session gating before real customer onboarding.
 * REMOTE TODO: provisions a LOCAL git working copy; attaching a per-customer
 * Forgejo repo (push/pull) is the follow-up tied to the Forgejo-token issue.
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

  // 1) Isolated working copy + baseline folders.
  for (const dir of ["00_meta", "Freigabe", "RAW/kunde", "RAW/intern", "Wiki"]) {
    await mkdir(join(vaultDir, dir), { recursive: true });
    await writeFile(join(vaultDir, dir, ".gitkeep"), "", "utf8");
  }

  // 2) Folder-scope for the customer agent (Design 10.3). Owner stays unscoped.
  const scopesYaml =
    `scopes:\n` +
    `  ${agentId}:\n` +
    `    read: ${JSON.stringify(readGlobs)}\n` +
    `    write: ${JSON.stringify(writeGlobs)}\n` +
    `    commit_prefix: "[agent:${agentId}]"\n`;
  await writeFile(join(vaultDir, "00_meta", "mcp-scopes.yaml"), scopesYaml, "utf8");

  // 3) git init (local working copy). Remote attach = follow-up.
  const git = (args: string[]) =>
    exec("git", ["-C", vaultDir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: config.gitAuthorName,
        GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
        GIT_COMMITTER_NAME: config.gitAuthorName,
        GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
      },
    });
  await git(["init", "-b", "main"]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "chore: provision tenant vault"]);

  // 4) Registry: vault row + owner membership + customer MCP token (once).
  await database().insert(vaults).values({
    id: vaultId,
    name,
    slug,
    kind,
    ownerId: admin.id,
    gitRemote: "",
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
      gitRemote: v.gitRemote,
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
