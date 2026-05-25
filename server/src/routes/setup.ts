import { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import {
  isSetupComplete,
  markSetupComplete,
  database,
  generateUlid,
} from "@lokyy/core";
import { users, vaults, vaultMemberships } from "@lokyy/core";
import { config } from "../config.js";

const exec = promisify(execFile);

export const setupRoutes = new Hono();

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
  // Hash via bcrypt — skip crypto strength for Story 1.10; Epic 3 hardens this.
  // Use scrypt from node:crypto as a stand-in until bcrypt lands in Epic 3.
  const { scryptSync, randomBytes } = await import("node:crypto");
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
  return c.json({ vaultId: id });
});

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
