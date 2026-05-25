/**
 * Phase A Wave A1 / Story 3 — Retrieval-Trace-Log (Multi-Trace-Theory).
 *
 * Nadel & Moscovitch (1997): every retrieval is a write-event. We log each
 * note-access (search / wikilink / cmd-k / cmd-o / hover / embed / api / mcp)
 * as a row in `retrieval_traces` with session context. Over time this
 * builds "many indices into the same content" and feeds the future
 * sleep-agent + recency-reset loop.
 *
 * Sidecar table, append-only, no FK on `note_id` (notes are .md files on
 * disk — their on-disk lifecycle is owned by `gitService`; we don't want
 * a stale trace to block a vault rebase).
 *
 * Indexes:
 *   - by note          → "show all accesses for note X"
 *   - by session       → "what did this session touch?" + co-retrieval pairs
 *   - by accessed_at   → time-range scans for retrievalCounts / aggregation
 */
export const migration0005RetrievalTraces = `
CREATE TABLE IF NOT EXISTS retrieval_traces (
  id            TEXT PRIMARY KEY,
  note_id       TEXT NOT NULL,
  accessed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id    TEXT,
  user_id       TEXT,
  source        TEXT NOT NULL,
  query         TEXT,
  preceding     TEXT[],
  context       JSONB
);

CREATE INDEX IF NOT EXISTS idx_retrieval_traces_note
  ON retrieval_traces (note_id);

CREATE INDEX IF NOT EXISTS idx_retrieval_traces_session
  ON retrieval_traces (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_retrieval_traces_time
  ON retrieval_traces (accessed_at);
`;
