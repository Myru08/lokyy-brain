/**
 * Migration registry. Each entry is an `{ name, sql }` pair, applied
 * in order. Adding a new migration: append to this array — never remove
 * or reorder, the names are tracked in `_lokyy_migrations`.
 */

import { migration0000Initial } from "./0000_initial.js";
import { migration0001LlmUsageEvents } from "./0001_llm_usage_events.js";
import { migration0002EmbeddingsMigration } from "./0002_embeddings_migration.js";

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { name: "0000_initial", sql: migration0000Initial },
  { name: "0001_llm_usage_events", sql: migration0001LlmUsageEvents },
  { name: "0002_embeddings_migration", sql: migration0002EmbeddingsMigration },
];
