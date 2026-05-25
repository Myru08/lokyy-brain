export const migration0002EmbeddingsMigration = `
-- Phase-0 Wave D / Agent 1: Embedding-Migration Workflow.
--
-- Adds:
--   1. \`generation\` column on note_embeddings + extended PK including it.
--      Old rows are tagged "default"; new migrations write under their own
--      ULID-tagged generation, allowing atomic swap.
--   2. embedding_migrations table — one row per re-embed run.
--   3. active_embeddings_generation seed in system_config.

ALTER TABLE note_embeddings
  ADD COLUMN IF NOT EXISTS generation TEXT NOT NULL DEFAULT 'default';

-- Drop the legacy (note_id, vault_id) PK and rebuild including generation.
-- IF EXISTS guards re-runs on environments where the legacy PK was already
-- replaced (no-op when constraint absent).
ALTER TABLE note_embeddings DROP CONSTRAINT IF EXISTS note_embeddings_pkey;
ALTER TABLE note_embeddings
  ADD PRIMARY KEY (note_id, vault_id, generation);

CREATE INDEX IF NOT EXISTS idx_note_embeddings_generation
  ON note_embeddings(generation);

CREATE TABLE IF NOT EXISTS embedding_migrations (
  id               TEXT PRIMARY KEY,
  from_provider    TEXT NOT NULL,
  from_model       TEXT NOT NULL,
  from_dimensions  INTEGER NOT NULL,
  to_provider      TEXT NOT NULL,
  to_model         TEXT NOT NULL,
  to_dimensions    INTEGER NOT NULL,
  status           TEXT NOT NULL,
  total_notes      INTEGER NOT NULL,
  processed_notes  INTEGER NOT NULL DEFAULT 0,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ,
  error_message    TEXT,
  note_status      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_embedding_migrations_status
  ON embedding_migrations(status);

-- Seed the active-generation flag to "default" so existing queries that
-- start filtering on the flag keep matching the pre-migration corpus.
INSERT INTO system_config (key, value_text)
VALUES ('active_embeddings_generation', 'default')
ON CONFLICT (key) DO NOTHING;
`;
