import { defineConfig } from "vitest/config";

/**
 * Test files run ONE AT A TIME.
 *
 * The DB-gated suites (`tenants.test.ts`, `mcpTokens.test.ts` — both behind
 * `LOKYY_TEST_DATABASE_URL`) share a single throwaway Postgres and each calls
 * `runMigrations()` in its `beforeAll`. Run in parallel they race on the
 * migration table and one of them lands on a half-applied schema, which shows
 * up as unrelated 500s far away from the actual cause. Serialising files is the
 * cheap, deterministic fix — the whole server suite is a handful of files.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
