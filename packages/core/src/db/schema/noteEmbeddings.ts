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
    /**
     * Generation tag — "default" for the initial (pre-migration) corpus,
     * otherwise the ULID of an embedding-migration row. Active generation
     * is read from `system_config[active_embeddings_generation]`.
     *
     * Atomic-swap design (Phase-0 Wave D): a new embedding-migration writes
     * all rows tagged with its own ULID, then the system_config flag flips
     * to point at it. Old-generation rows are deleted by a cleanup pass
     * after a grace period.
     *
     * NOTE on variable dimensions: the `embedding` column is locked to
     * `vector(768)`. Switching to a provider with different dimensions
     * (e.g. OpenAI text-embedding-3-small at 1536 or Voyage voyage-3 at
     * 1024) requires either a per-generation typed column or a sibling
     * table. That work is deferred to Phase A — for Wave D, migrations
     * across models that happen to share 768-dim work end-to-end; cross-
     * dimension migrations are validated and rejected at start time.
     */
    generation: text("generation").notNull().default("default"),
    embedding: vector768("embedding").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    vaultIdIdx: index("idx_note_embeddings_vault_id").on(t.vaultId),
    generationIdx: index("idx_note_embeddings_generation").on(t.generation),
  }),
);

export type NoteEmbedding = typeof noteEmbeddings.$inferSelect;
export type NewNoteEmbedding = typeof noteEmbeddings.$inferInsert;
