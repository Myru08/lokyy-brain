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
  // Story: separate Save & Sync buttons — reconcile (pull --rebase + push
  // unpushed) without writing note content. Consumed by POST /api/vault/sync.
  sync,
  save,
  saveBinary,
  remove,
  move,
  lastModified,
  setupVaultFromForgejo,
  // Story 10.17 — read-only note version-history + diff. Consumed by the MCP
  // get_history / get_note_diff tools (Epic 10 Wave 4).
  noteHistory,
  noteDiff,
  // Story 11.11 — read-only vault-wide commit activity (streak / heatmap).
  // Consumed by the GET /api/dashboard/activity route. K-3: only Story 11.11
  // touches gitService (R-4).
  vaultActivity,
  type GitConfig,
  type NoteHistoryEntry,
  type NoteDiff,
  type SyncResult,
  type VaultActivity,
  type VaultActivityDay,
} from "./git/gitService.js";

// ─── graphService (Story 1.4 + backlinks) ──────────────────────────────
export {
  buildGraph,
  backlinks,
  listTags,
  // Story 10.16 — vault-wide broken-wikilink scan. Consumed by the MCP
  // find_broken_links tool (Epic 10 Wave 4).
  findBrokenLinks,
  parseAliases,
  parseLinks,
  parseTags,
  parseTitle,
  type Backlink,
  type TagSummary,
  type BrokenLink,
} from "./graph/graphService.js";

// ─── Edge-Weights / Synaptic-Pruning (Phase C Wave C1 / Story 4) ────────
// Sidecar table tracking the "synaptic strength" of each wikilink edge.
// The NREM `synaptic-pruning` pass writes; retrieval + HTTP reads.
export {
  getActiveEdgeWeight,
  listPrunedEdges,
  listEdgesForNote,
  resurrectEdge,
  type PrunedEdge,
  type EdgeWeightRow,
} from "./graph/edgeWeights.js";

// ─── Bi-Temporal Edges (Phase C Wave C2 / Story 1) ──────────────────────
// Graphiti-pattern: every asserted-fact carries four timestamps (t_created,
// t_expired, t_valid, t_invalid). Invalidation never deletes — point-in-
// time queries return the edges that were valid at any past timestamp.
// Sits parallel to edge_weights; different table, different use-case.
export {
  createTemporalEdge,
  invalidateEdge,
  activeEdgesFrom,
  edgesFromAsOf,
  edgeHistory,
  findInvalidationCandidates,
  syncWikilinksToTemporalEdges,
  markEdgeStale,
  type TemporalEdge,
  type TemporalEdgeInput,
} from "./graph/temporalEdges.js";
export {
  EDGE_KINDS,
  isTemporalEdgeKind,
  type TemporalEdgeKind,
  type TemporalEdgeRow,
  type NewTemporalEdgeRow,
} from "./db/schema/temporalEdges.js";

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

// ─── Community Detection (Phase C Wave C1 / Story 2) ────────────────────
// Label-propagation over the Wikilink graph, feeds the topic-synthesis
// sleep pass. See packages/core/src/graph/community.ts.
export {
  detectCommunities,
  type CommunityDetectionOpts,
  type CommunityResult,
} from "./graph/community.js";

// ─── notesService (Story 1.4) ───────────────────────────────────────────
// NOTE: `moveEntry` + `createFolder` are part of the Story 10.10 wave-3 MCP
// surface (used by the move/create-folder tools) — already exported here, so
// the MCP-wiring agent imports them straight from `@lokyy/core`.
export {
  listNotes,
  getNote,
  saveNote,
  getTree,
  createNote,
  createFolder,
  moveEntry,
  deleteEntry,
  // Story 10.10 — bulk-ops: atomic (on validation) create/update of many
  // notes in one call. Consumed by the MCP create_notes / update_notes tools.
  createNotes,
  updateNotes,
  // Story 10.3 — soft-delete (trash) helper for the MCP delete_note tool.
  trashEntry,
  TRASH_FOLDER,
  type CreateNoteOpts,
  type TrashResult,
  // Story 10.10 — bulk-op item + result shapes for the MCP layer.
  type BulkCreateItem,
  type BulkUpdateItem,
  type BulkItemError,
  type BulkResult,
} from "./notes/notesService.js";

