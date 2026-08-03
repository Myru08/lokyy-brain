import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Story 1.15 AC#2 + AC#5(b) — an unresolvable vault must NOT abort brain
 * startup.
 *
 * The community-reported blocker: a fresh Coolify deploy has an empty database
 * (the setup wizard is what writes the first vault row). With `LOKYY_MCP_TOKEN`
 * set, `initMcp()` reached `resolveVaultId()`, which called `process.exit(1)` —
 * uncatchable, so the "Best-effort: ein MCP-Init-Fehler darf den Server NICHT
 * abbrechen" try/catch in `index.ts` never got a chance to run and the brain
 * crash-looped, making the wizard permanently unreachable.
 *
 * Now that the failure is a normal rejection, this asserts the documented
 * intent actually holds: startup survives, the brain serves its routes, and the
 * `/mcp` endpoint simply stays disabled (503) until the wizard has run.
 */

vi.mock("@lokyy/mcp/dist/resolveVaultId.js", () => ({
  resolveVaultId: vi.fn(async () => {
    throw new Error(
      "no vault rows in DB and no LOKYY_VAULT_ID env — cannot serve MCP. Run setup wizard first.",
    );
  }),
}));
vi.mock("@lokyy/mcp/dist/server.js", () => ({ initServerDeps: vi.fn(async () => {}) }));
vi.mock("@lokyy/mcp/dist/inProcess.js", () => ({ handleMcpHttp: vi.fn(async () => {}) }));

let initMcp: typeof import("./mcpMount.js").initMcp;
let mountMcp: typeof import("./mcpMount.js").mountMcp;

beforeAll(async () => {
  // `config` (required by mcpMount) throws on a missing DATABASE_URL, and the
  // mount reads LOKYY_MCP_TOKEN at module scope — so both must be set BEFORE
  // the module is imported. A set token is also what makes this the failing
  // deployment shape: without it the mount early-returns and never resolves.
  process.env.DATABASE_URL = "postgres://stub:stub@127.0.0.1:1/stub";
  process.env.LOKYY_MCP_TOKEN = "story-1-15-token";
  delete process.env.LOKYY_VAULT_ID;
  ({ initMcp, mountMcp } = await import("./mcpMount.js"));
});

describe("initMcp — empty vaults table (AC#2)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) was called — must not happen`);
    }) as never);
  });

  it("rejects with a catchable error instead of killing the process", async () => {
    await expect(initMcp()).rejects.toThrow(/no vault rows in DB/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("the brain's best-effort startup step swallows it and keeps booting", async () => {
    // Mirrors server/src/index.ts main(): `try { await initMcp(); } catch { warn }`.
    let reachedServe = false;
    try {
      await initMcp();
    } catch (err) {
      console.warn(
        `[lokyy-brain] MCP mount skipped — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    reachedServe = true;

    expect(reachedServe).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("brain routes after a failed MCP init (AC#2)", () => {
  let app: Hono;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    app = new Hono();
    app.get("/health", (c) => c.json({ ok: true }));
    mountMcp(app);
    // Stands in for the static-PWA catch-all that serves the setup wizard.
    app.get("*", (c) => c.text("setup-wizard", 200));

    try {
      await initMcp();
    } catch {
      /* best-effort, exactly as index.ts does */
    }
  });

  it("serves /health — the server is up despite the MCP failure", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves the setup wizard — the whole point of not exiting", async () => {
    const res = await app.request("/some/wizard/route");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("setup-wizard");
  });

  it("/mcp degrades to 503 instead of taking the brain down", async () => {
    const res = await app.request("/mcp", { method: "POST" });

    expect(res.status).toBe(503);
    // Story 7.11 AC#3: the lazy retry in the handler runs (and fails again,
    // the vault table is still empty) → 503 stays, but now names the wizard.
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("mcp-unavailable");
    expect(body.message).toMatch(/Setup-Wizard/);
  });
});
