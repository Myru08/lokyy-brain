/**
 * Phase C Wave C1 / Story 3 — Karpathy-Lint findings.
 *
 * Persists the output of the daily lint sleep-pass. Five heuristics
 * (orphan / contradiction / missing_link / schema_drift / duplicate) each
 * produce findings into the same table; the user-facing review queue lists
 * `status = 'open'` rows and walks them through acknowledged → fixed (or
 * dismissed).
 *
 * Schema notes:
 *   - `note_ids` is an array because contradiction/duplicate touch two
 *     notes and missing_link touches N referring sources.
 *   - `evidence` is JSONB so the per-kind payload (similarity score, missing
 *     target, Ajv errors, …) can evolve without a migration.
 *
 * Indexes:
 *   - `idx_lint_status` — the review queue's hot listing path.
 *   - `idx_lint_kind`   — per-kind dashboards (orphan counts, …).
 */
export const migration0010LintFindings = `
CREATE TABLE IF NOT EXISTS lint_findings (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  note_ids      TEXT[] NOT NULL,
  severity      TEXT NOT NULL,
  message       TEXT NOT NULL,
  evidence      JSONB,
  status        TEXT NOT NULL DEFAULT 'open',
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lint_status
  ON lint_findings (status);

CREATE INDEX IF NOT EXISTS idx_lint_kind
  ON lint_findings (kind);
`;