// ─── Canonical type→folder map (Story 10.2) ─────────────────────────────
// Single source of truth coupling a doc type to its vault folder. Used by
// createNote (placement guard) and the MCP create_note tool for path
// derivation; re-used by Story 10.4 (get_vault_conventions).
export {
  TYPE_FOLDER,
  folderForType,
  isDatedType,
  derivePathForType,
  checkPathMatchesType,
  canonicalFolders,
  type PathTypeCheck,
} from "./notes/folderMap.js";

export { TypeFolderMismatchError } from "./errors/TypeFolderMismatchError.js";

// ─── createManaged (Story 13.1 / ADR-004) ──────────────────────────────
// THE single sanctioned write path for new notes — one shared core source
// consumed by BOTH the MCP `notes.create_managed` tool AND the HTTP
// `POST /api/notes/create-managed` route (no parallel write surface, ISC-59).
// `resolveManagedCreate`/`slugifyTitle` are the pure resolver (so MCP can
// scope-gate the derived path); `createManaged` resolves THEN writes via
// createNote.
export {
  createManaged,
  resolveManagedCreate,
  slugifyTitle,
  type NoteCreateIntent,
  type ManagedCreateInput,
  type ManagedCreateInputError,
  type ManagedCreateError,
  type ManagedCreateResult,
} from "./notes/createManaged.js";

// ─── Vault conventions (Story 10.4) ─────────────────────────────────────
// Machine-readable folders/types/path-patterns + frontmatter summary, derived
// from folderMap + DOC_TYPES (no drift). Served by the MCP get_vault_conventions
// tool so first-time agents don't guess the structure.
export {
  getVaultConventions,
  type VaultConventions,
  type FolderConvention,
  type TypeConvention,
  type FrontmatterConvention,
  type FrontmatterFieldConvention,
} from "./conventions/index.js";

// ─── findByUlid (ID-Badge / AI-Prompt feature) ──────────────────────────
// Resolve a note by its stable frontmatter ULID. Used by:
//   - server route GET /api/notes/by-id/:ulid
//   - MCP tool resolve_by_id
//   - any AI client receiving an "AI prompt copy" from the editor
// Cache is in-process (60s TTL); notesService writes invalidate it.
export {
  findByUlid,
  invalidateUlidCache,
  isUlid,
  type ResolvedNote,
} from "./notes/findByUlid.js";

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
  // Story S2 — Karpathy-Profil-Typen + Vault-SPEC-Profil-Registry (B1).
  KARPATHY_DOC_TYPES,
  VAULT_PROFILES,
  DEFAULT_VAULT_PROFILE,
  KARPATHY_TYPE_FOLDER,
  isVaultProfile,
  getProfileSpec,
  resolveVaultProfile,
  PEER_TYPES,
  isPeerType,
  // Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
  isForgotten,
  type DocType,
  type KarpathyDocType,
  type AnyDocType,
  type VaultProfile,
  type VaultProfileSpec,
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
  // Phase C Wave C2 / Story 3 — Honcho peer abstraction.
  type PeerType,
  type PeerFrontmatter,
} from "./frontmatter/index.js";

export { FrontmatterValidationError } from "./errors/FrontmatterValidationError.js";

// ─── Git-sync typed errors (Story 10.6) ─────────────────────────────────
// Classify git stderr instead of collapsing every pull rejection into a
// blanket "Merge-Konflikt". Route maps each to a distinct HTTP status.
export {
  GitSyncError,
  PreCommitHookError,
  MergeConflictError,
  GitBackendError,
  classifyGitError,
} from "./errors/GitError.js";

// `validateGitBranch` + its error are part of the config surface (AC#1):
// callers (server config, admin hot-swap) trim/validate the branch token.
export {
  validateGitBranch,
  GitBranchValidationError,
} from "./util/coreConfig.js";

// ─── Skill parser + token-renderer (Epic 9 / Story 9-2) ─────────────────
// Parses `type: skill` notes into typed SkillDefs and renders their prompt
// with `{{token}}` substitution. The MCP layer (9-3) consumes this surface;
// pure functions + vault file-read only (no network / LLM).
export {
  parseSkill,
  renderPrompt,
  listSkillNotes,
  validateSkillInput,
  // Story 10.5 — official skill schema + example + per-field docs, served by
  // the MCP get_skill_schema tool so a skill can be authored in one call.
  getSkillSchema,
  type SkillDef,
  type SkillExecution,
  type SkillOutput,
  type SkillSchemaInfo,
  type SkillFieldDoc,
} from "./skills/index.js";

