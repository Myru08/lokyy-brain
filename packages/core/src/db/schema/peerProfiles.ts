import {
  pgTable,
  text,
  timestamp,
  integer,
  doublePrecision,
  index,
} from "drizzle-orm/pg-core";

/**
 * Phase C Wave C2 / Story 3 — Honcho-style peer profile sidecar.
 *
 * One row per peer-note. The note's frontmatter is the source of truth
 * (Forgejo > DB); this table is a cheap aggregate index served by
 * `/api/peers/*` so listing 200 peers doesn't fan out into 200 file reads.
 *
 * The `peer-profile-update` REM-sleep pass writes the row (and back to the
 * note frontmatter); user edits in PropertiesPanel go through `saveNote` →
 * frontmatter wins → next sleep run reconciles. Recompute is fire-and-
 * forget — if the DB is offline the note still loads.
 *
 * `noteId` is the path-without-".md" form (e.g. `peers/anna-mueller`),
 * matching `note_scoring` and the wikilink graph convention.
 */
export const peerProfiles = pgTable(
  "peer_profiles",
  {
    /** Note id (path without `.md`). PK so reads are O(1). */
    noteId: text("note_id").primaryKey(),
    /** One of PEER_TYPES — "person" | "customer" | "collaborator" | "family" | "agent" | "organization". */
    peerType: text("peer_type").notNull(),
    /** Optional FK into `entities.id`. Null if the peer was created manually. */
    linkedEntityId: text("linked_entity_id"),
    /** 0..1 — composite of interaction frequency, recency, and topic diversity. */
    relationshipStrength: doublePrecision("relationship_strength")
      .notNull()
      .default(0),
    /** Distinct interaction events (mention + retrieval). Monotonic across runs. */
    interactionCount: integer("interaction_count").notNull().default(0),
    /** Latest evidence timestamp — max(mention.observed_at, trace.accessed_at). */
    lastInteraction: timestamp("last_interaction", { withTimezone: true }),
    /** Aggregated topic strings — co-tagged in mention/customer/meeting notes. */
    ongoingTopics: text("ongoing_topics").array().notNull().default([]),
    /** Free-form personality / communication traits — pass-through from frontmatter. */
    traits: text("traits").array().notNull().default([]),
    /** Wall-clock when the sleep-pass last touched this row. */
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    entityIdx: index("idx_peer_profiles_entity").on(t.linkedEntityId),
    typeIdx: index("idx_peer_profiles_type").on(t.peerType),
  }),
);

export type PeerProfileRow = typeof peerProfiles.$inferSelect;
export type NewPeerProfileRow = typeof peerProfiles.$inferInsert;
