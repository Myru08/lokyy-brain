/**
 * Phase A Wave A2 / Stories 5+6 — Late Chunking + Multi-Chunk-Embedding.
 *
 * Extends `note_embeddings` from one-row-per-note to many-rows-per-note,
 * keyed additionally by `chunk_type` (title | body_full | section |
 * sliding_3para) and `chunk_idx`. A `content_hash` column carries a
 * sha256-prefix of the anchor-text-injected payload that was embedded —
 * used by the indexer to skip re-embed of unchanged chunks (incremental
 * pipeline, avoids Ollama round-trips for unchanged content).
 *
 * Backward-compat: existing rows (post Wave D) get chunk_type='body_full',
 * chunk_idx=0, content_hash=NULL. The hash check treats NULL as "unknown",
 * so the first re-index after this migration will refresh those rows.
 *
 * PK widens to (note_id, vault_id, generation, chunk_type, chunk_idx).
 */
export const migration0006MultiChunkEmbeddings = `
ALTER TABLE note_embeddings
  ADD COLUMN IF NOT EXISTS chunk_type TEXT NOT NULL DEFAULT 'body_full';

ALTER TABLE note_embeddings
  ADD COLUMN IF NOT EXISTS chunk_idx INTEGER NOT NULL DEFAULT 0;

ALTER TABLE note_embeddings
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

ALTER TABLE note_embeddings DROP CONSTRAINT IF EXISTS note_embeddings_pkey;
ALTER TABLE note_embeddings
  ADD CONSTRAINT note_embeddings_pkey
  PRIMARY KEY (note_id, vault_id, generation, chunk_type, chunk_idx);

CREATE INDEX IF NOT EXISTS idx_note_embeddings_chunk
  ON note_embeddings (note_id, vault_id, generation, chunk_type);

CREATE INDEX IF NOT EXISTS idx_note_embeddings_hash
  ON note_embeddings (content_hash) WHERE content_hash IS NOT NULL;
`;
