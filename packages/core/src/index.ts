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
  type ValidationErrorDetail,
  type ValidationResult,
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
} from "./memory/index.js";
