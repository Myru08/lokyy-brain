import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Story 1.15 AC#3 + AC#5(c) — the standalone CLI entry points must still DIE on
 * an unresolvable vault.
 *
 * Story 1.15 moved the `process.exit(1)` out of `resolveVaultResolution()` so
 * the brain's in-process MCP mount can survive an empty vaults table. That is
 * only correct if the two entry points which genuinely SHOULD terminate —
 * `bin.ts` and `binHttp.ts`, standalone processes with no setup wizard to fall
 * back to — now catch the thrown error themselves.
 *
 * These tests run the real entry points as child processes. The DSN points at a
 * closed port, so `resolveVaultId()` rejects at the DB layer: a different error
 * INSTANCE than the empty-table one (that exact message is asserted at unit
 * level in `resolveVaultId.test.ts`), but the same catchable-rejection PATH the
 * new try/catch has to handle. Before the fix this surfaced as an uncaught
 * top-level exception; the assertions below pin the clean, handled exit.
 */

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

/** A syntactically valid DSN whose port has nothing listening → fast ECONNREFUSED. */
const DEAD_DB_URL = "postgres://u:p@127.0.0.1:1/nodb";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runEntry(script: string): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOKYY_DB_URL: DEAD_DB_URL,
    LOKYY_VAULT_DIR: "/tmp/lokyy-story-1-15-nonexistent",
    LOKYY_GIT_REMOTE: "https://example.invalid/vault.git",
  };
  // Must be absent, or resolution short-circuits before ever touching the DB.
  delete env.LOKYY_VAULT_ID;

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(TSX, [script], { cwd: PKG_ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe("CLI entry points — unresolvable vault is still fatal (AC#3)", () => {
  it("bin.ts exits 1 with a clear message, not an uncaught exception", async () => {
    const { code, stderr } = await runEntry("src/bin.ts");

    expect(code).toBe(1);
    expect(stderr).toContain("[lokyy-mcp] cannot resolve vault");
    // The failure is HANDLED — an uncaught top-level rejection would also exit
    // non-zero, so this is what actually distinguishes the fixed behaviour.
    expect(stderr).not.toContain("triggerUncaughtException");
  }, 60_000);

  it("binHttp.ts exits 1 with a clear message, not an uncaught exception", async () => {
    const { code, stderr } = await runEntry("src/binHttp.ts");

    expect(code).toBe(1);
    expect(stderr).toContain("[lokyy-mcp-http] cannot resolve vault");
    expect(stderr).not.toContain("triggerUncaughtException");
  }, 60_000);

  it("bin.ts keeps its distinct exit code 2 for missing env vars", async () => {
    // Guard against the new try/catch swallowing the pre-existing `req()`
    // contract: a misconfigured deployment and an unresolvable vault stay
    // separately diagnosable.
    const env = { ...process.env };
    delete env.LOKYY_DB_URL;
    delete env.LOKYY_VAULT_ID;

    const result = await new Promise<RunResult>((resolveRun, rejectRun) => {
      const child = spawn(TSX, ["src/bin.ts"], { cwd: PKG_ROOT, env });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += String(c)));
      child.on("error", rejectRun);
      child.on("close", (code) => resolveRun({ code, stdout: "", stderr }));
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("missing required env var: LOKYY_DB_URL");
  }, 60_000);
});
