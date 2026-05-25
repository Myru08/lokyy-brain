import {
  pgTable,
  text,
  doublePrecision,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Phase A Wave A1 / Story 1 — per-note importance + recency scores.
 *
 * Sidecar to the on-disk vault. Keyed by the note's ULID (frontmatter `id`,
 * NOT the path id used in the HTTP layer — paths move, ULIDs don't). The
 * sleep-agent NREM phase recomputes scores nightly via `recomputeAll`.
 *
 * `last_accessed` is the "touch" timestamp — reset on note-open / note-edit
 * / new incoming wikilink, then read as `MAX(updated, last_accessed)` as
 * the recency-decay base.
 */
export const noteScoring = pgTable(
  "note_scoring",
  {
    /** Note's ULID (26 chars, Crockford base32). */
    noteId: text("note_id").primaryKey(),
    /** Composite [0..1] importance score — see scoring/importance.ts. */
    importanceScore: doublePrecision("importance_score").notNull().default(0),
    /** Power-law decay component [0..1], computed independently. */
    recencyScore: doublePrecision("recency_score").notNull().default(1),
    /** Last user touch (open or edit) or new incoming-wikilink trigger. */
    lastAccessed: timestamp("last_accessed", { withTimezone: true }),
    /** Cached count of incoming wikilinks at last recompute. */
    incomingBacklinks: integer("incoming_backlinks").notNull().default(0),
    /** Cumulative views (touch-view bumps this). */
    viewCount: integer("view_count").notNull().default(0),
    /** Cumulative edits (touch-edit bumps this). */
    editCount: integer("edit_count").notNull().default(0),
    /** Max co-citation count with any single other note at last recompute. */
    coCitationMax: integer("co_citation_max").notNull().default(0),
    /** When recomputeOne / recomputeAll last touched this row. */
    lastRecomputed: timestamp("last_recomputed", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    importanceIdx: index("idx_note_scoring_importance").on(table.importanceScore),
    recencyIdx: index("idx_note_scoring_recency").on(table.recencyScore),
  }),
);

export type NoteScoring = typeof noteScoring.$inferSelect;
export type NewNoteScoring = typeof noteScoring.$inferInsert;
