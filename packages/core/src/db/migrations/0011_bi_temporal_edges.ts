/**
 * Phase C Wave C2 / Story 1 — Bi-Temporal Edges (Graphiti pattern).
 *
 * Parallel table to `edge_weights`. While `edge_weights` tracks a single
 * synaptic-strength value per directed pair (Tononi-Cirelli homeostasis),
 * `temporal_edges` tracks every asserted-fact claim with full bi-temporal
 * provenance: `t_created/t_expired` (system time) + `t_valid/t_invalid`
 * (real-world time). Invalidation never deletes — it sets `t_invalid` and
 * `invalidated_by`, preserving the history for time-travel queries.
 *
 * Schema mirrors `db/schema/temporalEdges.ts`. Keep them in sync.
 *
 * Partial active-index: `WHERE t_invalid IS NULL` keeps the hot retrieval
 * index O(active edges) instead of O(total rows). This matters because the
 * invalidation pattern produces unbounded historical rows over time.
 */
export const migration0011BiTemporalEdges = `
CREATE TABLE IF NOT EXISTS temporal_edges (
  id              TEXT PRIMARY KEY,
  from_note_id    TEXT NOT NULL,
  to_note_id      TEXT NOT NULL,
  edge_kind       TEXT NOT NULL,
  t_created       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  t_expired       TIMESTAMPTZ,
  t_valid         TIMESTAMPTZ NOT NULL,
  t_invalid       TIMESTAMPTZ,
  source_note_id  TEXT,
  invalidated_by  TEXT,
  fact_text       TEXT,
  confidence      TEXT,
  metadata        JSONB
);

CREATE INDEX IF NOT EXISTS idx_temporal_edges_from
  ON temporal_edges (from_note_id);

CREATE INDEX IF NOT EXISTS idx_temporal_edges_to
  ON temporal_edges (to_note_id);

-- Partial index: only rows currently active in the real-world timeline.
-- The hot retrieval query (activeEdgesFrom) filters on this predicate, so
-- the index size stays bounded by active-edge count even as the historical
-- tail grows.
CREATE INDEX IF NOT EXISTS idx_temporal_edges_active
  ON temporal_edges (from_note_id, to_note_id)
  WHERE t_invalid IS NULL;

CREATE INDEX IF NOT EXISTS idx_temporal_edges_valid
  ON temporal_edges (t_valid);
`;
