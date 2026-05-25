/**
 * Migration registry. Each entry is an `{ name, sql }` pair, applied
 * in order. Adding a new migration: append to this array — never remove
 * or reorder, the names are tracked in `_lokyy_migrations`.
 */

import { migration0000Initial } from "./0000_initial.js";
import { migration0001LlmUsageEvents } from "./0001_llm_usage_events.js";
import { migration0002EmbeddingsMigration } from "./0002_embeddings_migration.js";
import { migration0003ImportanceScoring } from "./0003_importance_scoring.js";
import { migration0004PgSearch } from "./0004_pg_search.js";
import { migration0005RetrievalTraces } from "./0005_retrieval_traces.js";
import { migration0006MultiChunkEmbeddings } from "./0006_multi_chunk_embeddings.js";
import { migration0007SleepAgentRuns } from "./0007_sleep_agent_runs.js";
import { migration0008Mem0ReviewQueue } from "./0008_mem0_review_queue.js";
import { migration0009EdgeWeights } from "./0009_edge_weights.js";
import { migration0010LintFindings } from "./0010_lint_findings.js";
import { migration0011BiTemporalEdges } from "./0011_bi_temporal_edges.js";
import { migration0012Entities } from "./0012_entities.js";
import { migration0013PeerProfiles } from "./0013_peer_profiles.js";
import { migration0014NoteSearchForgotten } from "./0014_note_search_forgotten.js";

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { name: "0000_initial", sql: migration0000Initial },
  { name: "0001_llm_usage_events", sql: migration0001LlmUsageEvents },
  { name: "0002_embeddings_migration", sql: migration0002EmbeddingsMigration },
  { name: "0003_importance_scoring", sql: migration0003ImportanceScoring },
  { name: "0004_pg_search", sql: migration0004PgSearch },
  { name: "0005_retrieval_traces", sql: migration0005RetrievalTraces },
  { name: "0006_multi_chunk_embeddings", sql: migration0006MultiChunkEmbeddings },
  { name: "0007_sleep_agent_runs", sql: migration0007SleepAgentRuns },
  { name: "0008_mem0_review_queue", sql: migration0008Mem0ReviewQueue },
  { name: "0009_edge_weights", sql: migration0009EdgeWeights },
  { name: "0010_lint_findings", sql: migration0010LintFindings },
  { name: "0011_bi_temporal_edges", sql: migration0011BiTemporalEdges },
  { name: "0012_entities", sql: migration0012Entities },
  { name: "0013_peer_profiles", sql: migration0013PeerProfiles },
  { name: "0014_note_search_forgotten", sql: migration0014NoteSearchForgotten },
];
