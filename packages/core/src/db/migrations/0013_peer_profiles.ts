/**
 * Phase C Wave C2 / Story 3 — Honcho-style peer profiles.
 *
 * Sidecar table for `type: peer` notes. The note's frontmatter is the
 * source of truth (Forgejo > DB); this table is a cheap aggregate index
 * the `/api/peers` route serves without a per-row file read, and the
 * `peer-profile-update` REM-sleep pass writes into.
 *
 * The PK is the note id (path-without-".md"), matching the convention used
 * elsewhere in core (e.g. `note_scoring`). Existing customer notes are
 * untouched — `peer` is a NEW doc-type; the customer.json schema stays
 * backwards-compatible.
 *
 * Indexes:
 *   - `idx_peer_profiles_entity` — reverse lookup from an entity id to its
 *     bound peer-note (`/api/peers/suggestions` skips entities that already
 *     have a peer-note via this index).
 *   - `idx_peer_profiles_type`   — type-filtered listings.
 */
export const migration0013PeerProfiles = `
CREATE TABLE IF NOT EXISTS peer_profiles (
  note_id                 TEXT PRIMARY KEY,
  peer_type               TEXT NOT NULL,
  linked_entity_id        TEXT,
  relationship_strength   DOUBLE PRECISION NOT NULL DEFAULT 0,
  interaction_count       INTEGER NOT NULL DEFAULT 0,
  last_interaction        TIMESTAMPTZ,
  ongoing_topics          TEXT[] NOT NULL DEFAULT '{}',
  traits                  TEXT[] NOT NULL DEFAULT '{}',
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_peer_profiles_entity
  ON peer_profiles (linked_entity_id);

CREATE INDEX IF NOT EXISTS idx_peer_profiles_type
  ON peer_profiles (peer_type);
`;
