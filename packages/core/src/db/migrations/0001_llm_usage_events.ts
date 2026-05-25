/**
 * Phase-0 Wave D / Agent 2 — persist LLM BudgetTracker usage to DB.
 *
 * Adds an append-only `llm_usage_events` table with indexes that match the
 * two read paths used by `BudgetTracker`:
 *
 *   - `monthlyUsage(provider, since)`   → (provider, timestamp)
 *   - `listMonthlyUsage(since)`          → (timestamp)
 */
export const migration0001LlmUsageEvents = `
CREATE TABLE IF NOT EXISTS llm_usage_events (
  id                 TEXT PRIMARY KEY,
  provider           TEXT        NOT NULL,
  role               TEXT        NOT NULL,
  model              TEXT        NOT NULL,
  input_tokens       INTEGER     NOT NULL,
  output_tokens      INTEGER     NOT NULL,
  estimated_cost_usd DOUBLE PRECISION NOT NULL,
  timestamp          TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_provider_ts
  ON llm_usage_events(provider, timestamp);

CREATE INDEX IF NOT EXISTS idx_llm_usage_ts
  ON llm_usage_events(timestamp);
`;
