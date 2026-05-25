/**
 * Phase C Wave C2 / Story 2 — Entity-Extraction store.
 *
 * Tier-3 Knowledge-Graph foundation: persists named entities (people,
 * organizations, locations, concepts, dates, events) extracted from notes
 * by the REM-sleep `entity-extraction` pass (LLM-as-NER, lokal-bevorzugt
 * via Ollama). Two tables:
 *
 *   - `entities`        — canonical entity store. One row per (canonical
 *                         name, type). `aliases` holds the display-name
 *                         variants seen across notes. `mention_count`
 *                         tracks total mentions; `first_seen` / `last_seen`
 *                         bracket the observation window.
 *   - `entity_mentions` — per-(entity, note) edge. Composite PK keeps the
 *                         relation idempotent across re-runs of the pass.
 *                         `context` carries the surrounding text snippet
 *                         (truncated to 200 chars) for UI surfacing.
 *
 * Note on migration numbering: this story spec named the slot `0012` since
 * the parallel temporal-edges wave booked `0011`. Keep both ordered before
 * any later wave touches the chain.
 *
 * Indexes:
 *   - `idx_entities_canonical` — primary lookup path: "is this entity
 *      already known?" Hit per-extraction by the upsert in `entities/index.ts`.
 *   - `idx_entities_type`       — type-filtered listings (person-only etc.)
 *      surfaced by `/api/entities?type=person`.
 *   - `idx_entity_mentions_note`   — "entities in this note" queries.
 *   - `idx_entity_mentions_entity` — "notes for this entity" + co-occurrence.
 */
export const migration0012Entities = `
CREATE TABLE IF NOT EXISTS entities (
  id              TEXT PRIMARY KEY,
  canonical_name  TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  type            TEXT NOT NULL,
  aliases         TEXT[] NOT NULL DEFAULT '{}',
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mention_count   INTEGER NOT NULL DEFAULT 0,
  metadata        JSONB
);

CREATE INDEX IF NOT EXISTS idx_entities_canonical
  ON entities (canonical_name);

CREATE INDEX IF NOT EXISTS idx_entities_type
  ON entities (type);

CREATE TABLE IF NOT EXISTS entity_mentions (
  entity_id     TEXT NOT NULL,
  note_id       TEXT NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence    TEXT,
  context       TEXT,
  PRIMARY KEY (entity_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_note
  ON entity_mentions (note_id);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity
  ON entity_mentions (entity_id);
`;
