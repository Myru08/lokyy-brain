/**
 * @lokyy/core — shared service layer for lokyy-brain.
 *
 * Imported by `server` and the future `mcp` package. Never by `pwa`
 * (browser import is forbidden via the import-graph tsconfig path
 * mapping; see architecture.md).
 *
 * Service migrations land per Epic 1 stories:
 *   - 1.3 → gitService
 *   - 1.4 → notesService, graphService, pipeQueue (this commit)
 *   - 1.5 → frontmatter / vault compliance (ulid, gray-matter, ajv)
 *
 * Pipe HANDLERS stay in the server (they may need server-specific config
 * like API keys). Core owns only the generic queue + dispatch.
 */

export const CORE_VERSION = "0.0.1";

// ─── Configuration injection ────────────────────────────────────────────
export {
  initCore,
  coreConfig,
  type CoreConfig,
} from "./util/coreConfig.js";

// ─── gitService (Story 1.3) ─────────────────────────────────────────────
export {
  initGitService,
  ensureRepo,
  pull,
  save,
  saveBinary,
  remove,
  move,
  lastModified,
  type GitConfig,
} from "./git/gitService.js";

// ─── graphService (Story 1.4 + backlinks) ──────────────────────────────
export {
  buildGraph,
  backlinks,
  listTags,
  parseAliases,
  parseLinks,
  parseTags,
  parseTitle,
  type Backlink,
  type TagSummary,
} from "./graph/graphService.js";

// ─── Personalized PageRank (Phase B Wave B1 / Story 1) ──────────────────
// HippoRAG-style spreading activation über den Wikilink-Graph.
export {
  personalizedPageRank,
  pageRankOnGraph,
  seedsFromRrfHits,
  type EdgeKind,
  type PPRSeeds,
  type PPROptions,
  type PPRHit,
} from "./graph/ppr.js";

// ─── notesService (Story 1.4) ───────────────────────────────────────────
export {
  listNotes,
  getNote,
  saveNote,
  getTree,
  createNote,
  createFolder,
  moveEntry,
  deleteEntry,
} from "./notes/notesService.js";

// ─── pipeQueue (Story 1.4) ──────────────────────────────────────────────
export {
  registerHandler,
  detectType,
  enqueue,
  listJobs,
  type PipeHandler,
} from "./pipes/pipeQueue.js";

// ─── frontmatter / vault compliance (Story 1.5) ─────────────────────────
export {
  generateUlid,
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
  DOC_TYPES,
  type DocType,
  type FrontmatterMap,
  type NotePrivacy,
  type BaseFrontmatter,
  type ValidationErrorDetail,
  type ValidationResult,
  // Phase B Wave B3 / Story 1 — Encoding-Context-Match-Boost (Tulving 1973).
  type EncodedContext,
  type DeviceType,
  type TimeOfDay,
  type Weekday,
} from "./frontmatter/index.js";

export { FrontmatterValidationError } from "./errors/FrontmatterValidationError.js";

// ─── Database (Story 1.8) ───────────────────────────────────────────────
export {
  initDb,
  database,
  closeDb,
  runMigrations,
  schema,
  type Database,
} from "./db/index.js";
export * from "./db/schema/index.js";

// ─── Setup state (Story 1.10) ───────────────────────────────────────────
export { isSetupComplete, markSetupComplete, resetSetup } from "./setup/setupState.js";

// ─── Integration settings (Supadata key, default import folder) ─────────
export {
  DEFAULT_IMPORT_FOLDER,
  getIntegrationSettings,
  getSupadataApiKey,
  getDefaultImportFolder,
  setSupadataApiKey,
  setDefaultImportFolder,
  maskSupadataKey,
  type IntegrationSettings,
} from "./setup/integrationSettings.js";

// ─── Dataview queries ───────────────────────────────────────────────────
export {
  queryNotes,
  type DataviewQuery,
  type DataviewRow,
} from "./dataview/index.js";

