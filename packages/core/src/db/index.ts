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

/**
 * Dedicated pool + Drizzle handle for fire-and-forget index writes
 * (Story 10.1, AC#4 — pool isolation).
 *
 * WHY a second pool: the search-index upsert path (`Tier1BM25.upsert`) runs
 * fire-and-forget after every note save. When a note triggers a ParadeDB
 * BM25-index error (PostgresError 42601), each save re-fires the failing
 * write. Sharing the single `max: 10` pool meant those failing/slow writes
 * could occupy every connection and starve reads + `search_vault` → the
 * 2026-05-28 total outage. Isolating index writes onto their own small pool
 * with a hard statement_timeout guarantees the read/search path keeps
 * connections available even under an index-write storm.
 */
const INDEX_POOL_MAX = 2;
/** Hard ceiling so a hung index query frees its connection instead of stalling. */
const INDEX_STATEMENT_TIMEOUT_MS = 5_000;
/**
 * Seconds to wait for a new connection before failing fast (Story 10.1
 * hardening #3). Under a write storm the `max: 2` pool can still back up at
 * connect time; without this, a queued index write would stall indefinitely
 * waiting for a socket. Failing fast lets the per-note circuit breaker count
 * the failure and back off instead of holding the write open. postgres.js
 * expects `connect_timeout` in SECONDS.
 */
const INDEX_CONNECT_TIMEOUT_S = 5;

let indexClient: ReturnType<typeof postgres> | null = null;
let indexDb: Database | null = null;
let cachedDatabaseUrl: string | null = null;

export function initDb(databaseUrl: string): Database {
  if (db) return db;
  cachedDatabaseUrl = databaseUrl;
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

/**
 * Isolated Drizzle handle for fire-and-forget search-index writes
 * (Story 10.1, AC#4). Lazily creates a small dedicated pool the first time an
 * index write runs. Reuses the DATABASE_URL captured at `initDb` time. The
 * pool caps statement duration so a misbehaving ParadeDB index operation
 * releases its connection rather than holding it open.
 */
export function indexDatabase(): Database {
  if (indexDb) return indexDb;
  if (!cachedDatabaseUrl) {
    throw new Error("DB not initialized — call initDb(databaseUrl) first.");
  }
  indexClient = postgres(cachedDatabaseUrl, {
    max: INDEX_POOL_MAX,
    // Fail fast when no connection is available under a write storm (#3).
    connect_timeout: INDEX_CONNECT_TIMEOUT_S,
    // postgres.js applies these as session GUCs (milliseconds) on every
    // connection so a hung index query is force-cancelled and its connection
    // returned to the pool.
    connection: {
      statement_timeout: INDEX_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: INDEX_STATEMENT_TIMEOUT_MS,
    },
    idle_timeout: 10,
  });
  indexDb = drizzle(indexClient, { schema });
  return indexDb;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
    db = null;
  }
  if (indexClient) {
    await indexClient.end();
    indexClient = null;
    indexDb = null;
  }
  cachedDatabaseUrl = null;
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
