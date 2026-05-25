/**
 * Phase C Wave C1 / Story 1 — Mem0 classifier review queue.
 *
 * Stores ADD/UPDATE/DELETE/NOOP decisions produced by the REM-sleep
 * classifier pass (`mem0-classifier`). Rows are NEVER auto-applied — they
 * stay `status = 'pending'` until a human accepts/rejects them via the
 * `/api/mem0/review/*` routes. On accept, the chosen operation is applied
 * (UPDATE rewrites the target note, DELETE removes it, NOOP/ADD are
 * book-keeping) and the row flips to `applied`.
 *
 * Schema notes:
 *   - `confidence` is TEXT (stringified float 0..1) to dodge Postgres
 *     numeric coercion when the classifier hands us a JSON number.
 *   - `payload` is JSONB so future ops can pack extra fields (diff hints,
 *     merge metadata) without a schema migration.
 *   - `target_note_id` is intentionally nullable; ADD / NOOP have no target.
 *
 * Index:
 *   - `idx_mem0_review_status` — pending-queue listing is the hot path.
 */
export const migration0008Mem0ReviewQueue = `
CREATE TABLE IF NOT EXISTS mem0_review_queue (
  id              TEXT PRIMARY KEY,
  note_id         TEXT NOT NULL,
  operation       TEXT NOT NULL,
  target_note_id  TEXT,
  confidence      TEXT NOT NULL,
  reasoning       TEXT NOT NULL,
  payload         JSONB,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_mem0_review_status
  ON mem0_review_queue (status);
`;
