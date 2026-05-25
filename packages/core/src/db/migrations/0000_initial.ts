export const migration0000Initial = `
-- lokyy-brain initial schema (Story 1.8)
-- pgvector required for note_embeddings.embedding.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS vaults (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  git_remote  TEXT NOT NULL,
  git_branch  TEXT NOT NULL DEFAULT 'main',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vault_memberships (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, vault_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS note_embeddings (
  note_id     TEXT NOT NULL,
  vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  embedding   vector(768) NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, vault_id)
);

CREATE INDEX IF NOT EXISTS idx_note_embeddings_vault_id ON note_embeddings(vault_id);
CREATE INDEX IF NOT EXISTS idx_note_embeddings_embedding
  ON note_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value_text TEXT,
  value_bool BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
