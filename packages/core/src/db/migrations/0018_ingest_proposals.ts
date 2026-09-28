/**
 * Issue #67 — `ingest_proposals`: Audit-Log der Ingest-Time-Synthese.
 *
 * Append-only. Eine Zeile pro Vorschlag; eine Entscheidung ist ein UPDATE des
 * `status` (+ `decided_at`) auf derselben Zeile. Kein Backfill nötig — die
 * Tabelle ist neu und beschreibt ausschließlich künftige Importe.
 *
 * `vault_id` bewusst OHNE `REFERENCES vaults(id)`: `indexVaultId()` liefert auf
 * nicht-injizierten Installationen einen Platzhalter, ein FK würde dort jeden
 * Insert abweisen und die Stufe still abschalten (Fehlermodus aus #43).
 *
 * `status` als CHECK, damit ein falscher Wert hier scheitert und nicht später
 * als undefinierter Zustand durch die Approval-Karte wandert.
 */
export const migration0018IngestProposals = `
CREATE TABLE IF NOT EXISTS ingest_proposals (
  id              TEXT PRIMARY KEY,
  vault_id        TEXT NOT NULL,
  job_id          TEXT NOT NULL,
  action          TEXT NOT NULL,
  source_note_id  TEXT NOT NULL,
  target_note_id  TEXT,
  rationale       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','applied','failed')),
  evidence        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ingest_proposals_status
  ON ingest_proposals (status);

CREATE INDEX IF NOT EXISTS idx_ingest_proposals_vault
  ON ingest_proposals (vault_id);

CREATE INDEX IF NOT EXISTS idx_ingest_proposals_job
  ON ingest_proposals (job_id);
`;
