import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import {
  isSetupComplete,
  markSetupComplete,
  database,
  generateUlid,
  setupVaultFromForgejo,
  initLocalVault,
  getValidForgejoToken,
  loadToken,
  createMcpToken,
  listMcpTokens,
} from "@lokyy/core";
import {
  users,
  vaults,
  vaultMemberships,
} from "@lokyy/core";
import { config } from "../config.js";
import { seedSkills } from "../setup/seedSkills.js";
import { scaffoldVault } from "../setup/scaffoldVault.js";
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

// POST /api/setup/vault  { name, slug, gitRemote?, gitBranch?, ownerUserId }
//
// `gitRemote` is OPTIONAL. Omitted/empty = the wizard's "Ohne Forgejo
// fortfahren (nur lokal)" bypass: we provision a local-only git repo at
// VAULT_DIR via `initLocalVault()` and persist `git_remote = ''`. That empty
// value is the same first-class "no remote configured" state `coreConfig` /
// `ensureRepo` / `hasRemote()` already handle everywhere else (see also
// routes/auth.ts and routes/tenants.ts, which both store `''`): writes commit
// locally, pull/push/sync no-op, and a remote can be attached later via
// Settings without losing the commits made in the meantime.
setupRoutes.post("/vault", async (c) => {
  if (await isSetupComplete()) return c.json({ error: "already setup" }, 400);
  const { name, slug, gitRemote, gitBranch = "main", ownerUserId } =
    await c.req.json<{
      name: string;
      slug: string;
      gitRemote?: string;
      gitBranch?: string;
      ownerUserId: string;
    }>();
  if (!name || !slug || !ownerUserId) {
    return c.json({ error: "name, slug, ownerUserId required" }, 400);
  }
  // Normalize once: everything downstream branches on "" vs. a real remote.
  const remote = (gitRemote ?? "").trim();
  const id = generateUlid();
  await database().insert(vaults).values({
    id,
    name,
    slug,
    kind: "personal",
    ownerId: ownerUserId,
    gitRemote: remote,
    gitBranch,
  });
  await database().insert(vaultMemberships).values({
    userId: ownerUserId,
    vaultId: id,
    role: "admin",
  });

  // Provisioning of the working-copy at `VAULT_DIR`, two mutually exclusive
  // paths:
  //
  //   remote === ""  → local-only bypass: `initLocalVault()` clears the dir,
  //                    `git init`s it and lands one `.gitkeep` commit. No
  //                    remote, no push. The vault row keeps `git_remote = ''`.
  //   remote !== ""  → the existing Forgejo path (unchanged, below).
  //
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
    if (!remote) {
      // Local-only: no OAuth token to look up, nothing to clone, nothing to
      // push — just make VAULT_DIR a git repo so every write path works. The
      // row already carries `git_remote = ''`, so there is nothing to UPSERT.
      await initLocalVault();
      console.log(
        `[setup/vault] vault ${id} provisioned local-only (no git remote).`,
      );
    } else {
      const tokenRow = await loadToken(ownerUserId, config.forgejoBaseUrl);
      const repoFullName = tokenRow ? parseRepoFullName(remote) : null;

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
            gitRemote: remote,
            gitBranch: result.gitBranch,
          })
          .where(eq(vaults.id, id));
      }
    }
  } catch (err) {
    cloneError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[setup/vault] vault provisioning failed for vault ${id}: ${cloneError}`,
    );
  }

  // Story 1.19 — Basis-Vault-Scaffold: kanonische Ordner (je mit `.gitkeep`),
  // die aktuellen JSON-Schemas unter `00_meta/schemas/`, SPEC.md, die
  // Note-Templates und der SPEC-Pre-Commit-Hook. Läuft VOR `seedSkills()`,
  // damit Hook und Schemas stehen, bevor die erste Notiz committet wird —
  // andernfalls würde der Hook gegen ein Vault ohne Schema-Verzeichnis laufen.
  // Wie beim Seeding: best-effort, ein Fehler blockiert den Wizard nicht.
  let scaffoldError: string | null = null;
  if (!cloneError) {
    try {
      const scaffold = await scaffoldVault();
      if (scaffold.pushError) {
        console.warn(
          `[setup/vault] scaffold committed locally but push failed for vault ${id}: ${scaffold.pushError}`,
        );
      }
    } catch (err) {
      scaffoldError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[setup/vault] scaffoldVault failed for vault ${id}: ${scaffoldError}`,
      );
    }
  }

  // Story 9-5 — Seed-Skills in den frisch provisionierten Vault schreiben.
  // Idempotentes create-if-absent: ein Re-Init überschreibt user-editierte
  // Skills nicht. Best-effort — ein Seed-Fehler darf den Wizard nicht
  // blockieren (die Vault-Row steht bereits), wird aber gemeldet. Übersprungen,
  // wenn das Provisioning selbst fehlschlug (kein nutzbares Working-Copy).
  //
  // Läuft auch im Local-only-Modus: `seedSkills` schreibt über `gitService.save`,
  // und dessen Write-Pfad committet ohne Remote lokal (`hasRemote()` → return
  // nach dem commit, kein pull/push). Das `try/catch` bleibt trotzdem die
  // Absicherung — ein Seed-Fehler darf die Response nie blockieren.
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

  return c.json({ vaultId: id, cloneError, scaffoldError, seedError });
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
  // Story 7.10 AC#1 — mint a REAL MCP token for the own vault so a fresh
  // install never stays on the shared `local_dev_token_change_me_32_chars_min`
  // default that ships in the public repo. Best-effort, exactly like
  // `seedSkills` above: a failure is reported in the response and logged, it
  // never blocks the wizard (the vault + admin rows already exist at this
  // point, and a token can be generated later under Einstellungen → MCP).
  //
  // Idempotent: an install that already has a live (non-revoked) token keeps
  // it — re-running `/complete` must not silently mint duplicates.
  const [personal] = await db
    .select()
    .from(vaults)
    .where(eq(vaults.kind, "personal"))
    .limit(1);
  const ownVault = personal ?? vaultCount[0];
  let mcpToken: string | null = null;
  let mcpTokenError: string | null = null;
  try {
    const existing = await listMcpTokens(ownVault.id);
    if (!existing.some((t) => !t.revokedAt)) {
      const created = await createMcpToken({
        vaultId: ownVault.id,
        agentId: process.env.LOKYY_AGENT_ID ?? "claude-code",
        role: "write",
        label: "Setup",
      });
      mcpToken = created.token; // plaintext — shown ONCE, only the hash is stored
    }
  } catch (err) {
    mcpTokenError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[setup/complete] createMcpToken failed for vault ${ownVault.id}: ${mcpTokenError}`,
    );
  }

  await markSetupComplete();
  return c.json({ setupComplete: true, mcpToken, mcpTokenError });
});

// Acknowledge config exists so unused imports stay clean during refactor.
void config;
