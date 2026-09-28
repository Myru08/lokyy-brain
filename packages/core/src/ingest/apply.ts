import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";
import type { IngestApplyResponse, IngestProposal } from "@lokyy/shared";

import { database } from "../db/index.js";
import { lintFindings } from "../db/schema/lintFindings.js";
import { getNote, saveNote } from "../notes/notesService.js";
import {
  loadIngestProposals,
  setIngestProposalStatus,
} from "./proposalStore.js";

/**
 * Issue #67 — Freigabe/Ablehnung von Synthese-Vorschlägen anwenden.
 *
 * Nur Freigegebenes wird geschrieben. Abgelehntes bleibt als Zeile mit
 * `status = "rejected"` im Log stehen und berührt den Vault nicht (AC#7).
 *
 * Widerspruchs-Funde landen im BESTEHENDEN `lint_findings`-Format (AC#6) —
 * kein zweites Review-System, kein zweites Panel für dasselbe Problem. Sie
 * MELDEN nur: kein Vault-Write, keine Abwertung einer Notiz (Entscheidung
 * Oliver, 2026-09-26; Abwertung ist #65).
 *
 * Was nicht angewandt werden kann, landet in `skipped` MIT Grund. Es gibt
 * keinen stillen Zähler und keinen Wurf: eine unbekannte ID ist eine Zeile in
 * `skipped`, kein 500er.
 */

export interface ApplyDeps {
  loadProposals: (ids: string[]) => Promise<IngestProposal[]>;
  setStatus: (
    id: string,
    status: IngestProposal["status"],
    evidencePatch?: Record<string, unknown>,
  ) => Promise<IngestProposal | null>;
  getNote: (id: string) => Promise<{ body: string } | null>;
  saveNote: (id: string, body: string) => Promise<unknown>;
  /** Schreibt einen Widerspruchs-Fund ins `lint_findings`-Format. */
  writeLintFinding: (input: {
    noteIds: string[];
    message: string;
    evidence: Record<string, unknown>;
  }) => Promise<void>;
  log: (line: string) => void;
}

export function defaultApplyDeps(): ApplyDeps {
  return {
    loadProposals: loadIngestProposals,
    setStatus: setIngestProposalStatus,
    getNote: async (id) => {
      const note = await getNote(id);
      return note ? { body: note.body } : null;
    },
    saveNote,
    writeLintFinding: async ({ noteIds, message, evidence }) => {
      const sorted = [...noteIds].sort();
      // Dieselbe Entdopplung wie im Nachtlauf: ein noch offener Fund über
      // dieselben Notizen wird nicht zum zweiten Mal geschrieben.
      const open = await database()
        .select({ noteIds: lintFindings.noteIds })
        .from(lintFindings)
        .where(
          and(
            eq(lintFindings.kind, "contradiction"),
            eq(lintFindings.status, "open"),
          ),
        );
      for (const row of open) {
        const existing = [...row.noteIds].sort();
        if (
          existing.length === sorted.length &&
          existing.every((v, i) => v === sorted[i])
        ) {
          return;
        }
      }
      await database().insert(lintFindings).values({
        id: ulid(),
        kind: "contradiction",
        noteIds: sorted,
        severity: "warning",
        message,
        evidence,
        status: "open",
      });
    },
    log: (line) => console.warn(`[ingest-synthesis:apply] ${line}`),
  };
}

/** Überschrift, unter der ein freigegebener `link`-Vorschlag landet. */
const BACKLINK_HEADING = "## Siehe auch";

