import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";
import { MIGRATIONS } from "./migrations/index.js";

/**
 * Database client + migration runner for lokyy-brain.
 *
 * Story 1.8: applies the in-memory MIGRATIONS array in order, tracking
 * which have already run in a `_lokyy_migrations` table. Idempotent.
 * Logs each application.
 */

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let client: ReturnType<typeof postgres> | null = null;
let db: Database | null = null;

export function initDb(databaseUrl: string): Database {
  if (db) return db;
  client = postgres(databaseUrl, { max: 10 });
  db = drizzle(client, { schema });
  return db;
}

export function database(): Database {
  if (!db) {
    throw new Error("DB not initialized — call initDb(databaseUrl) first.");
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
    db = null;
  }
}

/**
 * Apply all pending migrations from `migrations/`. Idempotent.
 *
 * Tracks applied migrations in `_lokyy_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)`.
 * Throws on connection failure or SQL error so the server fails fast.
 */
export async function runMigrations(databaseUrl: string): Promise<{ applied: string[]; alreadyApplied: string[] }> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _lokyy_migrations (
        name        TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    const appliedRows =
      await sql<{ name: string }[]>`SELECT name FROM _lokyy_migrations`;
    const applied = new Set(appliedRows.map((r) => r.name));

    const newlyApplied: string[] = [];
    const skipped: string[] = [];

    for (const m of MIGRATIONS) {
      if (applied.has(m.name)) {
        skipped.push(m.name);
        console.log(`[db] migration skipped (already applied): ${m.name}`);
        continue;
      }
      console.log(`[db] applying migration: ${m.name}`);
      await sql.unsafe(m.sql);
      await sql`INSERT INTO _lokyy_migrations (name) VALUES (${m.name})`;
      newlyApplied.push(m.name);
      console.log(`[db] migration applied: ${m.name}`);
    }

    return { applied: newlyApplied, alreadyApplied: skipped };
  } finally {
    await sql.end();
  }
}

export { schema };
