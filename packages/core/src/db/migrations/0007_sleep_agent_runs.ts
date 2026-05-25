/**
 * Phase A Wave A2 / Story 7 — Sleep-Agent Walking Skeleton.
 *
 * Tracks every run of the sleep-agent (idle / nightly / manual) and the
 * stats per pass. Walking-skeleton: only the importance-recompute pass
 * lands in Story 7; later stories append re-embed, multi-trace
 * consolidation, synaptic-pruning, topic-synthesis, lint, etc. without
 * touching this schema.
 *
 *   - `phase`    — "nrem" | "rem" | "lint" | "dream" | "manual"
 *   - `trigger`  — "idle" | "nightly" | "manual"
 *   - `status`   — "pending" | "running" | "completed" | "failed" | "cancelled"
 *   - `passes_completed` — pass names that succeeded for this run
 *   - `pass_stats` — `{ "importance-recompute": { processed: 384, errors: 2 }, … }`
 *
 * Indexes:
 *   - `idx_sleep_agent_status`  → "is anything running right now?"
 *   - `idx_sleep_agent_started` → recent-runs listing on the admin UI
 */
export const migration0007SleepAgentRuns = `
CREATE TABLE IF NOT EXISTS sleep_agent_runs (
  id                TEXT PRIMARY KEY,
  phase             TEXT NOT NULL,
  trigger           TEXT NOT NULL,
  status            TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  passes_completed  TEXT[] NOT NULL DEFAULT '{}',
  pass_stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message     TEXT,
  notes_processed   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sleep_agent_status
  ON sleep_agent_runs (status);

CREATE INDEX IF NOT EXISTS idx_sleep_agent_started
  ON sleep_agent_runs (started_at DESC);
`;
