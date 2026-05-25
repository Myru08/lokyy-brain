/**
 * Phase C Wave C1 / Story 4 — Synaptic-Pruning sidecar (edge_weights).
 *
 * Tononi & Cirelli Synaptic Homeostasis: NREM sleep down-selects weak
 * synapses. Each wikilink edge gets a strength score; weak edges are
 * demoted, and after N consecutive demotions they move to the graveyard
 * (`pruned = 1`) without ever being hard-deleted (resurrection stays
 * possible — see `resurrectEdge`).
 *
 * Schema mirrors `db/schema/edgeWeights.ts`. Keep them in sync.
 *
 * NOTE on migration numbering: the story spec named this `0010_edge_weights`,
 * but parallel waves already booked `0008_mem0_review_queue` — we slot in at
 * `0009` so the sequential `_lokyy_migrations` chain stays contiguous.
 */
export const migration0009EdgeWeights = `
CREATE TABLE IF NOT EXISTS edge_weights (
  from_note_id        TEXT NOT NULL,
  to_note_id          TEXT NOT NULL,
  weight              DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  co_retrieval_count  INTEGER NOT NULL DEFAULT 0,
  demotion_count      INTEGER NOT NULL DEFAULT 0,
  last_demoted_at     TIMESTAMPTZ,
  pruned              INTEGER NOT NULL DEFAULT 0,
  last_updated        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_note_id, to_note_id)
);

CREATE INDEX IF NOT EXISTS idx_edge_weights_from
  ON edge_weights (from_note_id);

CREATE INDEX IF NOT EXISTS idx_edge_weights_pruned
  ON edge_weights (pruned);
`;
