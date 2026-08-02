import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pickVaultResolution, resolveVaultResolution } from "./resolveVaultId.js";

/**
 * Story 1.15 leg (a): `resolveVaultResolution()` must THROW on an empty
 * `vaults` table — the DB access is stubbed here so the assertion runs without
 * a live Postgres. `rowsFixture` is read by the mock factory below, which
 * vitest hoists above the imports (hence `vi.hoisted`).
 */
const dbStub = vi.hoisted(() => ({ rows: [] as { id: string; slug: string; createdAt: Date }[] }));

vi.mock("@lokyy/core", () => ({
  initDb: vi.fn(),
  database: vi.fn(() => ({
    select: () => ({ from: () => Promise.resolve(dbStub.rows) }),
  })),
  vaults: { id: "id", slug: "slug", createdAt: "createdAt" },
}));

/**
 * Story 10.13 — Multi-vault detection (AC#1, AC#2, AC#5).
 *
 * `pickVaultResolution` is the pure core of vault-id resolution: it takes the
 * rows already fetched from the `vaults` table plus the `LOKYY_VAULT_ID` env
 * override and returns the machine-readable {@link VaultResolution}. No live
 * DB is needed — we feed it plain row objects and assert the decision + the
 * loud stderr warning.
 */

function row(id: string, slug: string, isoCreated: string) {
  return { id, slug, createdAt: new Date(isoCreated) };
}

describe("pickVaultResolution — multi-row ambiguity (AC#1/#2/#5)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("multiple rows → ambiguous:true, candidates list, oldest picked", () => {
    const rows = [
      row("01OLDEST", "alpha", "2024-01-01T00:00:00Z"),
      row("02MIDDLE", "beta", "2024-06-01T00:00:00Z"),
      row("03NEWEST", "gamma", "2025-01-01T00:00:00Z"),
    ];

    const res = pickVaultResolution(rows, "");

    expect(res.ambiguous).toBe(true);
    expect(res.source).toBe("db");
    // Oldest is picked as the fallback id.
    expect(res.vaultId).toBe("01OLDEST");
    // Every row is exposed as a candidate (id + slug).
    expect(res.candidates).toEqual([
      { id: "01OLDEST", slug: "alpha" },
      { id: "02MIDDLE", slug: "beta" },
      { id: "03NEWEST", slug: "gamma" },
    ]);
  });

  it("picks the OLDEST even when input order is shuffled", () => {
    const rows = [
      row("03NEWEST", "gamma", "2025-01-01T00:00:00Z"),
      row("01OLDEST", "alpha", "2024-01-01T00:00:00Z"),
      row("02MIDDLE", "beta", "2024-06-01T00:00:00Z"),
    ];

    const res = pickVaultResolution(rows, "");

    expect(res.vaultId).toBe("01OLDEST");
    expect(res.candidates[0].id).toBe("01OLDEST");
  });

  it("emits a LOUD PROBLEM warn to stderr listing all ids + the env hint", () => {
    const rows = [
      row("01OLDEST", "alpha", "2024-01-01T00:00:00Z"),
      row("02NEWEST", "beta", "2025-01-01T00:00:00Z"),
    ];

    pickVaultResolution(rows, "");

    expect(errSpy).toHaveBeenCalledTimes(1);
    const msg = errSpy.mock.calls[0][0] as string;
    // Clearly marked as a PROBLEM (not a silent info line).
    expect(msg).toContain("PROBLEM");
    expect(msg).toContain("MULTIPLE vault rows");
    // Lists every candidate id.
    expect(msg).toContain("01OLDEST");
    expect(msg).toContain("02NEWEST");
    // Points the operator at the env override with the picked id.
    expect(msg).toContain("LOKYY_VAULT_ID=01OLDEST");
  });
});

describe("pickVaultResolution — single row (AC#5)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("single row → ambiguous:false, that id, no loud warn", () => {
    const rows = [row("01ONLY", "solo", "2024-01-01T00:00:00Z")];

    const res = pickVaultResolution(rows, "");

    expect(res.ambiguous).toBe(false);
    expect(res.source).toBe("db");
    expect(res.vaultId).toBe("01ONLY");
    expect(res.candidates).toEqual([{ id: "01ONLY", slug: "solo" }]);
    // No PROBLEM warning on the single-row happy path.
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("pickVaultResolution — env override wins (AC#1)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("env override beats a multi-row DB and is never ambiguous", () => {
    const rows = [
      row("01OLDEST", "alpha", "2024-01-01T00:00:00Z"),
      row("02NEWEST", "beta", "2025-01-01T00:00:00Z"),
    ];

    const res = pickVaultResolution(rows, "PINNED_VAULT");

    expect(res.vaultId).toBe("PINNED_VAULT");
    expect(res.ambiguous).toBe(false);
    expect(res.source).toBe("env");
    // No candidates / no PROBLEM warn when explicitly pinned.
    expect(res.candidates).toEqual([]);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("env override wins even with zero rows (DB query is short-circuited upstream)", () => {
    const res = pickVaultResolution([], "PINNED_VAULT");

    expect(res.vaultId).toBe("PINNED_VAULT");
    expect(res.ambiguous).toBe(false);
    expect(res.source).toBe("env");
  });
});

/**
 * Story 1.15 AC#1 + AC#5(a) — empty `vaults` table must produce a CATCHABLE
 * error, not a `process.exit(1)`.
 *
 * A fresh Coolify deploy has an empty DB by definition: the setup wizard is
 * what creates the first vault row. Terminating the process here crash-looped
 * the brain and made the wizard unreachable, so the fix is that the shared
 * library function signals failure the normal way and each caller decides
 * whether that is fatal for IT.
 */
describe("resolveVaultResolution — empty vaults table (AC#1)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbStub.rows = [];
    delete process.env.LOKYY_VAULT_ID;
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Must never fire. Typed as never-returning, so stub it as a throw that the
    // assertions below would surface as the wrong error if it were ever called.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) was called — must not happen`);
    }) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws a catchable Error instead of exiting the process", async () => {
    await expect(resolveVaultResolution("postgres://stub/db")).rejects.toThrow(
      /no vault rows in DB and no LOKYY_VAULT_ID/,
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("the rejection is a real Error carrying the setup-wizard hint", async () => {
    const err = await resolveVaultResolution("postgres://stub/db").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Run setup wizard first");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("still resolves normally when the table has a row (no false positives)", async () => {
    dbStub.rows = [{ id: "01ONLY", slug: "solo", createdAt: new Date("2024-01-01T00:00:00Z") }];

    const res = await resolveVaultResolution("postgres://stub/db");

    expect(res.vaultId).toBe("01ONLY");
    expect(res.source).toBe("db");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
