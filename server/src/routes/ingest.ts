import { Hono } from "hono";
import {
  applyIngestProposals,
  listIngestProposals,
} from "@lokyy/core";
import {
  INGEST_PROPOSAL_STATUSES,
  type IngestProposalStatus,
} from "@lokyy/shared";

/**
 * Issue #67 — `/api/ingest/*`. Verbindlicher Vertrag (Story „API-Vertrag"):
 *
 *   GET  /api/ingest/proposals?status=pending
 *     → { proposals: IngestProposal[] }
 *
 *   POST /api/ingest/proposals/apply
 *     Body: { approved: string[], rejected: string[] }
 *     → { applied: IngestProposal[], skipped: { id, reason }[] }
 *
 * `apply` wirft nicht auf schlechte Eingaben: eine unbekannte ID, ein schon
 * entschiedener Vorschlag oder eine nicht anwendbare Aktion landen benannt in
 * `skipped`. Ein 4xx gibt es nur, wenn der Body selbst unbrauchbar ist (kein
 * JSON, `approved`/`rejected` keine Arrays) — dann weiß der Aufrufer nicht
 * einmal, über welche IDs er reden wollte.
 */
export const ingestRoutes = new Hono();

function isStatus(value: string): value is IngestProposalStatus {
  return (INGEST_PROPOSAL_STATUSES as readonly string[]).includes(value);
}

ingestRoutes.get("/proposals", async (c) => {
  const statusParam = c.req.query("status");
  if (statusParam && !isStatus(statusParam)) {
    return c.json(
      {
        error: `unbekannter status "${statusParam}"`,
        allowed: INGEST_PROPOSAL_STATUSES,
      },
      400,
    );
  }
  const limitRaw = Number(c.req.query("limit") ?? "100");
  const limit = Number.isFinite(limitRaw) ? limitRaw : 100;

  const proposals = await listIngestProposals({
    status: statusParam as IngestProposalStatus | undefined,
    limit,
  });
  return c.json({ proposals });
});

ingestRoutes.post("/proposals/apply", async (c) => {
  const body = await c.req
    .json<{ approved?: unknown; rejected?: unknown }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Body ist kein JSON" }, 400);

  const approved = body.approved ?? [];
  const rejected = body.rejected ?? [];
  if (!Array.isArray(approved) || !Array.isArray(rejected)) {
    return c.json(
      { error: "approved und rejected müssen Arrays von Proposal-IDs sein" },
      400,
    );
  }
  const ids = [...approved, ...rejected];
  if (ids.some((id) => typeof id !== "string")) {
    return c.json({ error: "Proposal-IDs müssen Strings sein" }, 400);
  }

  const result = await applyIngestProposals({
    approved: approved as string[],
    rejected: rejected as string[],
  });
  return c.json(result);
});
