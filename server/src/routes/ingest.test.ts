import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { IngestApplyResponse, IngestProposal } from "@lokyy/shared";

/**
 * Issue #67 — `/api/ingest/*` gegen den verbindlichen API-Vertrag.
 *
 * Der Vertrag ist für beide Seiten verbindlich (die PWA baut parallel dagegen),
 * deshalb prüft dieser Test die FORM der Antworten, nicht die Anwendungslogik —
 * die liegt in `packages/core/src/ingest/apply.test.ts`. Ohne DB und ohne
 * Vault: `@lokyy/core` wird partiell gemockt.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

let stored: IngestProposal[] = [];
let listArgs: unknown[] = [];
let applyArgs: unknown[] = [];
let applyResult: IngestApplyResponse = { applied: [], skipped: [] };

vi.mock("@lokyy/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listIngestProposals: async (opts: unknown) => {
      listArgs.push(opts);
      return stored;
    },
    applyIngestProposals: async (req: unknown) => {
      applyArgs.push(req);
      return applyResult;
    },
  };
});

const { ingestRoutes } = await import("./ingest.js");

const app = new Hono();
app.route("/api/ingest", ingestRoutes);

function proposal(over: Partial<IngestProposal> = {}): IngestProposal {
  return {
    id: "p1",
    vaultId: "vault-test",
    jobId: "job-1",
    action: "flag_contradiction",
    sourceNoteId: "30_captures/urls/neu",
    targetNoteId: "50_decisions/postgres",
    rationale: "Widerspruch zu Postgres-Entscheidung",
    status: "pending",
    evidence: { signals: ["vs"] },
    createdAt: "2026-09-26T10:00:00.000Z",
    decidedAt: null,
    ...over,
  };
}

beforeEach(() => {
  stored = [];
  listArgs = [];
  applyArgs = [];
  applyResult = { applied: [], skipped: [] };
});

describe("GET /api/ingest/proposals", () => {
  it("liefert { proposals } und reicht den status-Filter durch", async () => {
    stored = [proposal()];

    const res = await app.request("/api/ingest/proposals?status=pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposals: IngestProposal[] };

    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({
      id: "p1",
      vaultId: "vault-test",
      jobId: "job-1",
      action: "flag_contradiction",
      status: "pending",
      decidedAt: null,
    });
    expect(listArgs[0]).toMatchObject({ status: "pending" });
  });

  it("weist einen unbekannten status ab, statt still alles zu listen", async () => {
    const res = await app.request("/api/ingest/proposals?status=quatsch");
    expect(res.status).toBe(400);
    expect(listArgs).toEqual([]);
  });

  it("listet ohne status-Parameter alles", async () => {
    const res = await app.request("/api/ingest/proposals");
    expect(res.status).toBe(200);
    expect(listArgs[0]).toMatchObject({ status: undefined });
  });
});

describe("POST /api/ingest/proposals/apply", () => {
  it("reicht approved/rejected durch und gibt applied + skipped zurück", async () => {
    applyResult = {
      applied: [proposal({ status: "applied" })],
      skipped: [{ id: "p2", reason: "abgelehnt — nichts geschrieben" }],
    };

    const res = await app.request("/api/ingest/proposals/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: ["p1"], rejected: ["p2"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestApplyResponse;

    expect(applyArgs[0]).toEqual({ approved: ["p1"], rejected: ["p2"] });
    expect(body.applied[0]?.status).toBe("applied");
    expect(body.skipped).toEqual([
      { id: "p2", reason: "abgelehnt — nichts geschrieben" },
    ]);
  });

  it("gibt für eine unbekannte ID 200 mit skipped-Grund zurück, nicht 500", async () => {
    applyResult = {
      applied: [],
      skipped: [{ id: "gibtsnicht", reason: "unbekannte Proposal-ID" }],
    };

    const res = await app.request("/api/ingest/proposals/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: ["gibtsnicht"], rejected: [] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as IngestApplyResponse;
    expect(body.skipped[0]?.reason).toBe("unbekannte Proposal-ID");
  });

  it("akzeptiert einen Body ohne beide Felder als leere Entscheidung", async () => {
    const res = await app.request("/api/ingest/proposals/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(applyArgs[0]).toEqual({ approved: [], rejected: [] });
  });

  it("weist einen unbrauchbaren Body mit 400 ab", async () => {
    const noJson = await app.request("/api/ingest/proposals/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "kein json",
    });
    expect(noJson.status).toBe(400);

    const wrongShape = await app.request("/api/ingest/proposals/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: "p1" }),
    });
    expect(wrongShape.status).toBe(400);

    const wrongIds = await app.request("/api/ingest/proposals/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: [42], rejected: [] }),
    });
    expect(wrongIds.status).toBe(400);

    expect(applyArgs).toEqual([]);
  });
});
