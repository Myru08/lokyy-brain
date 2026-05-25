import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * `note_search` — materialised search corpus for ParadeDB `pg_search`
 * BM25 indexing (Phase A Wave A1 / Story 2).
 *
 * The vault filesystem remains the source of truth. This table is the
 * BM25-indexable mirror that the `Tier1BM25` provider keeps in sync via
 * `upsert(noteId, title, body, tags)` on every note save and `remove(noteId)`
 * on every delete. Hybrid retrieval (BM25 + dense pgvector via RRF) joins
 * this table with `note_embeddings`.
 *
 * The pg_search BM25 index is added in migration 0004 via raw SQL — Drizzle
 * has no native helper for `USING bm25 (...) WITH (key_field = '...')`.
 */
export const noteSearch = pgTable(
  "note_search",
  {
    noteId: text("note_id").primaryKey(),
    vaultId: text("vault_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Parsed `#tag` list from the note body, lowercase, no leading `#`. */
    tags: text("tags").array().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    vaultIdIdx: index("idx_note_search_vault_id").on(t.vaultId),
  }),
);

export type NoteSearchRow = typeof noteSearch.$inferSelect;
export type NewNoteSearchRow = typeof noteSearch.$inferInsert;