// ─── Skill import (Epic 12 / Story 12.3) ────────────────────────────────
// Shared logic for the PWA upload route AND the MCP import tool: imports an
// Anthropic-format folder-skill (SKILL.md + references/ + templates/) into
// the vault, injecting SPEC-valid frontmatter for `.md` files and writing
// non-`.md` templates verbatim — all through gitService.save().
export {
  importSkill,
  slugifySkillName,
  type ImportSkillArgs,
  type ImportSkillFile,
  type ImportSkillResult,
} from "./skills/import.js";

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

// ─── Voice-capture defaults (folder / title pattern / language / mode) ──
// Persisted under `system_config[voice_defaults]` as a JSON value. Read by
// the voice pipe handler whenever the per-job payload doesn't carry an
// override. See packages/core/src/setup/voiceDefaults.ts.
export {
  DEFAULT_VOICE_DEFAULTS,
  VAULT_ROOTS,
  VOICE_DEFAULTS_KEY,
  VOICE_MODES,
  VoiceDefaultsValidationError,
  getVoiceDefaults,
  getVoiceDefaultsWithMeta,
  updateVoiceDefaults,
  validateVoiceDefaultsPatch,
  type VoiceDefaults,
  type VoiceDefaultsWithMeta,
  type VoiceMode,
} from "./setup/voiceDefaults.js";

// ─── Global display-timezone ───────────────────────────────────────────
// IANA tz string persisted under `system_config[timezone]`. Default `UTC`.
// Container clock + all storage stay UTC; only user-facing rendering
// (voice-note titles, daily-notes, future scheduling) uses this value.
export {
  DEFAULT_TIMEZONE,
  TIMEZONE_KEY,
  TimezoneValidationError,
  getDateParts,
  getTimezone,
  setTimezone,
  validateTimezone,
  type DateParts,
} from "./setup/timezone.js";

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
  // Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
  queueForgottenToggle,
  // Story 10.1 quarantine API — consumed by get_health (Story 10.8). The
  // health module reads these via the deep path; this barrel re-export is
  // what the MCP layer + future callers import from `@lokyy/core`.
  getQuarantinedNotes,
  clearQuarantine,
  // Gate-0 recovery — bulk un-quarantine after the array-binding fix ships.
  clearAllQuarantine,
  getBreakerStateSize,
  type QuarantinedNote,
} from "./memory/index.js";

// ─── Backend health snapshot (Story 10.8) ───────────────────────────────
// Cheap, synchronous health view (sync state, pool max, vault id, quarantined
// notes, breaker entries). Served by the MCP get_health tool for self-diagnosis.
export {
  getHealth,
  type HealthSnapshot,
  type HealthContext,
  type SyncState,
} from "./health/index.js";

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

// ─── ULID-Backfill (Phase D Wave D1 / Story 1) ──────────────────────────
// NREM-phase sleep pass that picks up to 50 legacy notes without a `id:`
// frontmatter field per run, injects a ULID + inferred type + updated
// timestamp, and saves via gitService. Exported so server routes + future
// MCP tools can address it by name; the pass is also auto-registered in
// `ALL_PASSES` so the normal sleep-agent schedule runs it on its own.
export { ulidBackfillPass } from "./sleep-agent/passes/ulidBackfill.js";

// ─── Mem0 Review Queue (Phase C Wave C1 / Story 1) ──────────────────────
// REM-sleep classifier surfaces ADD/UPDATE/DELETE/NOOP candidates into
// `mem0_review_queue`; the user accepts/rejects via `/api/mem0/review/*`.
// The schema export above (`db/schema/index.js`) already re-exports the
// Drizzle table; we re-pin the operation/status helpers here so the server
// route imports stay short.
export {
  MEM0_OPERATIONS,
  MEM0_REVIEW_STATUSES,
  isMem0Operation,
  isMem0ReviewStatus,
  type Mem0Operation,
  type Mem0ReviewStatus,
  type Mem0ReviewQueueRow,
  type NewMem0ReviewQueueRow,
} from "./db/schema/mem0ReviewQueue.js";

