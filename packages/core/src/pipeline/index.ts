/**
 * Phase B Wave B3 / Story 2 — Retrieval-Pipeline barrel.
 *
 * The orchestrator that wires the eight cognitive-loop stages
 * (rewrite → intent → hybrid → PPR → encoding-context → rerank
 *  → lost-in-middle → generate-with-reflection). See `search.ts`
 * for the per-step rationale.
 */

export {
  SearchPipeline,
  buildSearchPipeline,
  type SearchPipelineInput,
  type SearchPipelineResult,
  type PipelineStepTrace,
} from "./search.js";
