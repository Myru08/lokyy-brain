import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import {
  isSetupComplete,
  markSetupComplete,
  resetSetup,
  database,
  generateUlid,
  setupVaultFromForgejo,
  getValidForgejoToken,
  loadToken,
} from "@lokyy/core";
import {
  users,
  vaults,
  vaultMemberships,
} from "@lokyy/core";
import { config } from "../config.js";
import { seedSkills } from "../setup/seedSkills.js";
import { createSession } from "../auth/sessions.js";

const exec = promisify(execFile);

export const setupRoutes = new Hono();

// Mirrors sessionCookieOpts in routes/auth.ts — keep in sync. secure:false
// works over HTTPS too (browser still sends it); set true only if you drop
// the HTTP entrypoint entirely.
function sessionCookieOpts(expires: Date) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: false,
    expires,
  };
}

// GET /api/setup/status
setupRoutes.get("/status", async (c) => {
  const complete = await isSetupComplete();
  return c.json({ setupComplete: complete });
});

// TEMP (Recovery): Setup zurücksetzen, damit der Wizard erneut läuft und den
// Vault-Klon mit dem EBUSY-Fix nachzieht. Nach erfolgreichem Re-Setup entfernen.
setupRoutes.get("/_reset", async (c) => {
  await resetSetup();
  return c.json({ ok: true, reset: true });
});

// TEMP (Recovery): klont den BESTEHENDEN Vault (Zeile existiert schon → Wizard-
// Insert würde an vaults_slug_key scheitern). Nutzt den gespeicherten Forgejo-
// Token des Admins. Aufruf: GET /api/setup/_reclone?repo=Owner/repo[&branch=main]
setupRoutes.get("/_reclone", async (c) => {
  const repoFullName = c.req.query("repo");
  const branch = c.req.query("branch") ?? "main";
  if (!repoFullName) {
    return c.json({ error: "repo query param required, e.g. ?repo=Owner/repo" }, 400);
  }
  const admin = (
    await database().select().from(users).where(eq(users.role, "admin")).limit(1)
  )[0];
  if (!admin) return c.json({ error: "no-admin-user" }, 400);

  const tokenRow = await loadToken(admin.id, config.forgejoBaseUrl);
  if (!tokenRow) return c.json({ error: "no-forgejo-token" }, 400);
  const accessToken = await getValidForgejoToken(admin.id, {
    forgejoBaseUrl: config.forgejoBaseUrl,
    clientId: config.forgejoOauthClientId,
    clientSecret: config.forgejoOauthClientSecret,
  });
  if (!accessToken) return c.json({ error: "token-refresh-failed" }, 400);

  const slug = repoFullName.split("/").pop()!.replace(/\.git$/i, "");
  const vault =
    (await database().select().from(vaults).where(eq(vaults.slug, slug)).limit(1))[0] ??
    (await database().select().from(vaults).where(eq(vaults.ownerId, admin.id)).limit(1))[0];
  if (!vault) return c.json({ error: "no-vault-row" }, 400);

  try {
    const result = await setupVaultFromForgejo({
      vaultId: vault.id,
      forgejoBaseUrl: tokenRow.forgejoBaseUrl,
      accessToken,
      repoFullName,
      branch,
    });
    await database()
      .update(vaults)
      .set({ gitRemote: result.gitRemote, gitBranch: result.gitBranch })
      .where(eq(vaults.id, vault.id));
    return c.json({ ok: true, vaultId: vault.id, slug, gitBranch: result.gitBranch });
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
      200,
    );
  }
});