// ─── Templates ──────────────────────────────────────────────────────────
export {
  listTemplates,
  getTemplate,
  type TemplateRef,
} from "./templates/index.js";

// ─── Memory layer (Story 5.1–5.4) ───────────────────────────────────────
export {
  Tier1Provider,
  Tier2Provider,
  CombinedProvider,
  NullMemoryProvider,
  EmbeddingUnavailableError,
  getMemoryProvider,
  queueIndexRefresh,
  type MemoryProvider,
  type SearchHit,
  type SearchOpts,
  type RelatedOpts,
  type Tier2Config,
  // Phase A Wave A1 / Story 2 — BM25 + Hybrid retrieval.
  Tier1BM25,
  type BM25Hit,
  hybridSearch,
  resetHybridAvailabilityCache,
  type HybridOpts,
  getTier1BM25,
  queueSearchIndexRefresh,
  queueSearchIndexRemove,
} from "./memory/index.js";

// ─── Model-Agnostic LLM Layer (Phase 0) ─────────────────────────────────
export * from "./llm/index.js";

// ─── Importance Scoring (Phase A Wave A1 Story 1) ───────────────────────
export {
  ORIGIN_SCORES,
  HALF_LIFE_DAYS,
  originScore,
  recencyDecay,
  computeImportance,
  getScoring,
  upsertScoring,
  touchView,
  touchEdit,
  recomputeOne,
  recomputeAll,
  type ImportanceSignals,
  type NoteScoringRow,
  type RecomputeAllResult,
} from "./scoring/index.js";

// ─── Chunking (Phase A Wave A2 Stories 5+6) ─────────────────────────────
export {
  chunkNote,
  approximateTokens,
  hashChunk,
  type Chunk,
  type ChunkType,
  type ChunkOptions,
} from "./chunking/index.js";

// ─── Retrieval-Trace-Log (Phase A Wave A1 Story 3) ──────────────────────
export {
  logRetrieval,
  queryTraces,
  retrievalCounts,
  coRetrievalPairs,
  isRetrievalSource,
  RETRIEVAL_SOURCES,
  type RetrievalSource,
  type RetrievalEvent,
  type RetrievalTraceRow,
  type TraceQueryOpts,
} from "./scoring/index.js";

// ─── Working-Memory + Spacing-Effect (Phase B Wave B2 Story 2) ──────────
export {
  WorkingMemory,
  workingMemory,
  getSurfaceRecommendations,
  SURFACE_MAX_HOT_NOTES,
  type WorkingMemoryEntry,
  type WorkingMemoryBoost,
  type WorkingMemoryOptions,
  type SurfaceRecommendation,
} from "./scoring/index.js";

// ─── Encoding-Context-Match-Boost (Phase B Wave B3 Story 1) ─────────────
// Tulving 1973: capture device/time/weekday/preceding-notes at create-time,
// match it at retrieve-time, multiply the retrieval score by a small boost.
export {
  captureEncodingContext,
  timeOfDayFrom,
  weekdayFrom,
  contextMatchBoost,
  applyContextBoost,
  type CaptureContextInput,
  type QueryContext,
  type ContextMatchResult,
  type ScoredHit,
} from "./scoring/index.js";

// ─── Sleep-Agent (Phase A Wave A2 Story 7) ──────────────────────────────
export {
  SleepAgent,
  sleepAgent,
  type SleepPhase,
  type SleepTrigger,
  type SleepStatus,
  type SleepRun,
  type SleepPass,
  type SleepPassResult,
} from "./sleep-agent/index.js";

// ─── End-to-End Retrieval-Pipeline (Phase B Wave B3 / Story 2) ──────────
// Orchestrates the eight cognitive-loop stages (rewrite → intent → hybrid
// → PPR → encoding-context → rerank → lost-in-middle → generate-with-
// reflection). See packages/core/src/pipeline/search.ts.
export {
  SearchPipeline,
  buildSearchPipeline,
  type SearchPipelineInput,
  type SearchPipelineResult,
  type PipelineStepTrace,
} from "./pipeline/index.js";
