import { pgTable, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

/**
 * Embedding-migration tracker (Phase-0 Wave D / Agent 1).
 *
 * One row per re-embed run triggered by the user when the embedding
 * provider/model changes (e.g. Ollama nomic → OpenAI text-embedding-3-small).
 *
 * Lifecycle:
 *   - `status = "pending"` → row inserted by `startMigration`, worker not
 *     spawned yet.
 *   - `status = "running"` → worker started, `processedNotes` ticking up.
 *   - `status = "completed"` → all notes re-embedded, `active_embeddings_generation`
 *     atomically flipped to this row's `id`.
 *   - `status = "failed"`   → worker crashed; old generation remains active.
 *   - `status = "cancelled"` → user-aborted via cancel endpoint.
 *
 * `noteStatus` is a JSON object keyed by noteId. Values:
 *   - `"done"`        → embedded successfully under this migration's generation
 *   - `"error: <msg>"` → individual-note failure (does NOT fail the whole run)
 *
 * On server restart, `resumePendingMigration()` continues any row left in
 * pending/running by skipping noteIds already marked "done" in `noteStatus`.
 */
export const embeddingMigrations = pgTable("embedding_migrations", {
  /** ULID; also used as the `generation` tag on the embeddings table. */
  id: text("id").primaryKey(),
  fromProvider: text("from_provider").notNull(),
  fromModel: text("from_model").notNull(),
  fromDimensions: integer("from_dimensions").notNull(),
  toProvider: text("to_provider").notNull(),
  toModel: text("to_model").notNull(),
  toDimensions: integer("to_dimensions").notNull(),
  /** "pending" | "running" | "completed" | "failed" | "cancelled" */
  status: text("status").notNull(),
  totalNotes: integer("total_notes").notNull(),
  processedNotes: integer("processed_notes").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  /** { noteId: "done" | "error: msg" } */
  noteStatus: jsonb("note_status")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
});

export type EmbeddingMigration = typeof embeddingMigrations.$inferSelect;
export type NewEmbeddingMigration = typeof embeddingMigrations.$inferInsert;

/** system_config key holding the currently-active embeddings generation tag. */
export const ACTIVE_EMBEDDINGS_GENERATION_KEY = "active_embeddings_generation";

/** Default generation tag for the initial (pre-migration) embeddings. */
export const DEFAULT_EMBEDDINGS_GENERATION = "default";
