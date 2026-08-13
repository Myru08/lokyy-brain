import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";

import { pickActiveVault, selectActiveVault, type ActiveVaultRow } from "./activeVault.js";

/**
 * issue #43 — deterministic active-vault resolution.
 *
 * The pure `pickActiveVault` rule is the load-bearing part: search AND indexing
 * both flow through it (via `indexVaultId`), so it must be deterministic across
 * "one vault", "N vaults, no pin" and "pinned" — never "pick whichever row the
 * DB happened to return first".
 */

const d = (iso: string) => new Date(iso);

// Deliberately NOT createdAt-ordered, to prove the rule sorts rather than
// trusting input order.
const THREE_ROWS: ActiveVaultRow[] = [
  { id: "01JC000000MIDDLE00000000000", createdAt: d("2026-02-01T00:00:00Z") },
  { id: "01JA000000OLDEST00000000000", createdAt: d("2026-01-01T00:00:00Z") },
  { id: "01JE000000NEWEST00000000000", createdAt: d("2026-03-01T00:00:00Z") },
];

describe("pickActiveVault — deterministic selection rule", () => {
  it("env pin always wins, even with multiple rows — never ambiguous", () => {
    const sel = pickActiveVault(THREE_ROWS, "01JZ_PINNED_VAULT_ID");
    expect(sel).toEqual({
      vaultId: "01JZ_PINNED_VAULT_ID",
      ambiguous: false,
      source: "env",
      count: 3,
    });
  });

  it("no rows and no pin → null (fresh install, keep the placeholder)", () => {
    const sel = pickActiveVault([], "");
    expect(sel.vaultId).toBeNull();
    expect(sel.ambiguous).toBe(false);
    expect(sel.source).toBe("none");
    expect(sel.count).toBe(0);
  });

  it("exactly one vault → that vault, unambiguous", () => {
    const only: ActiveVaultRow = { id: "01JONLY0000000000000000000", createdAt: d("2026-05-01T00:00:00Z") };
    const sel = pickActiveVault([only], "");
    expect(sel.vaultId).toBe(only.id);
    expect(sel.ambiguous).toBe(false);
    expect(sel.source).toBe("db");
    expect(sel.count).toBe(1);
  });

  it("multiple vaults, no pin → OLDEST by createdAt, flagged ambiguous", () => {
    const sel = pickActiveVault(THREE_ROWS, "");
    expect(sel.vaultId).toBe("01JA000000OLDEST00000000000");
    expect(sel.ambiguous).toBe(true);
    expect(sel.source).toBe("db");
    expect(sel.count).toBe(3);
  });

  it("is order-independent — shuffling the input never changes the pick", () => {
    const shuffled = [THREE_ROWS[2]!, THREE_ROWS[0]!, THREE_ROWS[1]!];
    expect(pickActiveVault(shuffled, "").vaultId).toBe("01JA000000OLDEST00000000000");
  });

  it("breaks a createdAt tie by the (creation-ordered) ULID id", () => {
    const sameInstant = "2026-04-01T00:00:00Z";
    const tied: ActiveVaultRow[] = [
      { id: "01JB000000000000000000000B", createdAt: d(sameInstant) },
      { id: "01JB000000000000000000000A", createdAt: d(sameInstant) },
    ];
    const sel = pickActiveVault(tied, "");
    expect(sel.vaultId).toBe("01JB000000000000000000000A");
    expect(sel.ambiguous).toBe(true);
  });
});

/**
 * DB-gated wrapper test. Follows the repo's `describe.skipIf` convention so CI
 * without Postgres stays green. Provision a throwaway ParadeDB:
 *
 *   docker run -d --rm --name lokyy-test-pg \
 *     -e POSTGRES_PASSWORD=pw -p 55432:5432 paradedb/paradedb:latest-pg17
 *   LOKYY_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres \
 *     pnpm --filter @lokyy/core test activeVault
 */
