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
    /**
     * ACHTUNG, zweite Wirkung: diese Zeile ist auch der Contention-Schutz.
     * `server/` hat vier Testdateien mit echtem git/`execFile`
     * (`vaultCompliance`, `tenants`, `forgejoStatus`, `scaffoldVault`) — dieselbe
     * Klasse wie in `@lokyy/core`, wo parallele git-Kindprozesse denselben Test
     * von 1,0 s auf 14,9 s drücken und die Defaults (5 s / 10 s) reißen lassen.
     * Hier passiert das nur deshalb nicht, weil serialisiert wird.
     * Wer `fileParallelism` anschaltet, MUSS im selben Zug die Timeouts anheben
     * (Vorbild: `testTimeout`/`hookTimeout` in `packages/core/vitest.config.ts`).
     */
    fileParallelism: false,
  },
});
