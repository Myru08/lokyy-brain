/**
 * Phase A Wave A1 / Story 1 — scoring barrel.
 *
 * `importance.ts` is pure (no I/O); `store.ts` is the DB adapter. Server
 * routes (`/api/scoring/*`) and the sleep-agent NREM phase both import
 * through here.
 */

export {
  ORIGIN_SCORES,
  HALF_LIFE_DAYS,
  originScore,
  recencyDecay,
  computeImportance,
  type ImportanceSignals,
} from "./importance.js";

export {
  getScoring,
  upsertScoring,
  touchView,
  touchEdit,
  recomputeOne,
  recomputeAll,
  type NoteScoringRow,
  type RecomputeAllResult,
} from "./store.js";

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
} from "./retrievalLog.js";

// Phase B Wave B2 / Story 2 — working-memory + spacing-effect-surfacing.
export {
  WorkingMemory,
  workingMemory,
  getSurfaceRecommendations,
  SURFACE_MAX_HOT_NOTES,
  _resetWorkingMemoryForTests,
  type WorkingMemoryEntry,
  type WorkingMemoryBoost,
  type WorkingMemoryOptions,
  type SurfaceRecommendation,
} from "./workingMemory.js";