const DB_URL = process.env.LOKYY_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("selectActiveVault — against a real vaults table", () => {
  let db: typeof import("../db/index.js");
  let vaultsSchema: typeof import("../db/schema/vaults.js");
  let usersSchema: typeof import("../db/schema/users.js");
  const prevPin = process.env.LOKYY_VAULT_ID;

  beforeAll(async () => {
    db = await import("../db/index.js");
    vaultsSchema = await import("../db/schema/vaults.js");
    usersSchema = await import("../db/schema/users.js");
    await db.runMigrations(DB_URL!);
    db.initDb(DB_URL!);
    // Clean slate — this suite owns the vaults/users tables for its assertions.
    const { sql } = await import("drizzle-orm");
    await db.database().execute(sql`DELETE FROM vault_memberships`);
    await db.database().execute(sql`DELETE FROM vaults`);
    await db.database().execute(sql`DELETE FROM note_embeddings`);
    await db.database().execute(sql`DELETE FROM users`);
    await db.database().insert(usersSchema.users).values({
      id: "01OWNER0000000000000000000",
      email: "owner@test.local",
      passwordHash: "x",
      name: "Owner",
      role: "admin",
    });
  });

  afterAll(async () => {
    if (prevPin === undefined) delete process.env.LOKYY_VAULT_ID;
    else process.env.LOKYY_VAULT_ID = prevPin;
    // Leave the shared test DB as clean as we found it — other suites (e.g.
    // server/tenants.test.ts) assume a fresh users/vaults table.
    const { sql } = await import("drizzle-orm");
    await db.database().execute(sql`DELETE FROM vault_memberships`);
    await db.database().execute(sql`DELETE FROM vaults`);
    await db.database().execute(sql`DELETE FROM note_embeddings`);
    await db.database().execute(sql`DELETE FROM users`);
    await db.closeDb?.();
  });

  afterEach(async () => {
    const { sql } = await import("drizzle-orm");
    await db.database().execute(sql`DELETE FROM vaults`);
    delete process.env.LOKYY_VAULT_ID;
  });

  const insertVault = async (id: string, createdAt: Date) => {
    await db.database().insert(vaultsSchema.vaults).values({
      id,
      name: id,
      slug: id.toLowerCase(),
      kind: "personal",
      ownerId: "01OWNER0000000000000000000",
      gitRemote: "",
      gitBranch: "main",
      createdAt,
    });
  };

  it("empty table → { vaultId: null }", async () => {
    delete process.env.LOKYY_VAULT_ID;
    const sel = await selectActiveVault();
    expect(sel.vaultId).toBeNull();
    expect(sel.count).toBe(0);
  });

  it("single vault → that id, unambiguous", async () => {
    delete process.env.LOKYY_VAULT_ID;
    await insertVault("01VONE00000000000000000000", d("2026-05-01T00:00:00Z"));
    const sel = await selectActiveVault();
    expect(sel.vaultId).toBe("01VONE00000000000000000000");
    expect(sel.ambiguous).toBe(false);
  });

  it("two vaults, no pin → oldest, ambiguous", async () => {
    delete process.env.LOKYY_VAULT_ID;
    await insertVault("01VNEW00000000000000000000", d("2026-06-01T00:00:00Z"));
    await insertVault("01VOLD00000000000000000000", d("2026-01-01T00:00:00Z"));
    const sel = await selectActiveVault();
    expect(sel.vaultId).toBe("01VOLD00000000000000000000");
    expect(sel.ambiguous).toBe(true);
    expect(sel.count).toBe(2);
  });

  it("env pin wins over the DB (and does not even need the rows)", async () => {
    await insertVault("01VOLD00000000000000000000", d("2026-01-01T00:00:00Z"));
    process.env.LOKYY_VAULT_ID = "01VPINNED000000000000000000";
    const sel = await selectActiveVault();
    expect(sel.vaultId).toBe("01VPINNED000000000000000000");
    expect(sel.source).toBe("env");
    expect(sel.ambiguous).toBe(false);
  });
});
