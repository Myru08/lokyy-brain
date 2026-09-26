import { ulid } from "ulid";
import { desc, eq, inArray } from "drizzle-orm";
import type {
  IngestProposal,
  IngestProposalAction,
  IngestProposalStatus,
} from "@lokyy/shared";

import { database } from "../db/index.js";
import {
  ingestProposals,
  type IngestProposalRow,
} from "../db/schema/ingestProposals.js";

/**
 * Issue #67 — Datenzugriff auf das Append-only-Log `ingest_proposals`.
 *
 * Nur Insert und Statuswechsel. Es gibt hier absichtlich kein `delete`: ein
 * abgelehnter Vorschlag muss nachvollziehbar bleiben (AC#7).
 */

/** Eingabe für einen neuen Vorschlag — id und Zeitstempel macht der Store. */
export interface NewIngestProposal {
  vaultId: string;
  jobId: string;
  action: IngestProposalAction;
  sourceNoteId: string;
  targetNoteId: string | null;
  rationale: string;
  evidence?: unknown;
}

export function rowToProposal(row: IngestProposalRow): IngestProposal {
  return {
    id: row.id,
    vaultId: row.vaultId,
    jobId: row.jobId,
    action: row.action as IngestProposalAction,
    sourceNoteId: row.sourceNoteId,
    targetNoteId: row.targetNoteId,
    rationale: row.rationale,
    status: row.status as IngestProposalStatus,
    evidence: row.evidence ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

/** Vorschläge als `pending` ablegen. Leere Eingabe ⇒ kein DB-Aufruf. */
export async function insertIngestProposals(
  inputs: NewIngestProposal[],
): Promise<IngestProposal[]> {
  if (inputs.length === 0) return [];
  const rows = await database()
    .insert(ingestProposals)
    .values(
      inputs.map((p) => ({
        id: ulid(),
        vaultId: p.vaultId,
        jobId: p.jobId,
        action: p.action,
        sourceNoteId: p.sourceNoteId,
        targetNoteId: p.targetNoteId,
        rationale: p.rationale,
        status: "pending" as const,
        evidence:
          p.evidence === undefined
            ? null
            : (p.evidence as Record<string, unknown>),
      })),
    )
    .returning();
  return rows.map(rowToProposal);
}

/** Vorschläge listen, neueste zuerst. Ohne `status` alle. */
export async function listIngestProposals(opts?: {
  status?: IngestProposalStatus;
  limit?: number;
}): Promise<IngestProposal[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts?.limit ?? 100)));
  const query = database()
    .select()
    .from(ingestProposals)
    .orderBy(desc(ingestProposals.createdAt))
    .limit(limit);
  const rows = opts?.status
    ? await query.where(eq(ingestProposals.status, opts.status))
    : await query;
  return rows.map(rowToProposal);
}

/** Vorschläge per id laden (für `apply`). */
export async function loadIngestProposals(
  ids: string[],
): Promise<IngestProposal[]> {
  if (ids.length === 0) return [];
  const rows = await database()
    .select()
    .from(ingestProposals)
    .where(inArray(ingestProposals.id, ids));
  return rows.map(rowToProposal);
}

/**
 * Status einer Zeile weiterschieben. `evidencePatch` wird auf die bestehende
 * `evidence` gemergt — so bleibt der Vorfilter-Beweis erhalten, wenn ein
 * `applyError` dazukommt.
 */
export async function setIngestProposalStatus(
  id: string,
  status: IngestProposalStatus,
  evidencePatch?: Record<string, unknown>,
): Promise<IngestProposal | null> {
  const existing = (await loadIngestProposals([id]))[0];
  if (!existing) return null;

  const base =
    existing.evidence && typeof existing.evidence === "object"
      ? (existing.evidence as Record<string, unknown>)
      : {};
  const evidence = evidencePatch ? { ...base, ...evidencePatch } : base;

  const rows = await database()
    .update(ingestProposals)
    .set({ status, decidedAt: new Date(), evidence })
    .where(eq(ingestProposals.id, id))
    .returning();
  const row = rows[0];
  return row ? rowToProposal(row) : null;
}
