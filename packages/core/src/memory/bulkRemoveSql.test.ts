import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * Issue #56, AC#6 — die gebündelte Lösch-Query.
 *
 * `removeMany`/`removeNotes` müssen die IDs als EINEN gebundenen `text[]`-
 * Parameter übergeben (`= ANY($1::text[])`), nicht als expandierte
 * Placeholder-Liste. Grund identisch zum Gate-0-Bug in `upsert`: drizzle-orm
 * 0.36.4 expandiert ein blankes `${array}` im sql-Template zu `($1, $2)` —
 * und zu `()` für die leere Liste, was Postgres mit 42601 ablehnt.
 *
 * Ohne DB: `database`/`indexDatabase` sind gemockt, die eingefangene Query wird
 * mit drizzles `PgDialect` kompiliert (rein, verbindet nie).
 */

let capturedIndex: SQL | null = null;
let capturedMain: SQL | null = null;

vi.mock("../db/index.js", () => ({
  indexDatabase: () => ({
    execute: (query: SQL) => {
      capturedIndex = query;
      return Promise.resolve(undefined);
    },
  }),
  database: () => ({
    execute: (query: SQL) => {
      capturedMain = query;
      return Promise.resolve(undefined);
    },
  }),
}));

const { Tier1BM25 } = await import("./Tier1BM25.js");
const { Tier2Provider } = await import("./Tier2Provider.js");

const dialect = new PgDialect();
const VAULT = "01KYPWCA9JA6TBRF9NFZMC47PB";
const IDS = ["10_projects/a", "10_projects/b", "10_projects/c"];

function compile(q: SQL | null): { sql: string; params: unknown[] } {
  if (!q) throw new Error("keine Query eingefangen");
  return dialect.sqlToQuery(q);
}

beforeEach(() => {
  capturedIndex = null;
  capturedMain = null;
});

describe("Tier1BM25.removeMany — gebündeltes Tier-1-Delete", () => {
  it("löscht alle IDs in EINER Query über einen gebundenen text[]-Parameter", async () => {
    await new Tier1BM25().removeMany(IDS);

    const { sql, params } = compile(capturedIndex);
    expect(sql).toContain("DELETE FROM note_search");
    expect(sql).toMatch(/= ANY\(\$\d+::text\[\]\)/);
    expect(params).toContainEqual(IDS);
    // Kein expandierter Placeholder-Block (der Gate-0-Fehlermodus).
    expect(sql).not.toMatch(/\$\d+,\s*\$\d+\)::text\[\]/);
  });

  it("macht bei leerer Liste gar keine Query (kein `()::text[]`-42601)", async () => {
    await new Tier1BM25().removeMany([]);
    expect(capturedIndex).toBeNull();
  });
});

describe("Tier2Provider.removeNotes — gebündeltes Tier-2-Delete", () => {
  it("löscht alle IDs vault-skopiert in EINER Query", async () => {
    await new Tier2Provider({ vaultId: VAULT }).removeNotes(IDS);

    const { sql, params } = compile(capturedMain);
    expect(sql).toContain("DELETE FROM note_embeddings");
    expect(sql).toMatch(/= ANY\(\$\d+::text\[\]\)/);
    expect(sql).toContain("vault_id");
    expect(params).toContainEqual(IDS);
    expect(params).toContain(VAULT);
  });

  it("macht bei leerer Liste gar keine Query", async () => {
    await new Tier2Provider({ vaultId: VAULT }).removeNotes([]);
    expect(capturedMain).toBeNull();
  });
});
