import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDb, closeDb } from "../db/index.js";
import { Tier1BM25 } from "./Tier1BM25.js";

/**
 * Story 10.1, AC#6 — live-Postgres regression for the special-character crash.
 *
 * This is the end-to-end proof against a real ParadeDB instance: before the fix
 * a query containing `)` or `'` threw `PostgresError 42601` from the `@@@`
 * operator; after the fix `Tier1BM25.search` must return a result list (or
 * empty) and never throw, keeping the backend up.
 *
 * It is GATED behind `LOKYY_TEST_DATABASE_URL` because CI / local runs without
 * a Postgres+ParadeDB must stay green. Run it explicitly with, e.g.:
 *   LOKYY_TEST_DATABASE_URL=postgres://user:pw@localhost:5432/lokyy \
 *     pnpm --filter @lokyy/core test searchHardening
 *
 * The sanitizer behaviour itself (the actual fix) is fully covered without a DB
 * in `Tier1BM25.test.ts`; this file adds real-engine confidence when a DB is
 * available.
 */

const DB_URL = process.env.LOKYY_TEST_DATABASE_URL;
const VAULT = "lokyy-10-1-regress";
const bm25 = new Tier1BM25();

describe.skipIf(!DB_URL)("AC#6 — special-char search against live ParadeDB", () => {
  beforeAll(async () => {
    initDb(DB_URL!);
    Tier1BM25.resetAvailabilityCache();
    // Seed one note whose body contains the exact poison characters from the
    // 2026-05-28 incident report.
    await bm25.upsert(
      "01JREGRESS0000000000000000",
      VAULT,
      "Regress Note",
      "Hey, schau mal: 🎉 (Klammer) 'quote' and a closing ) paren",
      ["test"],
    );
  });

  afterAll(async () => {
    await bm25.remove("01JREGRESS0000000000000000");
    await closeDb();
  });

  it("query 'foo) bar' never throws", async () => {
    await expect(bm25.search("foo) bar", 10, VAULT)).resolves.toBeInstanceOf(Array);
  });

  it("query \"o'brien\" never throws", async () => {
    await expect(bm25.search("o'brien", 10, VAULT)).resolves.toBeInstanceOf(Array);
  });

  it("query with the full incident body never throws and stays usable", async () => {
    const hits = await bm25.search("schau mal (Klammer) 'quote' )", 10, VAULT);
    expect(Array.isArray(hits)).toBe(true);
    // After the bad query the engine is still responsive to a normal query.
    const followUp = await bm25.search("Klammer", 10, VAULT);
    expect(Array.isArray(followUp)).toBe(true);
  });
});
