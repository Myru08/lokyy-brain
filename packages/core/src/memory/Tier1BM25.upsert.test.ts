import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Gate-0 regression — `Tier1BM25.upsert` must bind `tags` as a single Postgres
 * `text[]` parameter, NEVER as a directly-interpolated JS array.
 *
 * WHY this test exists: the original upsert built the VALUES list with
 * `${tags as unknown as string}::text[]`. In drizzle-orm 0.36.4 a bare array in
 * an sql-template is *expanded* into a placeholder list, so:
 *   - `[]`          → `()::text[]`        → Postgres `syntax error at or near
 *                                            ")"` (SQLSTATE 42601)
 *   - `['a','b']`   → `($1, $2)::text[]`  → a row-constructor, not a clean
 *                                            `text[]`
 * The 42601 made every TAG-LESS note fail its index write, trip the per-note
 * circuit breaker after 3 attempts, and drop out of the BM25 index. The whole
 * pre-existing `circuitBreaker.test.ts` suite STUBS `upsert`, so it never
 * exercised the SQL the upsert actually builds — exactly the gap that let this
 * ship. This test closes that gap by inspecting the COMPILED query.
 *
 * No live database: we mock `indexDatabase()` to capture the `SQL` object the
 * upsert passes to `.execute()`, then compile it with drizzle's `PgDialect`
 * (pure, never connects) and assert on the generated SQL + params. The test
 * fails against the old raw-interpolation code (which emits `()::text[]` and an
 * expanded `($1, $2)` list with no array param) and passes against the fix.
 */

/** Captures the SQL object handed to the isolated index pool's `.execute()`. */
let capturedSql: SQL | null = null;

vi.mock("../db/index.js", () => ({
  // Only `indexDatabase` is used by `upsert`. Its `.execute()` records the
  // query and resolves without touching a database.
  indexDatabase: () => ({
    execute: (query: SQL) => {
      capturedSql = query;
      return Promise.resolve(undefined);
    },
  }),
  // `database` is imported at module top-level by Tier1BM25.ts; provide a stub
  // so the import resolves even though this test never calls the search path.
  database: () => {
    throw new Error("database() not expected in the upsert regression test");
  },
}));

// Import AFTER the mock is registered so Tier1BM25 binds to the mocked module.
const { Tier1BM25 } = await import("./Tier1BM25.js");

const dialect = new PgDialect();

/** Compile the captured upsert query to `{ sql, params }` (no DB connection). */
function compileCapturedUpsert(): { sql: string; params: unknown[] } {
  if (!capturedSql) throw new Error("upsert did not call indexDatabase().execute()");
  const { sql, params } = dialect.sqlToQuery(capturedSql);
  return { sql, params };
}

const NOTE = "01JNOTEAAAAAAAAAAAAAAAAAAA";
const VAULT = "vault-test";

beforeEach(() => {
  capturedSql = null;
});

describe("Tier1BM25.upsert — Gate-0 tags array binding", () => {
  it("binds EMPTY tags as a single text[] param (was the `()::text[]` 42601 crash)", async () => {
    await new Tier1BM25().upsert(NOTE, VAULT, "Title", "Body", [], false);

    const { sql, params } = compileCapturedUpsert();

    // The empty array must be ONE bound parameter, not an expanded list.
    expect(params).toContainEqual([]);
    // The fatal pattern must be gone: no `()::text[]` anywhere.
    expect(sql).not.toContain("()::text[]");
    // The cast must apply to a single placeholder, e.g. `$5::text[]`.
    expect(sql).toMatch(/\$\d+::text\[\]/);
  });

  it("binds MULTIPLE tags as a single text[] param (not an expanded `($1, $2)` list)", async () => {
    await new Tier1BM25().upsert(NOTE, VAULT, "Title", "Body", ["alpha", "beta"], false);

    const { sql, params } = compileCapturedUpsert();

    // Both tags must travel inside ONE array parameter.
    expect(params).toContainEqual(["alpha", "beta"]);
    // The array must not have been split across two placeholders feeding the
    // text[] cast (the old expansion bug produced `($1, $2)::text[]`).
    expect(sql).not.toMatch(/\$\d+,\s*\$\d+\)::text\[\]/);
    expect(sql).toMatch(/\$\d+::text\[\]/);
  });

  it("keeps the ON CONFLICT upsert semantics and other columns bound", async () => {
    await new Tier1BM25().upsert(NOTE, VAULT, "T", "B", ["x"], true);

    const { sql, params } = compileCapturedUpsert();

    expect(sql).toContain("ON CONFLICT (note_id) DO UPDATE");
    // note_id, vault_id, title, body all stay individually bound params.
    expect(params).toContain(NOTE);
    expect(params).toContain(VAULT);
    expect(params).toContain("T");
    expect(params).toContain("B");
    // forgotten flag is bound (true here).
    expect(params).toContain(true);
  });
});