// POST /api/setup/test-forgejo  { gitRemote, gitBranch? }
setupRoutes.post("/test-forgejo", async (c) => {
  const { gitRemote, gitBranch = "main" } = await c.req.json<{
    gitRemote: string;
    gitBranch?: string;
  }>();
  if (!gitRemote) return c.json({ ok: false, error: "gitRemote required" }, 400);
  try {
    await exec("git", ["ls-remote", "--heads", gitRemote, gitBranch], {
      timeout: 10_000,
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// POST /api/setup/test-postgres  { databaseUrl }
setupRoutes.post("/test-postgres", async (c) => {
  const { databaseUrl } = await c.req.json<{ databaseUrl: string }>();
  if (!databaseUrl) return c.json({ ok: false, error: "databaseUrl required" }, 400);
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(databaseUrl, { max: 1, idle_timeout: 2 });
    const result = await sql<{ version: string }[]>`SELECT version()`;
    const hasVector =
      await sql<{ name: string }[]>`SELECT name FROM pg_available_extensions WHERE name='vector'`;
    return c.json({
      ok: true,
      pgVersion: result[0]?.version,
      pgvectorAvailable: hasVector.length > 0,
    });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (sql) await sql.end();
  }
});

// POST /api/setup/test-ollama  { ollamaUrl? }
setupRoutes.post("/test-ollama", async (c) => {
  const { ollamaUrl = "http://localhost:11434" } = await c.req
    .json<{ ollamaUrl?: string }>()
    .catch(() => ({}) as { ollamaUrl?: string });
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return c.json({ ok: false, error: `HTTP ${res.status}` });
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const hasNomic = data.models?.some((m) => m.name.startsWith("nomic-embed-text"));
    return c.json({ ok: true, hasNomicEmbed: hasNomic ?? false });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// GET /api/setup/verify-postgres
// Backend-driven verification: server already booted with config.databaseUrl,
// so this PROVES the connection works and reports pgvector/pg_search availability.
setupRoutes.get("/verify-postgres", async (c) => {
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(config.databaseUrl, { max: 1, idle_timeout: 2 });
    const result = await sql<{ version: string }[]>`SELECT version()`;
    const exts = await sql<{ name: string }[]>`
      SELECT name FROM pg_available_extensions WHERE name IN ('vector', 'pg_search')
    `;
    const extNames = new Set(exts.map((e) => e.name));
    return c.json({
      ok: true,
      pgVersion: result[0]?.version,
      extensions: {
        vector: extNames.has("vector"),
        pg_search: extNames.has("pg_search"),
      },
    });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (sql) await sql.end();
  }
});

// GET /api/setup/verify-ollama
// Backend-driven verification: uses server's own config.ollamaHost.
setupRoutes.get("/verify-ollama", async (c) => {
  const host = config.ollamaHost;
  try {
    const res = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return c.json({ ok: false, error: `HTTP ${res.status}`, host });
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = data.models?.map((m) => m.name) ?? [];
    const hasNomicEmbed = models.some((n) => n.startsWith("nomic-embed-text"));
    return c.json({
      ok: true,
      host,
      hasNomicEmbed,
      models,
    });
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      host,
    });
  }
});

// POST /api/setup/admin  { email, password, name }
setupRoutes.post("/admin", async (c) => {
  if (await isSetupComplete()) return c.json({ error: "already setup" }, 400);
  const { email, password, name } = await c.req.json<{
    email: string;
    password: string;
    name: string;
  }>();
  if (!email || !password || !name) {
    return c.json({ error: "email, password, name required" }, 400);
  }

  const { scryptSync, randomBytes, timingSafeEqual } = await import("node:crypto");

  // Existing user with this email?
  const existing = await database()
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0) {
    const u = existing[0];
    // Verify password matches the stored scrypt hash
    const parts = (u.passwordHash ?? "").split(":");
    if (parts.length !== 3 || parts[0] !== "scrypt") {
      return c.json(
        { error: "existing-user-bad-hash", message: "Vorhandener User hat unleserlichen Passwort-Hash." },
        500,
      );
    }
    const [, salt, expectedHex] = parts;
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, "hex");
    const same =
      actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!same) {
      return c.json(
        { error: "wrong-password", message: "Email existiert bereits, das Passwort stimmt aber nicht." },
        401,
      );
    }
    // Upgrade to admin if not already
    if (u.role !== "admin") {
      await database()
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.id, u.id));
    }
    // Log the admin in immediately (session + cookie) — the wizard runs the
    // admin step FIRST so the Forgejo-OAuth step has an authenticated session.
    const session = await createSession(u.id);
    setCookie(c, "lokyy_session", session.id, sessionCookieOpts(session.expiresAt));
    return c.json({ userId: u.id, reused: true });
  }

  // No existing — create as today
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  const passwordHash = `scrypt:${salt}:${hash}`;
  const id = generateUlid();
  await database().insert(users).values({
    id,
    email,
    passwordHash,
    name,
    role: "admin",
  });
  // Log the admin in immediately (session + cookie) — see note above.
  const session = await createSession(id);
  setCookie(c, "lokyy_session", session.id, sessionCookieOpts(session.expiresAt));
  return c.json({ userId: id });
});

