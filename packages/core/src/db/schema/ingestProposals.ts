import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Issue #67 — Audit-Log der Ingest-Time-Synthese.
 *
 * Eine Zeile = ein Vorschlag, den die Synthese-Stufe beim Import erzeugt hat.
 * Append-only im Muster von `sleepAgentRuns` / `lintFindings`: geschrieben wird
 * nur per INSERT, eine Entscheidung ist ein UPDATE des `status` auf derselben
 * Zeile (plus `decided_at`). Es wird nie eine Zeile gelöscht — ein abgelehnter
 * Vorschlag MUSS nachvollziehbar bleiben (AC#7).
 *
 * `vault_id` ist von Anfang an dabei (#66). Neun der bestehenden abgeleiteten
 * Stores haben keine Vault-Spalte; diese Tabelle vergrößert das Problem nicht.
 * Bewusst OHNE Fremdschlüssel auf `vaults(id)`: `indexVaultId()` liefert auf
 * nicht-injizierten Installationen den Platzhalter `"default"` bzw.
 * `"legacy-placeholder"` — ein FK würde dort JEDEN Insert abweisen und die
 * Stufe damit still abschalten (genau der Fehlermodus aus #43 bei
 * `note_embeddings`). Lieber eine Zeile mit Platzhalter-Vault als keine Zeile.
 *
 * Indizes:
 *   - `idx_ingest_proposals_status` — die Approval-Karte listet `pending`.
 *   - `idx_ingest_proposals_vault`  — Auswertung pro Vault.
 *   - `idx_ingest_proposals_job`    — „was hat DIESER Import vorgeschlagen?"
 */
export const ingestProposals = pgTable(
  "ingest_proposals",
  {
    /** ULID, vor dem Insert erzeugt. */
    id: text("id").primaryKey(),
    /** Vault-Identität des Index (siehe `indexVaultId()`). */
    vaultId: text("vault_id").notNull(),
    /** Der Pipe-Job, aus dem der Vorschlag stammt. */
    jobId: text("job_id").notNull(),
    /**
     * "create_note" | "append_to_note" | "link" | "flag_contradiction" |
     * "merge" | "skip" — in TS über `IngestProposalAction` erzwungen.
     */
    action: text("action").notNull(),
    /** path-id der neu importierten Notiz. */
    sourceNoteId: text("source_note_id").notNull(),
    /** path-id der betroffenen bestehenden Notiz, sonst NULL. */
    targetNoteId: text("target_note_id"),
    /** Anzeigbare Begründung. */
    rationale: text("rationale").notNull(),
    /** "pending" | "approved" | "rejected" | "applied" | "failed". */
    status: text("status").notNull().default("pending"),
    /**
     * Vorfilter-Treffer, Judge-Antwort, `applyError` beim Anwenden. JSONB,
     * damit neue Beweisfelder keine Migration brauchen.
     */
    evidence: jsonb("evidence"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Gesetzt, sobald der Nutzer entschieden hat (freigegeben/abgelehnt). */
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => ({
    statusIdx: index("idx_ingest_proposals_status").on(table.status),
    vaultIdx: index("idx_ingest_proposals_vault").on(table.vaultId),
    jobIdx: index("idx_ingest_proposals_job").on(table.jobId),
  }),
);

export type IngestProposalRow = typeof ingestProposals.$inferSelect;
export type NewIngestProposalRow = typeof ingestProposals.$inferInsert;
