import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { closeDb, database, initDb, runMigrations } from "../db/index.js";
import {
  insertIngestProposals,
  listIngestProposals,
  loadIngestProposals,
  setIngestProposalStatus,
} from "./proposalStore.js";

/**
 * Issue #67 — der Store gegen echtes Postgres.
 *
 * Die Stufe und `apply` sind mit injizierten Abhängigkeiten geprüft; was dort
 * NICHT abgedeckt ist, ist die Naht zur Datenbank: dass die Zeile wirklich
 * append-only wächst, dass ein Statuswechsel die bestehende `evidence` nicht
 * wegwischt und dass `vault_id` (#66) tatsächlich mitgeschrieben wird.
 *
 * GATED wie `semanticSearchE2E.db.test.ts`, damit ein Lauf ohne Postgres grün
 * bleibt. Gegen eine WEGWERF-Datenbank fahren:
 *
 *   docker run -d --rm --name lokyy-test-pg \\
 *     -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=lokyy_test \\
 *     -p 55432:5432 paradedb/paradedb:latest
 *   LOKYY_TEST_DATABASE_URL=postgres://postgres:testpw@localhost:55432/lokyy_test \\
 *     pnpm --filter @lokyy/core test proposalStore
 */

const DB_URL = process.env.LOKYY_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("ingest_proposals Store (echtes Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(DB_URL!);
    initDb(DB_URL!);
    await database().execute(sql`DELETE FROM ingest_proposals`);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("legt Vorschläge als pending ab, mit vault_id und jobId", async () => {
    const rows = await insertIngestProposals([
      {
        vaultId: "vault-store-test",
        jobId: "job-store-1",
        action: "flag_contradiction",
        sourceNoteId: "30_captures/urls/neu",
        targetNoteId: "50_decisions/postgres",
        rationale: "Widerspruch, gemeldet",
        evidence: { signals: ["vs"] },
      },
      {
        vaultId: "vault-store-test",
        jobId: "job-store-1",
        action: "link",
        sourceNoteId: "30_captures/urls/neu",
        targetNoteId: "50_decisions/postgres",
        rationale: "Rückverweis fehlt",
      },
    ]);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.vaultId).toBe("vault-store-test");
      expect(row.jobId).toBe("job-store-1");
      expect(row.decidedAt).toBeNull();
      expect(row.createdAt).toMatch(/^\d{4}-/);
    }
    expect(rows[0]?.evidence).toEqual({ signals: ["vs"] });
    // Kein `evidence` mitgegeben ⇒ NULL, nicht `{}`.
    expect(rows[1]?.evidence).toBeNull();
  });

  it("listet pending und filtert nach status", async () => {
    const pending = await listIngestProposals({ status: "pending" });
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(await listIngestProposals({ status: "applied" })).toEqual([]);
  });

  it("schiebt den Status weiter und behält die bestehende evidence", async () => {
    const [row] = await insertIngestProposals([
      {
        vaultId: "vault-store-test",
        jobId: "job-store-2",
        action: "link",
        sourceNoteId: "a",
        targetNoteId: "b",
        rationale: "r",
        evidence: { prefilter: { noteId: "b" } },
      },
    ]);

    const updated = await setIngestProposalStatus(row!.id, "failed", {
      applyError: "pre-commit-hook",
    });

    expect(updated?.status).toBe("failed");
    expect(updated?.decidedAt).not.toBeNull();
    // Der Vorfilter-Beweis bleibt stehen, der Fehlergrund kommt dazu.
    expect(updated?.evidence).toEqual({
      prefilter: { noteId: "b" },
      applyError: "pre-commit-hook",
    });

    // Append-only: die Zeile lebt weiter, sie wurde nicht ersetzt.
    const reloaded = await loadIngestProposals([row!.id]);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.id).toBe(row!.id);
  });

  it("gibt für eine unbekannte id null zurück, statt zu werfen", async () => {
    expect(await setIngestProposalStatus("gibtsnicht", "applied")).toBeNull();
    expect(await loadIngestProposals(["gibtsnicht"])).toEqual([]);
    expect(await loadIngestProposals([])).toEqual([]);
    expect(await insertIngestProposals([])).toEqual([]);
  });
});
