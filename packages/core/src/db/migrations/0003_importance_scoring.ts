/**
 * Phase A Wave A1 / Story 1 — Importance-Scoring with Power-Law Decay.
 *
 * Adds a sidecar `note_scoring` table keyed by the note's ULID. We do NOT
 * `ALTER` the on-disk notes representation (a vault note is a .md file
 * with frontmatter — there is no `notes` SQL table to extend). Keeping
 * scoring in its own row-per-ULID table:
 *
 *   - lets the sleep-agent recompute without touching the working copy,
 *   - keeps git history clean (no churn in .md files for view/edit counts),
 *   - keeps the scoring loop independent of the gitService lock.
 *
 * Indexes target the two hot read paths:
 *   - "top N most important notes"  → idx_note_scoring_importance
 *   - "most recently relevant notes" → idx_note_scoring_recency
 */
export const migration0003ImportanceScoring = `
CREATE TABLE IF NOT EXISTS note_scoring (
  note_id             TEXT PRIMARY KEY,
  importance_score    DOUBLE PRECISION NOT NULL DEFAULT 0,
  recency_score       DOUBLE PRECISION NOT NULL DEFAULT 1,
  last_accessed       TIMESTAMPTZ,
  incoming_backlinks  INTEGER NOT NULL DEFAULT 0,
  view_count          INTEGER NOT NULL DEFAULT 0,
  edit_count          INTEGER NOT NULL DEFAULT 0,
  co_citation_max     INTEGER NOT NULL DEFAULT 0,
  last_recomputed     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_scoring_importance
  ON note_scoring (importance_score DESC);

CREATE INDEX IF NOT EXISTS idx_note_scoring_recency
  ON note_scoring (recency_score DESC);
`;