export async function applyIngestProposals(
  request: { approved: string[]; rejected: string[] },
  overrides: Partial<ApplyDeps> = {},
): Promise<IngestApplyResponse> {
  // Wie in `synthesis.ts`: nur gesetzte Overrides zählen.
  const deps: ApplyDeps = {
    ...defaultApplyDeps(),
    ...(Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined),
    ) as Partial<ApplyDeps>),
  };
  const applied: IngestProposal[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  const approved = [...new Set(request.approved ?? [])];
  const rejected = [...new Set(request.rejected ?? [])];
  const conflicting = new Set(approved.filter((id) => rejected.includes(id)));

  const ids = [...new Set([...approved, ...rejected])];
  const known = new Map<string, IngestProposal>();
  for (const p of await deps.loadProposals(ids)) known.set(p.id, p);

  for (const id of ids) {
    if (conflicting.has(id)) {
      skipped.push({
        id,
        reason: "gleichzeitig freigegeben und abgelehnt — keine Entscheidung",
      });
      continue;
    }
    const proposal = known.get(id);
    if (!proposal) {
      skipped.push({ id, reason: "unbekannte Proposal-ID" });
      continue;
    }
    if (proposal.status !== "pending") {
      skipped.push({
        id,
        reason: `schon entschieden (status=${proposal.status})`,
      });
      continue;
    }

    if (rejected.includes(id)) {
      // Abgelehnt = Statuswechsel, sonst nichts. Der Vault bleibt unberührt.
      const row = await deps.setStatus(id, "rejected");
      skipped.push({ id, reason: "abgelehnt — nichts geschrieben" });
      if (!row) deps.log(`Statuswechsel auf "rejected" fand Zeile ${id} nicht.`);
      continue;
    }

    try {
      const outcome = await applyOne(proposal, deps);
      if (outcome.kind === "skipped") {
        // Kein Write möglich, aber eine Entscheidung ist gefallen: die Zeile
        // bleibt `pending`, damit der Nutzer sie nicht verliert.
        skipped.push({ id, reason: outcome.reason });
        continue;
      }
      const row = await deps.setStatus(id, "applied", {
        applyNote: outcome.note,
      });
      applied.push(row ?? { ...proposal, status: "applied" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await deps.setStatus(id, "failed", { applyError: reason });
      skipped.push({ id, reason: `Anwenden fehlgeschlagen: ${reason}` });
      deps.log(`Vorschlag ${id} (${proposal.action}) fehlgeschlagen: ${reason}`);
    }
  }

  return { applied, skipped };
}

type ApplyOutcome =
  | { kind: "applied"; note: string }
  | { kind: "skipped"; reason: string };

async function applyOne(
  proposal: IngestProposal,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  switch (proposal.action) {
    case "link": {
      if (!proposal.targetNoteId) {
        return { kind: "skipped", reason: "link ohne targetNoteId" };
      }
      const target = await deps.getNote(proposal.targetNoteId);
      if (!target) {
        return {
          kind: "skipped",
          reason: `Zielnotiz "${proposal.targetNoteId}" existiert nicht mehr`,
        };
      }
      const link = `[[${proposal.sourceNoteId}]]`;
      if (target.body.includes(link)) {
        return { kind: "applied", note: "Rückverweis war schon vorhanden" };
      }
      const body = target.body.includes(BACKLINK_HEADING)
        ? target.body.replace(
            BACKLINK_HEADING,
            `${BACKLINK_HEADING}\n\n- ${link}`,
          )
        : `${target.body.replace(/\s*$/, "")}\n\n${BACKLINK_HEADING}\n\n- ${link}\n`;
      await deps.saveNote(proposal.targetNoteId, body);
      return { kind: "applied", note: "Rückverweis ergänzt" };
    }

    case "flag_contradiction": {
      if (!proposal.targetNoteId) {
        return {
          kind: "skipped",
          reason: "flag_contradiction ohne targetNoteId",
        };
      }
      await deps.writeLintFinding({
        noteIds: [proposal.sourceNoteId, proposal.targetNoteId],
        message: proposal.rationale,
        evidence: {
          ...(proposal.evidence && typeof proposal.evidence === "object"
            ? (proposal.evidence as Record<string, unknown>)
            : {}),
          source: "ingest-synthesis",
          proposalId: proposal.id,
          jobId: proposal.jobId,
        },
      });
      return { kind: "applied", note: "als Lint-Fund gemeldet" };
    }

    case "skip":
      // Reine Audit-Aktion: „bewusst nichts tun" ist eine Entscheidung, die
      // festgehalten gehört — geschrieben wird nichts.
      return { kind: "applied", note: "bewusst nichts getan" };

    case "create_note":
    case "append_to_note":
    case "merge":
      // Im Vertrag vorgesehen, von dieser Stufe (noch) nicht erzeugt. Lieber
      // benannt übersprungen als halb angewandt.
      return {
        kind: "skipped",
        reason: `Aktion "${proposal.action}" wird von dieser Version nicht angewandt`,
      };

    default:
      return {
        kind: "skipped",
        reason: `unbekannte Aktion "${String(proposal.action)}"`,
      };
  }
}