// POST /api/setup/vault  { name, slug, gitRemote, gitBranch?, ownerUserId }
setupRoutes.post("/vault", async (c) => {
  if (await isSetupComplete()) return c.json({ error: "already setup" }, 400);
  const { name, slug, gitRemote, gitBranch = "main", ownerUserId } =
    await c.req.json<{
      name: string;
      slug: string;
      gitRemote: string;
      gitBranch?: string;
      ownerUserId: string;
    }>();
  if (!name || !slug || !gitRemote || !ownerUserId) {
    return c.json({ error: "name, slug, gitRemote, ownerUserId required" }, 400);
  }
  const id = generateUlid();
  await database().insert(vaults).values({
    id,
    name,
    slug,
    kind: "personal",
    ownerId: ownerUserId,
    gitRemote,
    gitBranch,
  });
  await database().insert(vaultMemberships).values({
    userId: ownerUserId,
    vaultId: id,
    role: "admin",
  });

  // If the owner completed the Forgejo OAuth flow, run the actual clone via
  // `setupVaultFromForgejo` so the working-copy at `VAULT_DIR` is provisioned
  // before the wizard finishes. Then UPSERT the vault row to lock in the
  // canonical (untokenised) clone URL the wizard picked + the branch the
  // helper actually used — never trust the frontend payload alone, which has
  // been observed to be empty in race conditions and would otherwise leak
  // `git_remote=''` to Settings + the MCP config snippets.
  //
  // `getValidForgejoToken` decrypts the at-rest envelope and silently
  // refreshes via the stored refresh_token if the JWT is within ~60s of
  // expiry — the wizard can take a while between the OAuth callback and
  // hitting this endpoint, and we don't want a 1h-stale token to nuke an
  // otherwise valid setup. `loadToken` is the cheaper "is the row present
  // at all" check we use to decide whether to attempt the clone path.
  let cloneError: string | null = null;
  try {
    const tokenRow = await loadToken(ownerUserId, config.forgejoBaseUrl);
    const repoFullName = tokenRow ? parseRepoFullName(gitRemote) : null;

    if (tokenRow && repoFullName) {
      const accessToken = await getValidForgejoToken(ownerUserId, {
        forgejoBaseUrl: config.forgejoBaseUrl,
        clientId: config.forgejoOauthClientId,
        clientSecret: config.forgejoOauthClientSecret,
      });
      if (!accessToken) {
        throw new Error(
          "forgejo OAuth token expired and could not be refreshed — reconnect required",
        );
      }
      const result = await setupVaultFromForgejo({
        vaultId: id,
        forgejoBaseUrl: tokenRow.forgejoBaseUrl,
        accessToken,
        repoFullName,
        branch: gitBranch,
      });

      // Persist the canonical (untokenised) URL the wizard picked — NOT the
      // tokenised URL `setupVaultFromForgejo` baked into `.git/config`. The
      // tokenised URL would leak the OAuth token to anyone reading the
      // `vaults` row (Settings UI, MCP config snippets, future audits).
      await database()
        .update(vaults)
        .set({
          gitRemote,
          gitBranch: result.gitBranch,
        })
        .where(eq(vaults.id, id));
    }
  } catch (err) {
    cloneError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[setup/vault] setupVaultFromForgejo failed for vault ${id}: ${cloneError}`,
    );
  }

  // Story 9-5 — Seed-Skills in den frisch provisionierten Vault schreiben.
  // Idempotentes create-if-absent: ein Re-Init überschreibt user-editierte
  // Skills nicht. Best-effort — ein Seed-Fehler darf den Wizard nicht
  // blockieren (die Vault-Row steht bereits), wird aber gemeldet. Übersprungen,
  // wenn das Provisioning selbst fehlschlug (kein nutzbares Working-Copy).
  let seedError: string | null = null;
  if (!cloneError) {
    try {
      await seedSkills();
    } catch (err) {
      seedError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[setup/vault] seedSkills failed for vault ${id}: ${seedError}`,
      );
    }
  }

  return c.json({ vaultId: id, cloneError, seedError });
});

/**
 * Extracts `owner/repo` from a Forgejo HTTPS clone URL.
 *
 *   https://forgejo.example.com/oliver/mein-vault.git → "oliver/mein-vault"
 *
 * Returns `null` if the URL doesn't look like a parseable Forgejo HTTPS
 * remote — e.g. SSH URLs, bare slugs, or anything where we can't safely
 * derive an `owner/repo` pair. Callers must treat `null` as "not eligible
 * for the Forgejo OAuth clone path" and skip `setupVaultFromForgejo`.
 */
function parseRepoFullName(gitRemote: string): string | null {
  try {
    const url = new URL(gitRemote);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    const parts = path.split("/").filter((p) => p.length > 0);
    if (parts.length < 2) return null;
    // Forgejo `owner/repo` — first two non-empty segments.
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

// POST /api/setup/complete
setupRoutes.post("/complete", async (c) => {
  // Require at least one admin user and one vault to exist.
  const db = database();
  const adminCount = await db.select().from(users).limit(1);
  const vaultCount = await db.select().from(vaults).limit(1);
  if (adminCount.length === 0 || vaultCount.length === 0) {
    return c.json(
      {
        error: "incomplete",
        message: "At least one admin user and one vault required.",
      },
      400,
    );
  }
  await markSetupComplete();
  return c.json({ setupComplete: true });
});

// Acknowledge config exists so unused imports stay clean during refactor.
void config;
