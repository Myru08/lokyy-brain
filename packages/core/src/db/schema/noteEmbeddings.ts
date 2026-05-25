import { pgTable, text, timestamp, customType, index } from "drizzle-orm/pg-core";
import { vaults } from "./vaults.js";

/**
 * pgvector `vector(N)` custom column type.
 *
 * Drizzle's core lacks a first-class vector helper; we model it as TEXT in
 * the type system (Postgres `vector(768)` accepts and returns string form
 * `'[0.1,0.2,…]'`) so that read/write paths compile cleanly. Tier 2 code
 * does the array<->string conversion at the boundary.
 */
const vector768 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "vector(768)";
  },
});

export const noteEmbeddings = pgTable(
  "note_embeddings",
  {
    noteId: text("note_id").notNull(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    embedding: vector768("embedding").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    vaultIdIdx: index("idx_note_embeddings_vault_id").on(t.vaultId),
  }),
);

export type NoteEmbedding = typeof noteEmbeddings.$inferSelect;
export type NewNoteEmbedding = typeof noteEmbeddings.$inferInsert;