// ─── Entity-Extraction (Phase C Wave C2 / Story 2) ──────────────────────
// The `entity-extraction` REM sleep-pass walks recent / unprocessed notes,
// asks the `ner`-role LLM (lokal-bevorzugt) for named entities, and writes
// canonical-deduped rows into `entities` + `entity_mentions`. Routes under
// `/api/entities/*` read the store; the schema re-export above already
// covers the Drizzle tables.
export {
  normalizeName,
  upsertEntity,
  listEntities,
  getEntity,
  entitiesInNote,
  notesForEntity,
  entityCoOccurrence,
  ENTITY_TYPES,
  isEntityType,
  type Entity,
  type EntityType,
  type ExtractedEntity,
  type ListEntitiesOpts,
  type CoOccurrenceHit,
} from "./entities/index.js";

// ─── Karpathy-Lint Findings (Phase C Wave C1 / Story 3) ─────────────────
// The `karpathy-lint` sleep-pass (phase=`lint`) writes findings to
// `lint_findings`; `/api/lint/*` is read + status-transition only. Schema
// re-export already covers the Drizzle table; the helpers below are the
// short-form imports the server route + future MCP tools use.
export {
  LINT_KINDS,
  LINT_SEVERITIES,
  LINT_STATUSES,
  isLintKind,
  isLintStatus,
  type LintKind,
  type LintSeverity,
  type LintStatus,
  type LintFindingRow,
  type NewLintFindingRow,
} from "./db/schema/lintFindings.js";

// ─── Honcho-Peer-Abstraction (Phase C Wave C2 / Story 3) ────────────────
// Peer-notes are an evolving profile of any person/org/agent the user
// interacts with. The DB sidecar `peer_profiles` is an index; the note
// frontmatter is the source of truth. The `peer-profile-update` REM sleep-
// pass aggregates entity_mentions → relationship_strength + topics +
// last_interaction and writes back both sidecar and frontmatter.
export {
  listPeers,
  getPeer,
  recomputePeerProfile,
  suggestPeerCandidates,
  createPeerFromEntity,
  computeRelationshipStrength,
  type Peer,
  type PeerSuggestion,
} from "./peers/index.js";

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

// ─── At-rest secret encryption ──────────────────────────────────────────
// AES-256-GCM helpers used by Forgejo OAuth (and future secret-bearing
// columns). Pass-through when LOKYY_DATA_KEY is unset; warns once at
// startup. See packages/core/src/crypto/secrets.ts.
export {
  encrypt,
  decrypt,
  isEncryptionConfigured,
} from "./crypto/secrets.js";

// ─── Forgejo OAuth — refresh + decrypt helpers ──────────────────────────
// Wraps the encrypted `forgejo_oauth_tokens` table with two responsibilities:
// 1) hand callers a plaintext access_token, 2) silently exchange the stored
// refresh_token when the access_token is within 60s of expiry. Callers that
// used to read `findToken(userId).accessToken` switch to these helpers and
// stop worrying about the JWT lifetime. See packages/core/src/forgejo/refresh.ts.
export {
  loadToken,
  loadAllTokensForUser,
  getValidForgejoToken,
  refreshAndStore,
  upsertForgejoToken,
  type DecryptedToken,
  type ForgejoOauthConfig,
} from "./forgejo/refresh.js";

// ─── Sidebar menu config (Epic 11 / Story 11.1) ─────────────────────────
// Lokyy-Workspace sidebar menu = (folder) + (view type). System-Items are
// code constants (SYSTEM_ITEMS, always merged first, never persisted); custom
// items live in `00_meta/sidebar-menu.yaml` and are read/written exclusively
// via gitService (Forgejo-first). Consumed by the flat server route
// `server/src/routes/workspace.ts` (GET/PUT /api/workspace/menu).
export {
  read as readMenuConfig,
  write as writeMenuConfig,
  SYSTEM_ITEMS,
  MENU_FILE as MENU_CONFIG_FILE,
  type ViewType,
  type MenuItem,
  type MenuConfig,
} from "./workspace/menuConfig.js";

// ─── Loose-ends scan (Epic 11 / Story 11.11) ────────────────────────────
// Vault-wide body scan for open Markdown checkboxes (`- [ ]`) AND inline
// `#todo` tags (O-4: both). Read-only, limit + 60s memo. Consumed by the
// GET /api/dashboard/loose-ends route.
export {
  looseEnds,
  type LooseEnd,
  type LooseEndsResult,
} from "./workspace/looseEnds.js";
