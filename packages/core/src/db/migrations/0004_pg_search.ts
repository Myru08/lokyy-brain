/**
 * Phase A Wave A1 / Story 2 — ParadeDB pg_search BM25 + Hybrid Retrieval.
 *
 * Adds:
 *   1. `pg_search` extension (Tantivy-based BM25 over Postgres).
 *   2. `note_search` table — materialised search corpus, populated from the
 *      filesystem-based vault via `Tier1BM25.upsert(...)` whenever a note is
 *      saved. This is the BM25-indexable mirror of the on-disk notes; the
 *      vault itself remains the source of truth, the DB row exists purely to
 *      give pg_search something to index.
 *   3. BM25 index on (title, body, tags) keyed by note_id.
 *
 * Graceful degradation: if the pg_search extension is not present in the
 * Postgres image, the CREATE EXTENSION fails inside a DO block that logs a
 * NOTICE but does NOT abort the migration. The note_search table is still
 * created (it doubles as a structural cache) and the BM25 index creation is
 * also wrapped so missing-extension does not break server start.
 *
 * Runtime code (Tier1BM25, hybridSearch) detects the extension's presence at
 * query time and falls back to dense-only (or LIKE-based BM25-ish) retrieval
 * when pg_search is missing.
 *
 * Docker images:
 *   - `paradedb/paradedb:latest` — ParadeDB's drop-in Postgres image,
 *     ships pg_search + pgvector. Used by lokyy-brain's docker-compose.yml
 *     and docker-compose.coolify.yml.
 *   - `pgvector/pgvector:pg16` — legacy; pg_search NOT available, runtime
 *     falls back automatically.
 */
export const migration0004PgSearch = `
-- 1) Try to create the pg_search extension. Wrap in DO/EXCEPTION so a
--    Postgres image without pg_search (e.g. plain pgvector/pgvector:pg16)
--    can still apply this migration — runtime code detects the gap and
--    degrades gracefully.
DO $pg_search$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_search;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE '[migration 0004] pg_search extension unavailable (%) — hybrid search will fall back to dense-only.', SQLERRM;
END
$pg_search$;

-- 2) note_search: materialised mirror of vault notes. note_id is the same
--    string id used everywhere else (path-without-".md"). Body is the raw
--    markdown (frontmatter included is fine — BM25 will just treat YAML
--    tokens as terms; in practice low-noise). Tags is the parsed tag list.
CREATE TABLE IF NOT EXISTS note_search (
  note_id     TEXT PRIMARY KEY,
  vault_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_search_vault_id ON note_search(vault_id);

-- 3) BM25 index — only created if pg_search is actually installed. The DO
--    block checks pg_extension and creates the index only on success; on
--    failure it emits a NOTICE.
DO $bm25_index$
DECLARE
  has_ext BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_search') INTO has_ext;
  IF has_ext THEN
    -- ParadeDB BM25 index syntax (pg_search v0.x):
    --   USING bm25 (key, field1, field2, …) WITH (key_field = '…')
    -- We index title, body and the textified tags array.
    BEGIN
      EXECUTE $idx$
        CREATE INDEX IF NOT EXISTS note_search_bm25 ON note_search
        USING bm25 (note_id, title, body, tags)
        WITH (key_field = 'note_id')
      $idx$;
      RAISE NOTICE '[migration 0004] note_search_bm25 index created.';
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE '[migration 0004] BM25 index creation failed (%) — runtime will degrade to dense-only.', SQLERRM;
    END;
  ELSE
    RAISE NOTICE '[migration 0004] pg_search not installed — skipping BM25 index. Runtime degrades to dense-only.';
  END IF;
END
$bm25_index$;
`;
