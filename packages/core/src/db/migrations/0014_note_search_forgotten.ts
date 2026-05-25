/**
 * Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
 *
 * Adds a boolean `forgotten` column to the BM25-backing `note_search`
 * table. Default `false` so every legacy row is treated as not-forgotten
 * (backwards-compat with the frontmatter contract — absent field == not
 * forgotten). A partial index on `forgotten = false` keeps active-note
 * search scans hot; the predicate matches the WHERE clause used by
 * `Tier1BM25.search` + `hybridSearch` + the Tier2 join.
 *
 * Tier 2 (`note_embeddings`) is filtered at query-time via an inner JOIN
 * against `note_search.forgotten = false` rather than duplicating the
 * column — single source of truth, no risk of the two getting out of
 * sync when forget() / unforget() flips state.
 */
export const migration0014NoteSearchForgotten = `
ALTER TABLE note_search
  ADD COLUMN IF NOT EXISTS forgotten BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_note_search_forgotten
  ON note_search (forgotten)
  WHERE forgotten = FALSE;
`;
