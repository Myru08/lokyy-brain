import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  initCore,
  initDb,
  ensureRepo,
  findByUlid,
  getNote,
  getTree,
  createNote,
  isUlid,
  saveNote,
  getMemoryProvider,
  listSkillNotes,
  validateSkillInput,
  renderPrompt,
  // Story 12.3 — import_skill: import an Anthropic-format folder-skill
  // (SKILL.md + references/ + templates/) into the vault, injecting SPEC-valid
  // frontmatter for the .md files via the shared core `importSkill`.
  importSkill,
  type ImportSkillFile,
  DOC_TYPES,
  derivePathForType,
  folderForType,
  TypeFolderMismatchError,
  // Story 13.1 — managed-create intent resolver lives in @lokyy/core so the
  // MCP `notes.create_managed` tool and the HTTP POST /api/notes/create-managed
  // route share DIESELBE Quelle (ISC-59 — no parallel write/path logic).
  resolveManagedCreate,
  // Story 10.3 — delete_note (soft via trashEntry, hard via deleteEntry).
  trashEntry,
  deleteEntry,
  // Story 10.4 — get_vault_conventions.
  getVaultConventions,
  // Story 10.5 — get_skill_schema.
  getSkillSchema,
  // Story 10.8 — get_health.
  getHealth,
  // Story 10.9 — move_note / rename_note.
  moveEntry,
  backlinks,
  // Story 10.10 — create_notes / update_notes (bulk).
  createNotes,
  updateNotes,
  // Story 10.11 — list_notes (frontmatter filter via dataview).
  queryNotes,
  // Story 10.14 — create_folder.
  createFolder,
  // Story 10.16 — graph tools: get_backlinks, find_broken_links, get_tags.
  // (backlinks is already imported above for the move_note warning.)
  findBrokenLinks,
  listTags,
  // Story 10.17 — history/diff/validate tools.
  noteHistory,
  noteDiff,
  validateFrontmatter,
  parseFrontmatter,
  // Story 13.1 — OS-MCP-contract (Epic 13): graph.get + pipes.* thin wrappers
  // over the SAME core entry points the HTTP routes use (/api/graph,
  // /api/pipes/import, GET /api/pipes).
  buildGraph,
  enqueue,
  listJobs,
  type CoreConfig,
  type DocType,
  type BulkCreateItem,
  type BulkUpdateItem,
  type DataviewQuery,
  type DataviewRow,
  type FrontmatterMap,
  type ValidationErrorDetail,
} from "@lokyy/core";
import type { PipeType, SharePayload } from "@lokyy/shared";
import { canRead, canWrite, activeScope, loadScopes, ScopeViolation } from "./scopes.js";
// Story 10.13 — multi-vault detection API (consumed by get_health.vault_warning).
import { resolveVaultResolution } from "./resolveVaultId.js";

/**
 * Lokyy-Brain Usage Conventions — auto-injected as system-prompt addendum
 * via MCP `initialize.serverInfo.instructions`. Compatible clients (Claude
 * Code, Claude Desktop, claude.ai Custom Connectors) pick this up on
 * connect — the user only needs to add the MCP server; the AI then knows
 * HOW to use it automatically.
 *
 * Keep this short. Long instructions waste tokens on every conversation
 * turn. Six trigger patterns, each one-line.
 */
const LOKYY_BRAIN_INSTRUCTIONS = `You have access to Lokyy-Brain — the user's personal knowledge vault (git-backed, SPEC-compliant Markdown notes). Use it actively:

1. BEFORE answering questions about the user's projects, decisions, workflows, or past work: call \`search_vault\` first. Never speculate from memory if the vault might know.
2. AFTER substantial conversations with new insights: call \`create_note\` to persist. Choose type carefully:
   - note → 20_notes/ (general insights)
   - capture → 30_captures/ (external sources, snippets, quotes)
   - decision → 50_decisions/ (trade-offs, ADRs)
   - intervention → 70_pai/interventions/ (proactive suggestions for the user)
   Path pattern: \`{folder}/{YYYY-MM-DD}-{slug}\` for chronological sort.
3. ON "save this" / "remember" / "capture": immediately \`create_note\` type=capture in 30_captures/. Don't ask, just do.
4. ON "what do we know about X" / "have we covered Y": \`search_vault\` first, then answer citing noteIds.
5. ON "summarize this session" / "write it all down": \`create_note\` type=note in 70_pai/sessions/{YYYY-MM-DD}-{slug} with structured Markdown (TL;DR / Decisions / Next Steps / Related notes via [[wikilink]]).
6. While editing a note, if you notice a conceptual link to another existing note, insert \`[[Other Note Title]]\` via \`update_note\` — this builds the knowledge graph organically.

Search uses Tier 1 (full-text + tags + wikilinks) and Tier 2 (semantic embeddings, when Ollama is up). Multi-token queries are supported. Empty folders appear with "(empty)" marker — they exist for the SPEC structure even before notes land there.

Permission model: your scope is defined in the vault's \`00_meta/mcp-scopes.yaml\` under your agent-id. Scope violations return a structured error — treat them as hard limits, don't retry around them.

Skills are reusable workflows the user has defined in the vault. To use one: call \`list_skills\` to see which skills are available, then call \`run_skill\` with the chosen skill — it returns a filled-in prompt. You then execute that returned prompt yourself, using the tools listed here (client-side execution). \`run_skill\` only renders the prompt; it does not run an LLM or write any note on your behalf.`;

/**
 * lokyy-brain MCP server (Story 7.1–7.7).
 *
 * Tools exposed:
 *   - read_note       (Story 7.3)  — read a scoped note
 *   - search_vault    (Story 7.4)  — Tier 1+2 search via @lokyy/core memory
 *   - list_tree       (Story 7.6)  — scoped file tree
 *   - create_note     (Story 7.7)  — create with SPEC-valid frontmatter
 *   - update_note     (Story 7.7)  — save with id/created preservation
 *
 * Pipe handlers (trigger_import — Story 7.8) and related_notes
 * (Story 7.5) are deferred.
 */

/**
 * Module-level vault-id captured by `initServerDeps`. The CallTool handlers
 * close over this so `createServer()` can mint a fresh `Server` per session
 * without threading the id through every call. Set exactly once by
 * `initServerDeps`; read by the handlers built in `createServer`.
 */
let activeVaultId = "";

/**
 * Module-level vault working-copy dir captured by `initServerDeps`. The skills
 * handlers (`list_skills`/`run_skill`) read it; captured here so `createServer()`
 * can close over it the same way it does `activeVaultId`.
 */
let activeVaultDir = "";

/**
 * Module-level vault-resolution warning captured by `initServerDeps`. Computed
 * ONCE at boot (one detection call, kept off the per-request path so get_health
 * stays cheap — AC#5/10.8-AC#6). `createServer()` reads this synchronously so
 * the get_health handler can surface it as `vault_warning`. Stays `null` when
 * there is no ambiguity, or when the best-effort detection call throws.
 */
let activeVaultWarning: string | null = null;

/**
 * One-time global initialization. Wires core (gitService + DB + memory),
 * ensures the repo, loads scopes, and captures the vault-id for the handlers.
 * Run this ONCE per process before constructing any Server instance.
 *
 * The HTTP path needs a separate `Server` per session (the MCP SDK forbids
 * one Server/Protocol instance from connecting to multiple transports), so
 * the heavy one-time init is deliberately separated from Server construction.
 */
export async function initServerDeps(
  coreConfig: CoreConfig,
  databaseUrl: string,
  vaultId: string,
  agentId: string,
): Promise<void> {
  initCore(coreConfig);
  initDb(databaseUrl);
  await ensureRepo();
  await loadScopes(coreConfig.vaultDir, agentId);
  activeVaultId = vaultId;
  activeVaultDir = coreConfig.vaultDir;

  // Story 10.13/10.8 — multi-vault detection for get_health.vault_warning.
  // Computed ONCE at boot (one detection call, kept off the per-request path so
  // get_health stays cheap — AC#5/10.8-AC#6). Guarded: if the detection call
  // throws (DB down at boot, etc.) we degrade to "no warning" so get_health and
  // the rest of the server still come up rather than failing the whole boot.
  try {
    const resolution = await resolveVaultResolution(databaseUrl);
    if (resolution.ambiguous) {
      const list = resolution.candidates.map((c) => `${c.id} (${c.slug})`).join(", ");
      activeVaultWarning =
        `Multiple vault rows detected and no LOKYY_VAULT_ID pinned — using "${vaultId}". ` +
        `Candidates: ${list}. Set LOKYY_VAULT_ID to pin one and silence this warning.`;
    }
  } catch (err) {
    // Detection is best-effort; never block server boot on it.
    console.error(
      "[lokyy-mcp] vault-resolution detection failed (get_health.vault_warning disabled):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Build a FRESH `Server` with all request handlers. Safe to call multiple
 * times (once per session for the HTTP transport). Requires `initServerDeps`
 * to have run first — the handlers read module-level core/scope/vault state.
 */
export function createServer(): Server {
  const vaultId = activeVaultId;

  // Story 10.13/10.8 — multi-vault detection for get_health.vault_warning.
  // Resolved ONCE at boot inside `initServerDeps` (async path) and cached in the
  // module-level `activeVaultWarning`; read synchronously here so each per-session
  // `Server` surfaces the same warning without re-running detection.
  const vaultWarning = activeVaultWarning;

  const server = new Server(
    { name: "lokyy-brain", version: "0.0.1" },
    {
      capabilities: { tools: {} },
      // MCP 2025-06-18: instructions are auto-injected by compatible clients
      // (Claude Code, Claude Desktop, claude.ai) as system-prompt addendum.
      // This is how Lokyy-Brain teaches the AI to use itself without the
      // user editing any local prompt files.
      instructions: LOKYY_BRAIN_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read_note",
        description:
          "Read a single Lokyy-Brain note (markdown body + frontmatter). CALL THIS whenever the user references a specific note, project, decision, or past insight — never paraphrase from memory if you can read the source. Path is the note id without .md extension (e.g. '70_pai/sessions/2026-05-24-claude-marathon').",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Note id, e.g. 'pai/hermes'" } },
          required: ["path"],
        },
      },
      {
        name: "resolve_by_id",
        description:
          "Resolve a Lokyy-Brain note by its stable 26-character ULID (the value of `id:` in the note's frontmatter). Use this when the user pastes an 'AI prompt' block copied from the editor — the block carries the ULID, which survives renames/moves whereas the path does not. Returns the full markdown (with frontmatter), the current path, the title, and the parsed frontmatter map. If the ULID is malformed or no note matches, returns an `error` field.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "ULID — 26 chars, Crockford base32 (no I/L/O/U). Example: '01KSFC0T2J8XG91RV6Z6D825X9'.",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "search_vault",
        description:
          "Search Lokyy-Brain (Tier 1 full-text + Tier 2 semantic embeddings, merged). CALL FIRST whenever the user asks 'what do we know about X', 'have we covered Y', 'where did we discuss Z', or before stating anything about the user's projects/workflows/history. Multi-token queries are scored per-word with title-bonus — use 1–4 keyword tokens for best results. Returns scored hits with snippets and noteIds.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", default: 10 },
          },
          required: ["query"],
        },
      },
      {
        name: "list_tree",
        description:
          "List the Lokyy-Brain folder/note tree, filtered to your readable scope. Empty folders surface with '(empty)' marker so you can see the canonical SPEC structure (10_projects, 20_notes, 30_captures, …) even before notes land there.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "create_note",
        description:
          "Create a new Lokyy-Brain note with SPEC-valid frontmatter (ULID, type, title, created, updated auto-filled). CALL THIS proactively whenever the user says 'save this', 'remember this', 'capture this' — don't ask, just do it. Also call after substantial conversations where insights worth preserving emerged. Choose `type` deliberately — the canonical folder is derived from it. EASIEST: pass `type` + `slug` and the server derives the path (dated '{folder}/{YYYY-MM-DD}-{slug}' for captures/tasks, plain '{folder}/{slug}' otherwise). If you pass an explicit `path` it must sit under the type's canonical folder (sub-folders like '30_captures/youtube/' are fine) or you get a type-folder-mismatch error. Either `path` or `slug` is required.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Full note id under the type's canonical folder, e.g. '30_captures/youtube/foo'. Optional — omit it and pass `slug` to let the server derive the path from `type`.",
            },
            slug: {
              type: "string",
              description:
                "Short kebab-case name. With `type`, the server derives the canonical path (preferred over a hand-built `path`).",
            },
            body: { type: "string", description: "Markdown body (optional)" },
            title: { type: "string" },
            type: {
              type: "string",
              // Single source of truth — enum mirrors DOC_TYPES from @lokyy/core
              // (incl. `skill`, `peer`) so the tool surface never drifts.
              enum: [...DOC_TYPES],
              default: "note",
            },
            frontmatter: {
              type: "object",
              description:
                "Extra frontmatter fields merged into the note (e.g. for type=skill supply `skill_name` + `description`; for type=peer supply `peer_type`). Lets a fully-valid typed note be created in ONE call.",
            },
          },
        },
      },
      {
        name: "update_note",
        description:
          "Save/upsert a Lokyy-Brain note. Preserves on-disk id + created (immutable), bumps updated. Caller's frontmatter merges in for everything else. CALL THIS to add wikilinks ('[[Other Note]]') when you spot conceptual connections — this organically builds the knowledge graph. Also for appending to existing notes (full body replace; you must include the existing content + your addition).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            body: { type: "string" },
          },
          required: ["path", "body"],
        },
      },
      {
        name: "list_skills",
        description:
          "List the Lokyy-Brain vault skills you can invoke — reusable prompt templates (`type: skill` notes) the user has defined. CALL THIS to discover what skills exist before running one. Each summary carries skill_name, title, description, the input_schema (what params it takes), execution target, and the advisory allowed_tools list. Only skills whose note is within your read-scope are returned.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "run_skill",
        description:
          "Run a Lokyy-Brain vault skill: validates your `input` against the skill's input_schema (applying defaults), renders the skill's prompt template with your values, and returns the filled prompt for YOU to execute with your own tool calls. This does NOT call an LLM and does NOT write any note — it only returns the execution payload. allowed_tools is advisory (which vault tools the skill expects you to use). Error forms: skill-not-found (unknown skill_name), invalid-input (with per-field errors), server-execution-not-supported (skills with execution: server are not runnable in Phase 1).",
        inputSchema: {
          type: "object",
          properties: {
            skill_name: {
              type: "string",
              description: "The skill's stable name (lowercase, e.g. 'wochenrueckblick').",
            },
            input: {
              type: "object",
              description: "Parameter values for the skill's input_schema. Defaults apply for omitted keys.",
            },
          },
          required: ["skill_name"],
        },
      },
      {
        name: "import_skill",
        description:
          "Import an Anthropic-format FOLDER-skill into Lokyy-Brain in ONE call: a `SKILL.md` manifest plus optional `references/*.md` and `templates/*` files. The server SLUGIFIES `skill_name` into the directory under `70_pai/skills/{slug}/` and INJECTS SPEC-valid frontmatter where it is missing — `SKILL.md` becomes a valid `type: skill` note, each `references/*.md` becomes a `type: reference` note, and non-`.md` templates are written verbatim (byte-for-byte). Source files ship WITHOUT vault frontmatter (that is the whole point — Anthropic skills don't carry it). Re-importing the same skill is an idempotent upsert (on-disk id/created preserved). Use this instead of N create_note calls when bringing in a packaged skill. A `SKILL.md` at the root is REQUIRED. The skill's write-scope is enforced per file (same gate as create_note). Returns { imported: { skillName (the slug), written: [vault paths], skipped: [] }, commitPrefix }. Structured errors: { error: 'no-skill-manifest' } when no SKILL.md is present, { error: 'no-files' } when `files` is empty, { error: 'invalid-files' } when a file entry is malformed, plus the usual scope_violation errors.",
        inputSchema: {
          type: "object",
          properties: {
            skill_name: {
              type: "string",
              description:
                "Free-form skill name; the server slugifies it to a lowercase-kebab directory name (e.g. 'Dashboard Builder' → 'dashboard-builder').",
            },
            files: {
              type: "array",
              description:
                "The skill's files, paths relative to the skill ROOT. MUST include a `SKILL.md`.",
              items: {
                type: "object",
                properties: {
                  rel_path: {
                    type: "string",
                    description:
                      "POSIX path relative to the skill root, e.g. 'SKILL.md', 'references/layout.md', 'templates/dashboard.jsx'.",
                  },
                  content: {
                    type: "string",
                    description: "UTF-8 file content (markdown body, JSX/JSON source, …).",
                  },
                },
                required: ["rel_path", "content"],
              },
            },
          },
          required: ["skill_name", "files"],
        },
      },
      {
        name: "delete_note",
        description:
          "Delete a Lokyy-Brain note. Default (`hard` omitted/false) is a SAFE soft-delete: the note is MOVED to '99_archive/_trash/{YYYY-MM-DD}-{slug}' (recoverable) — use this to clean up mis-filed notes you created without asking the user to touch the filesystem. Pass `hard: true` only for a permanent removal (drops the note + its search-index row). `path` is the note id without .md. Returns { deleted: {...}, mode: 'soft'|'hard' }; an unknown note returns { error: 'not-found', path }.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Note id (path without .md), e.g. '20_notes/draft'.",
            },
            hard: {
              type: "boolean",
              description:
                "false/omitted = soft-delete (move to trash, recoverable); true = permanent delete.",
              default: false,
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_vault_conventions",
        description:
          "Get the Lokyy-Brain vault conventions — machine-readable folders (with purpose + path-pattern), the closed doc-type list (each type's meaning + canonical folder), the frontmatter contract (required fields), and the wikilink/tag/ULID rules. CALL THIS FIRST when you start working with the vault so you place notes in the right folder with the right type instead of guessing (mis-placement is the #1 mistake). Takes no arguments.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_skill_schema",
        description:
          "Get the official skill frontmatter schema, a complete working example skill (frontmatter + body), and per-field docs. CALL THIS before authoring a vault skill so you get it right in ONE call: pass the example shape to create_note({ type: 'skill', ... }) — no create-then-fix loop. Note: a skill's `input_schema` keys become {{var}} tokens that run_skill substitutes (via renderPrompt) when the skill is invoked. Takes no arguments.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_health",
        description:
          "Get the Lokyy-Brain backend health snapshot — git/Forgejo sync_state, last successful index time, pending writes, DB pool used/max, the active vault_id, quarantined notes (the circuit-breaker parked them after repeated index failures), and breaker_entries. CALL THIS to self-diagnose when writes/searches behave oddly, before assuming a tool is broken. Cheap and synchronous (no heavy DB queries); fields the backend cannot cheaply observe are reported as null/'unknown' rather than guessed. `vault_warning` is set (non-null) only when the server booted against an ambiguous multi-vault DB without LOKYY_VAULT_ID pinned. Takes no arguments.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "move_note",
        description:
          "Move a Lokyy-Brain note to a new path (re-file it into another folder). The note's stable ULID is preserved (only the path changes), so wikilinks-by-id and resolve_by_id keep working. Use this to re-organize instead of create-new-and-delete-old. `from`/`to` are note ids WITHOUT the .md extension. Returns { moved: { from, to } }; a missing source returns { error: 'not-found', path }. NOTE: existing path-based [[wikilinks]] pointing at the OLD path are NOT rewritten — if any backlinks are detected they come back in a `warning` field for you to fix manually.",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "Current note id (path without .md), e.g. '20_notes/draft'." },
            to: { type: "string", description: "Destination note id (path without .md), e.g. '50_decisions/draft'." },
          },
          required: ["from", "to"],
        },
      },
      {
        name: "rename_note",
        description:
          "Rename a Lokyy-Brain note in place (same parent folder, new slug) — a move that keeps the directory. The ULID is preserved. `path` is the current note id (without .md); `new_slug` is the new last path segment (no slashes, no .md). Returns { moved: { from, to } }; missing source → { error: 'not-found', path }. Like move_note, path-based backlinks are not rewritten and surface in `warning`.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Current note id (path without .md), e.g. '20_notes/old-name'." },
            new_slug: {
              type: "string",
              description: "New final segment (kebab-case, no '/' and no '.md'), e.g. 'new-name'.",
            },
          },
          required: ["path", "new_slug"],
        },
      },
      {
        name: "create_notes",
        description:
          "Create MANY Lokyy-Brain notes in one atomic call — use this instead of N separate create_note calls when scaffolding a project (avoids N× latency and partial states). All items are validated up front; if ANY item is invalid, NOTHING is written and you get back the offending item + reason. Each item: { id (path without .md), body?, type?, title? }. Per-item write-scope is enforced. Returns the bulk result: { ok:true, notes:[...] } on success, or { ok:false, error:{ id, reason, message }, committed:[...] } where `committed` honestly lists any ids written before a mid-batch git failure.",
        inputSchema: {
          type: "object",
          properties: {
            notes: {
              type: "array",
              description: "Notes to create.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Note id (path without .md), e.g. '10_projects/foo/overview'." },
                  body: { type: "string", description: "Markdown body (optional)." },
                  title: { type: "string" },
                  type: { type: "string", enum: [...DOC_TYPES], default: "note" },
                },
                required: ["id"],
              },
            },
          },
          required: ["notes"],
        },
      },
      {
        name: "update_notes",
        description:
          "Update (full-body replace) MANY existing Lokyy-Brain notes in one atomic call. All targets are validated up front; if any target is missing/invalid, NOTHING is written and you get the offending item + reason. Each item: { id (path without .md), body }. Each note's on-disk id + created are preserved and updated is bumped (same rules as update_note). Per-item write-scope is enforced. Returns the same bulk-result shape as create_notes.",
        inputSchema: {
          type: "object",
          properties: {
            updates: {
              type: "array",
              description: "Notes to update.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "Existing note id (path without .md)." },
                  body: { type: "string", description: "New markdown body (full replace)." },
                },
                required: ["id", "body"],
              },
            },
          },
          required: ["updates"],
        },
      },
      {
        name: "list_notes",
        description:
          "List Lokyy-Brain notes matching a frontmatter filter — use this to get 'all notes with type:X and status:Y' in ONE call instead of reading each note. Filter keys (all optional, ANDed): `type`, `folder` (path prefix), `tag` (frontmatter or inline #tag), `status` (frontmatter equality), `updated_after` (ISO date/datetime; keeps notes whose `updated` is strictly greater). Pagination via `limit` (default 50) + `offset` (default 0). Out-of-scope notes are dropped (same read-scope as list_tree/search_vault). Returns { notes:[{ noteId, title, type, ...projected frontmatter }], total, hasMore, limit, offset }.",
        inputSchema: {
          type: "object",
          properties: {
            filter: {
              type: "object",
              properties: {
                type: { type: "string", description: "Doc type equality, e.g. 'decision'." },
                folder: { type: "string", description: "Folder path prefix, e.g. '50_decisions'." },
                tag: { type: "string", description: "A tag the note must carry (frontmatter `tags` or inline #tag)." },
                status: { type: "string", description: "Frontmatter `status` equality, e.g. 'open'." },
                updated_after: {
                  type: "string",
                  description: "ISO date/datetime; keep notes whose `updated` is strictly after this.",
                },
              },
            },
            limit: { type: "number", description: "Page size (default 50).", default: 50 },
            offset: { type: "number", description: "Rows to skip (default 0).", default: 0 },
          },
        },
      },
      {
        name: "create_folder",
        description:
          "Create a folder in the Lokyy-Brain vault explicitly (drops a .gitkeep so git tracks the empty dir) — instead of waiting for the first note to materialize it. Pass `with_readme: true` to also drop a README note (type:note) inside so the folder has a landing page. `path` is the folder path (no trailing slash). Write-scope is enforced. Returns { created: path } (and { readme } when a README was created); scope errors are structured.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Folder path, e.g. '10_projects/new-project'." },
            with_readme: {
              type: "boolean",
              description: "Also create a README note (type:note) in the folder. Default false.",
              default: false,
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_backlinks",
        description:
          "List the Lokyy-Brain notes that link TO a given note — 'who links here', each with a short surrounding-text context snippet. Use this to understand a note's incoming graph before editing or refactoring it. Wikilink resolution rule (same as the graph): a `[[target]]` counts as a backlink when `target` resolves to this note by TITLE → ALIAS → BASENAME → full id (case-insensitive for the first three, exact for the id). `path` is the note id WITHOUT the .md extension. Only source notes within YOUR read-scope are returned (out-of-scope linkers are dropped). Returns { backlinks: [{ noteId, title, context }] }.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Target note id (path without .md), e.g. '20_notes/topic'.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "find_broken_links",
        description:
          "Vault health check: scan EVERY note for wikilinks (`[[ ]]`) whose target resolves to NOTHING. A link is broken when it matches no note by TITLE → ALIAS → BASENAME → id (the same resolution the graph uses); links that resolve any of those four ways are never reported. Only Markdown wikilinks are checked (`.md` links are out of scope). CALL THIS to audit vault integrity before/after a big re-org. Source notes outside YOUR read-scope are dropped from the report. Takes no arguments. Returns { broken_links: [{ sourceId, sourceTitle, linkText }] }.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_tags",
        description:
          "List EVERY tag in the Lokyy-Brain vault with its usage count — both frontmatter `tags: [...]` and inline `#tag`, aggregated and sorted by count (desc). Use this to discover the vault's tag vocabulary before tagging a new note (reuse an existing tag instead of inventing a near-duplicate) or to find the notes behind a tag. Takes no arguments. Returns { tags: [{ tag, count, noteIds }] }.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_history",
        description:
          "READ-ONLY version history of a single Lokyy-Brain note (git commits that touched it), newest first. Use this to see when/why a note changed before editing, or to find the SHA to feed into get_note_diff. `path` is the note id WITHOUT .md. `limit` caps the number of commits (default 50). An empty array means the note is untracked / never committed — not an error. Read-scope is enforced on `path`. Returns { history: [{ sha, date, message }] }.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Note id (path without .md), e.g. '20_notes/topic'.",
            },
            limit: {
              type: "number",
              description: "Max commits to return (default 50, newest first).",
              default: 50,
            },
          },
          required: ["path"],
        },
      },
      {
        name: "get_note_diff",
        description:
          "READ-ONLY unified diff for a single Lokyy-Brain note. With `sha`: shows that commit's patch for the note (pair this with get_history to inspect a past change). Without `sha`: shows the UNCOMMITTED working-tree diff for the note (sha: null). Never mutates the working tree. `path` is the note id WITHOUT .md. A bad/unknown sha surfaces as a descriptive error. Read-scope is enforced on `path`. Returns { sha, diff } (diff may be an empty string when there is nothing to show).",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Note id (path without .md), e.g. '20_notes/topic'.",
            },
            sha: {
              type: "string",
              description: "Commit SHA to diff against. Omit for the uncommitted working-tree diff.",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "validate_note",
        description:
          "Validate a Lokyy-Brain note's frontmatter against its doc-type JSON schema WITHOUT writing anything — use this to pre-flight a note before create_note/update_note so you fix frontmatter issues in advance instead of hitting a pre-commit-hook rejection. Provide EITHER `path` (an existing note id without .md — the server reads it) OR `body` (a raw markdown string with a `---` frontmatter block — the server parses it). The `type` is taken from the note's own frontmatter; if it is missing/unknown you get a structured validation error listing the allowed types. Read-scope is enforced when `path` is given. Returns { valid: boolean, errors: [{ instancePath, keyword, message, params }] }.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Existing note id (path without .md) to read + validate.",
            },
            body: {
              type: "string",
              description: "Raw markdown (with a `---` frontmatter block) to validate directly.",
            },
          },
        },
      },

      /* ============================================================== *
       *  Story 13.1 (Epic 13) — OS-MCP-Contract: dotted Contract-Tools.
       *
       *  ADDITIVE. The 25 snake_case tools above are UNCHANGED. These
       *  dotted tools are the stable surface ADR-004 freezes for the
       *  Lokyy-OS / Hermes subagents. They split into two kinds:
       *
       *    1. New tools with no snake_case equivalent
       *       (notes.create_managed, graph.get, pipes.import, pipes.status).
       *    2. Dotted ALIASES — identical args + behavior, registered under
       *       a second name and dispatched through the SAME handler via the
       *       `DOTTED_ALIASES` table (notes.read→read_note,
       *       notes.list_by_type→list_notes, notes.search→search_vault,
       *       notes.update_content→update_note, vault.tree→list_tree).
       * ============================================================== */
      {
        name: "notes.create_managed",
        description:
          "THE sanctioned write path for new notes (OS-contract, ADR-004). Pass an INTENT — { title, body, type, tags?, folder_hint? } — and Lokyy-Brain owns everything else: it DERIVES the target path from `type` (canonical type→folder map; dated '{folder}/{YYYY-MM-DD}-{slug}' for captures/tasks, slug from title), generates the ULID, sets created/updated, assembles SPEC-valid frontmatter, and writes via the git path. The client NEVER supplies a path or frontmatter. `folder_hint` is an OPTIONAL hint only — it is honored solely when it sits under the type's canonical folder, otherwise it is ignored and the canonical path wins. Returns the created note. Write-scope is enforced on the derived path.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Human title; also the source for the derived slug." },
            body: { type: "string", description: "Markdown body (optional — defaults to '# {title}')." },
            type: {
              type: "string",
              // Brain's FULL enum (superset of ADR-004's NoteType subset —
              // backward-compatible: every ADR type is accepted, plus the
              // extended ones skill/peer/tool/resource/reference).
              enum: [...DOC_TYPES],
              default: "note",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional frontmatter tags.",
            },
            folder_hint: {
              type: "string",
              description:
                "Optional location hint. Honored only when it is the type's canonical folder or a sub-folder of it; otherwise ignored.",
            },
          },
          required: ["title", "type"],
        },
      },
      {
        name: "graph.get",
        description:
          "Get the whole Lokyy-Brain knowledge graph derived from the vault's wikilinks — { nodes, edges }. OS-contract (ADR-004) equivalent of HTTP GET /api/graph. Takes no arguments.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "pipes.import",
        description:
          "Enqueue an active import of an external URL into the vault (OS-contract, ADR-004; equivalent of HTTP POST /api/pipes/import). The pipe queue detects the source kind from the URL, or you may force it with `type` (youtube | voice | url | crawl). Returns the queued PipeJob (with its `id` and `status`); poll completion with pipes.status. Captured sources land under 30_captures/ with type:capture frontmatter.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to import." },
            type: {
              type: "string",
              enum: ["youtube", "voice", "url", "crawl"],
              description: "Optional explicit pipe type; omit to let the queue detect it.",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "pipes.status",
        description:
          "Get the current status of a previously-enqueued pipe job by its id (OS-contract, ADR-004; equivalent of GET /api/pipes filtered by id). Returns the PipeJob (status: queued | processing | done | error; `resultNoteId` once done). An unknown id returns { error: 'not-found', job_id }.",
        inputSchema: {
          type: "object",
          properties: {
            job_id: { type: "string", description: "The PipeJob id returned by pipes.import." },
          },
          required: ["job_id"],
        },
      },

      /* ---- Dotted ALIASES (same args + behavior as the snake_case tool) ---- */
      {
        name: "notes.read",
        description:
          "OS-contract alias of `read_note` (ADR-004). Read a single note (markdown body + frontmatter). `path` is the note id without the .md extension.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Note id, e.g. 'pai/hermes'" } },
          required: ["path"],
        },
      },
      {
        name: "notes.list_by_type",
        description:
          "OS-contract alias of `list_notes` (ADR-004 notes.list_by_type). List notes matching a frontmatter filter — pass { filter: { type: 'decision' } } to list by type. Same args, scope, and pagination as `list_notes`.",
        inputSchema: {
          type: "object",
          properties: {
            filter: {
              type: "object",
              properties: {
                type: { type: "string", description: "Doc type equality, e.g. 'decision'." },
                folder: { type: "string", description: "Folder path prefix." },
                tag: { type: "string", description: "A tag the note must carry." },
                status: { type: "string", description: "Frontmatter `status` equality." },
                updated_after: {
                  type: "string",
                  description: "ISO date/datetime; keep notes whose `updated` is strictly after this.",
                },
              },
            },
            limit: { type: "number", description: "Page size (default 50).", default: 50 },
            offset: { type: "number", description: "Rows to skip (default 0).", default: 0 },
          },
        },
      },
      {
        name: "notes.search",
        description:
          "OS-contract alias of `search_vault` (ADR-004). Search the vault (Tier 1 full-text + Tier 2 semantic). Same args + scored results as `search_vault`.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", default: 10 },
          },
          required: ["query"],
        },
      },
      {
        name: "notes.update_content",
        description:
          "OS-contract alias of `update_note` (ADR-004). Save/upsert a note's body (preserves id + created, bumps updated). Same args + behavior as `update_note`.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            body: { type: "string" },
          },
          required: ["path", "body"],
        },
      },
      {
        name: "vault.tree",
        description:
          "OS-contract alias of `list_tree` (ADR-004 vault.tree). List the scoped vault folder/note tree. Same behavior as `list_tree`.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // Story 13.1 — dotted ALIASES dispatch through the SAME switch case as
    // their snake_case original, guaranteeing identical args/behavior with no
    // duplicated logic. `requestedName` is kept for the error wrapper so a
    // caller sees the tool name it actually invoked. Genuinely-new dotted
    // tools (notes.create_managed, graph.get, pipes.*) are NOT aliases — they
    // have their own cases below and are absent from this map.
    const requestedName = req.params.name;
    const name = DOTTED_ALIASES[requestedName] ?? requestedName;
    // Story 10.7 — wrap the WHOLE dispatch. An exception thrown around the
    // switch itself (e.g. DB-pool exhaustion while acquiring a connection)
    // would otherwise escape to the SDK and surface as the useless generic
    // "Error occurred during tool execution". Catch it here and return a
    // classified `tool-execution-failed` instead, never leaking the raw
    // Postgres/stacktrace text to the client (it is logged server-side).
    try {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      try {
        switch (name) {
        case "read_note": {
          const path = String(args.path);
          if (!canRead(`${path}.md`)) throw new ScopeViolation("read", path);
          const note = await getNote(path);
          if (!note) return text({ error: "not-found", path });
          return text(note);
        }
        case "resolve_by_id": {
          const id = String(args.id ?? "");
          if (!isUlid(id)) {
            return text({ error: "invalid-ulid-format", id });
          }
          const resolved = await findByUlid(id);
          if (!resolved) return text({ error: "not-found", id });
          // Apply the same scope-read gate path-based read_note uses, so a
          // shared ULID cannot bypass an agent's read-scope restrictions.
          if (!canRead(`${resolved.path}.md`)) {
            throw new ScopeViolation("read", resolved.path);
          }
          return text(resolved);
        }
        case "search_vault": {
          const query = String(args.query ?? "");
          const limit = Number(args.limit ?? 10);
          const provider = getMemoryProvider(vaultId);
          const hits = await provider.search(query, { limit });
          const filtered = hits.filter((h) => canRead(`${h.noteId}.md`));
          return text({ results: filtered });
        }
        case "list_tree": {
          const tree = await getTree();
          return text({ tree: filterTreeByScope(tree) });
        }
        case "create_note": {
          // AC#1/2/4 — resolve type (strict, no silent coerce) + path
          // (derive from type+slug when omitted). Pure function so the
          // decision logic is unit-testable without a live DB/git server.
          const resolved = resolveCreateNoteInput(args);
          if (!resolved.ok) return text(resolved.error);
          const { type, path } = resolved;

          if (!canWrite(`${path}.md`)) throw new ScopeViolation("write", path);

          // AC#6 — pass extra frontmatter through so a typed note with extra
          // required fields (skill_name/description, peer_type, …) is valid
          // and listable in ONE call (no create→update workaround).
          const extra =
            args.frontmatter && typeof args.frontmatter === "object"
              ? (args.frontmatter as Record<string, unknown>)
              : undefined;

          try {
            const note = await createNote(
              path,
              args.body as string | undefined,
              {
                title: args.title as string | undefined,
                type,
                ...(extra ? { extra } : {}),
                // AC#5 — couple folder to type; contradictory paths throw
                // TypeFolderMismatchError, surfaced as a structured error.
                validatePlacement: true,
              },
            );
            return text({ created: note, commitPrefix: activeScope().commitPrefix });
          } catch (err) {
            if (err instanceof TypeFolderMismatchError) {
              return text({
                error: "type-folder-mismatch",
                type: err.type,
                expectedFolder: err.expectedFolder,
                gotPath: err.gotPath,
              });
            }
            throw err;
          }
        }
        case "update_note": {
          const path = String(args.path);
          if (!canWrite(`${path}.md`)) throw new ScopeViolation("write", path);
          const note = await saveNote(path, String(args.body ?? ""));
          return text({ updated: note, commitPrefix: activeScope().commitPrefix });
        }
        case "list_skills": {
          // Skill notes are ordinary notes (canonically under 70_pai/skills/);
          // reading them already runs through the read-scope, so only return
          // skills whose note path is readable by this agent (AC#4).
          const skills = await listSkillNotes(activeVaultDir);
          const summaries = skills
            .filter((s) => canRead(skillNotePath(s.skill_name)))
            .map((s) => ({
              skill_name: s.skill_name,
              title: s.title,
              description: s.description,
              ...(s.input_schema !== undefined ? { input_schema: s.input_schema } : {}),
              execution: s.execution,
              allowed_tools: s.allowed_tools,
              // Epic 12 — optional folder-skill structure (omitted for
              // single-note skills, which leave these undefined).
              ...(s.basePath !== undefined ? { base_path: s.basePath } : {}),
              ...(s.references && s.references.length > 0
                ? { references: s.references }
                : {}),
              ...(s.templates && s.templates.length > 0
                ? { templates: s.templates }
                : {}),
            }));
          return text({ skills: summaries });
        }
        case "run_skill": {
          const skillName = String(args.skill_name ?? "");
          // Scope-gate before touching disk: same `<path>.md` read-gate the
          // path-based tools use. Out-of-scope → structured ScopeViolation.
          if (!canRead(skillNotePath(skillName))) {
            throw new ScopeViolation("read", `70_pai/skills/${skillName}`);
          }
          const skills = await listSkillNotes(activeVaultDir);
          const skill = skills.find((s) => s.skill_name === skillName);
          if (!skill) {
            return text({ ok: false, error: "skill-not-found", skill_name: skillName });
          }
          if (skill.execution === "server") {
            return text({
              ok: false,
              error: "server-execution-not-supported",
              skill_name: skillName,
            });
          }
          const input = (args.input ?? {}) as Record<string, unknown>;
          const validation = validateSkillInput(skill, input);
          if (!validation.ok) {
            return text({
              ok: false,
              error: "invalid-input",
              skill_name: skillName,
              field_errors: validation.errors ?? [],
            });
          }
          const prompt = renderPrompt(skill, input);
          // allowed_tools is advisory (PRD Q3): prepend a single hint line, do
          // NOT block out-of-allowlist calls.
          const finalPrompt =
            skill.allowed_tools.length > 0
              ? `You should only use these tools: ${skill.allowed_tools.join(", ")}.\n\n${prompt}`
              : prompt;
          // Epic 12 — progressive disclosure: surface companion reference
          // PATHS only (with a load-on-demand hint), never embed their bodies.
          // SKILL.md is the entry door; the agent reads references via
          // read_note when it actually needs them.
          const referencePaths = (skill.references ?? []).map((r) => r.path);
          return text({
            ok: true,
            skill_name: skillName,
            prompt: finalPrompt,
            allowed_tools: skill.allowed_tools,
            ...(skill.output !== undefined ? { output: skill.output } : {}),
            ...(referencePaths.length > 0
              ? {
                  references: referencePaths,
                  references_hint:
                    "This skill ships reference docs. Load any you need on demand via read_note — they are not embedded here.",
                }
              : {}),
            ...(skill.basePath !== undefined ? { base_path: skill.basePath } : {}),
          });
        }
        case "import_skill": {
          // Story 12.3 — import an Anthropic-format folder-skill. Parse the
          // MCP arg shape ({ rel_path, content }) into core's ImportSkillFile
          // ({ relPath, content }), enforce per-file write-scope BEFORE any
          // disk write (same gate as create_note), then delegate the
          // frontmatter injection + git write to the shared core importSkill.
          const skillName = String(args.skill_name ?? "");
          const parsed = parseImportSkillFiles(args.files);
          if (!parsed.ok) return text(parsed.error);
          const files = parsed.files;

          // No-manifest / empty guards surfaced as structured errors up front
          // (core throws plain Errors here; classify them to typed shapes so a
          // caller can react instead of getting tool-execution-failed).
          if (files.length === 0) {
            return text({ error: "no-files", skill_name: skillName });
          }
          if (!files.some((f) => isSkillManifestRel(f.relPath))) {
            return text({ error: "no-skill-manifest", skill_name: skillName });
          }

          // Per-file write-scope: build each target vault path under the
          // slugified skill dir and reject the whole import if ANY is denied
          // (all-or-nothing, consistent with the bulk-write tools).
          const slug = slugifyForScope(skillName);
          const scopeErr = firstWriteScopeViolation(
            files.map((f) => `70_pai/skills/${slug}/${normalizeRelForScope(f.relPath)}`),
            // skill paths already carry their own extension; do NOT append .md
            { appendMdExtension: false },
          );
          if (scopeErr) throw scopeErr;

          const result = await importSkill({ skillName, files });
          return text({
            imported: result,
            commitPrefix: activeScope().commitPrefix,
          });
        }
        case "delete_note": {
          // Story 10.3. Default soft-delete (move to trash); hard=true removes.
          const path = String(args.path ?? "");
          const hard = args.hard === true;
          if (!canWrite(`${path}.md`)) throw new ScopeViolation("write", path);
          // Structured not-found up front (AC#3): both helpers would throw on a
          // missing source, so we check existence here to return the typed shape
          // instead of letting it fall through to the error wrapper.
          const existing = await getNote(path);
          if (!existing) return text({ error: "not-found", path });
          if (hard) {
            await deleteEntry(path, "note");
            return text({ deleted: { path }, mode: "hard" });
          }
          const trashed = await trashEntry(path);
          return text({ deleted: trashed, mode: "soft" });
        }
        case "get_vault_conventions": {
          // Story 10.4 — pure, no scope gate (it describes the vault shape, not
          // any note's content).
          return text(getVaultConventions());
        }
        case "get_skill_schema": {
          // Story 10.5 — pure schema + example + field docs.
          return text(getSkillSchema());
        }
        case "get_health": {
          // Story 10.8 — vault_id from server context; everything core cannot
          // cheaply read stays null/"unknown" (no guessing, AC#2/AC#6).
          // Story 10.13 — vault_warning is the boot-time multi-vault detection
          // result (null when unambiguous or detection was unavailable).
          return text(getHealth({ vaultId, vaultWarning }));
        }
        case "move_note": {
          // Story 10.9 — re-file a note; ULID stays stable (moveEntry only
          // invalidates the path-cache). Same path-based scope gate as the
          // other write tools, on BOTH endpoints.
          const from = String(args.from ?? "");
          const to = String(args.to ?? "");
          return moveNote(from, to);
        }
        case "rename_note": {
          // Story 10.9 — rename == move within the same parent folder. Derive
          // the destination id by swapping the last path segment for new_slug.
          const path = String(args.path ?? "");
          const newSlug = String(args.new_slug ?? "");
          const to = renameTarget(path, newSlug);
          return moveNote(path, to);
        }
        case "create_notes": {
          // Story 10.10 — atomic bulk create via core `createNotes` (validate-all
          // then write-all). Per-item write-scope BEFORE handing to core, so an
          // out-of-scope item is rejected without writing anything.
          const items = normalizeBulkCreate(args.notes);
          const scopeErr = firstWriteScopeViolation(items.map((i) => i.id));
          if (scopeErr) throw scopeErr;
          const result = await createNotes(items);
          return text(result);
        }
        case "update_notes": {
          // Story 10.10 — atomic bulk update via core `updateNotes`. Same
          // per-item write-scope pre-check as create_notes.
          const items = normalizeBulkUpdate(args.updates);
          const scopeErr = firstWriteScopeViolation(items.map((i) => i.id));
          if (scopeErr) throw scopeErr;
          const result = await updateNotes(items);
          return text(result);
        }
        case "list_notes": {
          // Story 10.11 — frontmatter filter via dataview `queryNotes`, then the
          // same read-scope filter list_tree/search_vault apply, then paginate.
          const filter = (args.filter ?? {}) as Record<string, unknown>;
          const limit = clampInt(args.limit, 50, 1, 200);
          const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
          return text(await listNotes(filter, limit, offset));
        }
        case "create_folder": {
          // Story 10.14 — explicit folder (.gitkeep) + optional README note.
          const path = String(args.path ?? "");
          const withReadme = args.with_readme === true;
          // Scope-gate the folder the SAME way filterTreeByScope decides an
          // empty folder is writable: an agent may have a `.md`-only write
          // scope (e.g. `**/*.md`), under which the bare `.gitkeep` path won't
          // match — so accept if EITHER the `.gitkeep` OR the folder's
          // representative `.md` is writable. Without this, a legitimately
          // write-scoped agent is wrongly denied create_folder.
          if (!canWriteFolder(path)) throw new ScopeViolation("write", path);
          await createFolder(path);
          if (!withReadme) return text({ created: path });
          // README sits inside the folder; gate it on its own .md path.
          const readmeId = `${path}/README`;
          if (!canWrite(`${readmeId}.md`)) throw new ScopeViolation("write", readmeId);
          const readme = await createNote(readmeId, undefined, {
            type: "note",
            title: "README",
          });
          return text({ created: path, readme });
        }
        case "get_backlinks": {
          // Story 10.16 — incoming wikilinks ("who links here") with context.
          // Read-scope on the TARGET note, plus the same read-scope drop the
          // search/tree tools apply to each SOURCE note (an out-of-scope note
          // must not be revealed as a linker).
          const path = String(args.path ?? "");
          if (!canRead(`${path}.md`)) throw new ScopeViolation("read", path);
          const refs = await backlinks(path);
          const filtered = refs.filter((b) => canRead(`${b.noteId}.md`));
          return text({ backlinks: filtered });
        }
        case "find_broken_links": {
          // Story 10.16 — vault-wide broken-wikilink scan (health check). Drop
          // any finding whose SOURCE note is outside this agent's read-scope.
          const broken = await findBrokenLinks();
          const filtered = broken.filter((b) => canRead(`${b.sourceId}.md`));
          return text({ broken_links: filtered });
        }
        case "get_tags": {
          // Story 10.16 — all tags + counts (frontmatter + inline). The tag
          // aggregate is vault-wide metadata, not per-note content; no scope
          // gate (mirrors get_vault_conventions' "describes the vault" stance).
          const tags = await listTags();
          return text({ tags });
        }
        case "get_history": {
          // Story 10.17 — read-only git history for a single note. Read-scope
          // on the path; limit is clamped by core's noteHistory.
          const path = String(args.path ?? "");
          if (!canRead(`${path}.md`)) throw new ScopeViolation("read", path);
          const limit = args.limit === undefined ? undefined : Number(args.limit);
          const history = await noteHistory(`${path}.md`, limit);
          return text({ history });
        }
        case "get_note_diff": {
          // Story 10.17 — read-only diff (committed sha, or working-tree when
          // sha omitted). Read-scope on the path.
          const path = String(args.path ?? "");
          if (!canRead(`${path}.md`)) throw new ScopeViolation("read", path);
          const sha = typeof args.sha === "string" && args.sha.length > 0 ? args.sha : undefined;
          const diff = await noteDiff(`${path}.md`, sha);
          return text(diff);
        }
        case "validate_note": {
          // Story 10.17 — frontmatter validation without writing. Source the
          // markdown from `path` (read + scope-gated) OR a raw `body` string.
          return validateNote(args);
        }

        /* ---- Story 13.1 — OS-MCP-contract NEW tools (no snake_case twin) ---- */
        case "notes.create_managed": {
          // THE sanctioned write path. The client gives an INTENT only; Brain
          // derives the path from `type` (NEVER trusts a client path), then
          // reuses the existing createNote path so ULID/created/updated/
          // frontmatter assembly + SPEC validation are identical to create_note.
          const resolved = resolveManagedCreate(args);
          if (!resolved.ok) return text(resolved.error);
          const { type, path, title, tags } = resolved;

          if (!canWrite(`${path}.md`)) throw new ScopeViolation("write", path);

          // Tags (when supplied) flow through as extra frontmatter, exactly as
          // create_note threads its `frontmatter` arg.
          const extra = tags.length > 0 ? { tags } : undefined;

          try {
            const note = await createNote(path, args.body as string | undefined, {
              title,
              type,
              ...(extra ? { extra } : {}),
              // Couple folder to type; a contradictory derived path can never
              // happen (we derive it), but keep the guard on for the
              // folder_hint sub-folder case (defensive, mirrors create_note).
              validatePlacement: true,
            });
            return text({ created: note, commitPrefix: activeScope().commitPrefix });
          } catch (err) {
            if (err instanceof TypeFolderMismatchError) {
              return text({
                error: "type-folder-mismatch",
                type: err.type,
                expectedFolder: err.expectedFolder,
                gotPath: err.gotPath,
              });
            }
            throw err;
          }
        }
        case "graph.get": {
          // Thin wrapper over core buildGraph — the HTTP /api/graph pendant.
          // The graph is vault-wide derived metadata (like get_tags); no
          // per-note scope gate, consistent with that tool's stance.
          const graph = await buildGraph();
          return text(graph);
        }
        case "pipes.import": {
          // Thin wrapper over the pipe queue — the HTTP POST /api/pipes/import
          // pendant. Enqueue + return the PipeJob; the queue drains async.
          const url = String(args.url ?? "");
          if (!url) return text({ error: "missing-url", message: "`url` is required." });
          const typeOverride =
            typeof args.type === "string" && args.type.length > 0
              ? (args.type as PipeType)
              : undefined;
          const payload: SharePayload = { url };
          const job = enqueue(payload, typeOverride);
          return text(job);
        }
        case "pipes.status": {
          // Thin wrapper over listJobs — the GET /api/pipes pendant, filtered
          // by id. Unknown id → structured not-found.
          const jobId = String(args.job_id ?? "");
          const job = listJobs().find((j) => j.id === jobId);
          if (!job) return text({ error: "not-found", job_id: jobId });
          return text(job);
        }

          default:
            return text({ error: "unknown-tool", name: requestedName });
        }
      } catch (err) {
        // Story 10.7 — per-tool structured errors keep their format, additively
        // tagged with `error_class` so callers can decide retry vs. give-up.
        if (err instanceof ScopeViolation) {
          // Scope/validation issues are the caller's to fix → user-error.
          return text({
            error: "scope_violation",
            action: err.action,
            path: err.path,
            error_class: "user-error",
          });
        }
        // Anything else reaching here is an unclassified handler throw; route it
        // through the classifier so the raw backend message never leaks and a
        // class is always present (replaces the old raw-message fallback).
        // Use the name the caller actually invoked (alias-aware).
        return text(classifyToolError(err, requestedName));
      }
    } catch (outer) {
      // Infra exception thrown AROUND the switch (pool acquire, etc.) — the SDK
      // would otherwise emit its generic error. Classify + return structured.
      return text(classifyToolError(outer, requestedName));
    }
  });

  return server;
}

/**
 * Convenience wrapper for the stdio path: run one-time init, then build a
 * single Server. stdio uses one Server + one transport, so a single instance
 * is correct here. The HTTP path instead calls `initServerDeps` once and
 * `createServer` per session.
 */
export async function buildServer(
  coreConfig: CoreConfig,
  databaseUrl: string,
  vaultId: string,
  agentId: string,
): Promise<Server> {
  await initServerDeps(coreConfig, databaseUrl, vaultId, agentId);
  return createServer();
}

export async function start(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[lokyy-mcp] connected via stdio");
}

/* ------------------------------------------------------------------ *
 *  Story 10.7 — structured-error classification for MCP dispatch.
 * ------------------------------------------------------------------ */

/**
 * Retry taxonomy returned on EVERY error so a calling agent can decide
 * "transient → retry" vs. "permanent/user-error → don't":
 *   - transient   : retryable backend hiccup (pool exhaustion, timeout, lock).
 *   - permanent   : non-retryable backend failure (schema/programmer error).
 *   - user-error  : caller's fault (bad input, scope, not-found).
 *   - backend     : backend failure of unknown transience (default).
 */
export type ErrorClass = "transient" | "permanent" | "user-error" | "backend";

/** The structured shape for an otherwise-unclassified tool failure. */
export interface ToolExecutionError {
  error: "tool-execution-failed";
  error_class: ErrorClass;
  message: string;
  tool: string;
  retry_after_ms?: number;
}

/**
 * Map an arbitrary thrown value to a structured `tool-execution-failed`
 * payload (Story 10.7). The raw message is LOGGED server-side (stderr) but
 * NEVER returned verbatim — clients get only a short, classified message so a
 * Postgres error / stacktrace can't leak (AC#3). Heuristics key off the error
 * name/message; anything unrecognised defaults to `backend`.
 */
export function classifyToolError(err: unknown, tool: string): ToolExecutionError {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Log the full detail server-side (stderr — the stdio transport uses stdout
  // for the protocol, so stderr is safe for diagnostics).
  console.error(`[lokyy-mcp] tool "${tool}" failed:`, raw);

  const hay = raw.toLowerCase();
  // Pool exhaustion / connection limits → transient backend, advise a retry.
  if (
    hay.includes("pool") ||
    hay.includes("too many connections") ||
    hay.includes("connection terminated") ||
    hay.includes("timeout") ||
    hay.includes("etimedout") ||
    hay.includes("econnrefused") ||
    hay.includes("econnreset")
  ) {
    return {
      error: "tool-execution-failed",
      error_class: "transient",
      message: "Backend temporarily unavailable (connection/pool). Retry shortly.",
      tool,
      retry_after_ms: 1000,
    };
  }
  // Lock contention (git lock held) → transient, slightly longer backoff.
  if (hay.includes("lock") || hay.includes("locked")) {
    return {
      error: "tool-execution-failed",
      error_class: "transient",
      message: "Backend busy (lock contention). Retry shortly.",
      tool,
      retry_after_ms: 500,
    };
  }
  // Everything else: classified as backend, generic short message (no leak).
  return {
    error: "tool-execution-failed",
    error_class: "backend",
    message: "Tool execution failed. See server logs for details.",
    tool,
  };
}

/* ------------------------------------------------------------------ *
 *  Story 10.9 — move_note / rename_note helpers.
 * ------------------------------------------------------------------ */

/**
 * Shared body for `move_note` and `rename_note`. Both are a `moveEntry(_, _,
 * "note")` with write-scope on BOTH endpoints and a structured `not-found`
 * when the source is missing. Returns the `text()`-wrapped tool payload.
 *
 * Backlink handling (AC#3) is best-effort + non-blocking: after the move
 * succeeds we look up notes that still wikilink the OLD path and, if any,
 * attach them as a `warning` (no rewrite — that is a later story). The lookup
 * is wrapped so it can never turn a successful move into a failure.
 */
async function moveNote(from: string, to: string) {
  if (!canWrite(`${from}.md`)) throw new ScopeViolation("write", from);
  if (!canWrite(`${to}.md`)) throw new ScopeViolation("write", to);
  // Structured not-found up front (moveEntry would otherwise throw a git error).
  const existing = await getNote(from);
  if (!existing) return text({ error: "not-found", path: from });

  await moveEntry(from, to, "note");

  // AC#3 — surface (do NOT rewrite) any path-based backlinks to the old id.
  let warning: string | undefined;
  try {
    const refs = await backlinks(from);
    if (refs.length > 0) {
      const ids = refs.map((b) => b.noteId);
      warning =
        `${refs.length} note(s) still link to the old path "${from}" — ` +
        `path-based wikilinks were NOT rewritten. Update them manually: ${ids.join(", ")}.`;
    }
  } catch {
    // Backlink scan is advisory; never fail the move on it.
  }

  return text({ moved: { from, to }, ...(warning ? { warning } : {}) });
}

/**
 * Derive the rename destination id: keep the parent folder, swap the final
 * segment for `new_slug`. A slug with a slash or trailing/leading separators
 * is normalized to its basename so a rename can never silently re-file.
 */
function renameTarget(path: string, newSlug: string): string {
  const slug = newSlug.replace(/\.md$/, "").split("/").filter(Boolean).pop() ?? newSlug;
  const idx = path.lastIndexOf("/");
  return idx === -1 ? slug : `${path.slice(0, idx)}/${slug}`;
}

/* ------------------------------------------------------------------ *
 *  Story 10.17 — validate_note helper.
 * ------------------------------------------------------------------ */

/** A single validation error, mirrored from core's `ValidationErrorDetail`. */
type ValidateNoteError = ValidationErrorDetail;

/**
 * Body for the `validate_note` tool (Story 10.17). Sources the markdown from
 * either an existing note `path` (read + read-scope gated) or a raw `body`
 * string, parses its frontmatter, and validates it against the type's schema
 * via core's pure `validateFrontmatter` (no write, no git mutation).
 *
 *   - `path` wins when both are supplied (an explicit on-disk note is the more
 *     specific intent).
 *   - The doc `type` is taken from the note's OWN frontmatter; a missing/
 *     unknown type is surfaced by `validateFrontmatter` itself (it returns a
 *     structured `enum`/type error rather than throwing).
 *   - Neither `path` nor `body` → a `valid:false` with a synthetic input error,
 *     so the caller always gets the documented `{ valid, errors }` shape.
 *
 * Returns the `text()`-wrapped tool payload.
 */
async function validateNote(args: Record<string, unknown>) {
  const path = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
  const rawBody = typeof args.body === "string" ? args.body : undefined;

  let markdown: string;
  if (path !== undefined) {
    // Same read-scope gate as the other path-based read tools.
    if (!canRead(`${path}.md`)) throw new ScopeViolation("read", path);
    const note = await getNote(path);
    if (!note) return text({ valid: false, errors: [], error: "not-found", path });
    markdown = note.body;
  } else if (rawBody !== undefined) {
    markdown = rawBody;
  } else {
    const errors: ValidateNoteError[] = [
      {
        instancePath: "",
        keyword: "required",
        message: "Provide either `path` or `body`.",
        params: {},
      },
    ];
    return text({ valid: false, errors });
  }

  const data: FrontmatterMap = parseFrontmatter(markdown).data;
  // `type` drives schema selection; validateFrontmatter returns a structured
  // enum error for a missing/unknown type (no throw), so pass it through as-is.
  const type = data.type as DocType;
  const result = validateFrontmatter(data, type);
  return text({ valid: result.valid, errors: result.errors });
}

/* ------------------------------------------------------------------ *
 *  Story 10.10 — bulk create/update helpers.
 * ------------------------------------------------------------------ */

/** Coerce the `notes` arg into `BulkCreateItem[]` (id + body + per-item opts). */
function normalizeBulkCreate(raw: unknown): BulkCreateItem[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((n) => {
    const o = (n ?? {}) as Record<string, unknown>;
    const id = String(o.id ?? o.path ?? "");
    const type = isDocType(o.type) ? o.type : undefined;
    const title = typeof o.title === "string" ? o.title : undefined;
    return {
      id,
      ...(typeof o.body === "string" ? { body: o.body } : {}),
      // validatePlacement mirrors single create_note (Story 10.2) so bulk
      // items obey the same type→folder coupling; core validates it pre-flight.
      opts: { ...(type ? { type } : {}), ...(title ? { title } : {}), validatePlacement: true },
    };
  });
}

/** Coerce the `updates` arg into `BulkUpdateItem[]` (id + new body). */
function normalizeBulkUpdate(raw: unknown): BulkUpdateItem[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((n) => {
    const o = (n ?? {}) as Record<string, unknown>;
    return { id: String(o.id ?? o.path ?? ""), body: String(o.body ?? "") };
  });
}

/**
 * Per-item write-scope pre-check for the bulk tools. Returns the FIRST
 * `ScopeViolation` (so the whole batch is rejected before any write — keeping
 * the bulk op all-or-nothing on scope, consistent with its atomicity), or null
 * when every id is writable.
 */
function firstWriteScopeViolation(
  ids: string[],
  opts: { appendMdExtension?: boolean } = {},
): ScopeViolation | null {
  // Bulk note tools pass note ids WITHOUT the .md extension, so we append it
  // to match the scope globs. import_skill (Story 12.3) instead passes full
  // vault paths that already carry their own extension (SKILL.md, *.jsx, …),
  // so it opts out of the append.
  const appendMd = opts.appendMdExtension ?? true;
  for (const id of ids) {
    const path = appendMd ? `${id}.md` : id;
    if (!canWrite(path)) return new ScopeViolation("write", id);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  Story 10.11 — list_notes helper.
 * ------------------------------------------------------------------ */

/** Clamp an unknown numeric arg into [min,max], falling back to `dflt`. */
function clampInt(raw: unknown, dflt: number, min: number, max: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/**
 * Run a frontmatter-filtered note listing (Story 10.11). Maps the MCP filter
 * onto `queryNotes` (folder→`from`, type/status→`where` equality, tag→special
 * `where.tag`), then applies post-filters `queryNotes` does not natively
 * support (`updated_after` is a comparison, not equality), the read-scope drop
 * (same gate as list_tree/search_vault), and limit/offset pagination.
 *
 * `queryNotes` has no offset and only does equality, so we over-fetch with a
 * generous limit and slice locally — the vault is small enough that this is
 * cheaper than adding a comparison operator to the shared dataview engine
 * (which AC#5 forbids touching).
 */
async function listNotes(
  filter: Record<string, unknown>,
  limit: number,
  offset: number,
) {
  const where: Record<string, unknown> = {};
  if (typeof filter.type === "string") where.type = filter.type;
  if (typeof filter.status === "string") where.status = filter.status;
  if (typeof filter.tag === "string") where.tag = filter.tag;

  const q: DataviewQuery = {
    ...(typeof filter.folder === "string" ? { from: filter.folder } : {}),
    where,
    // Project the fields callers expect plus `updated` (needed for the
    // updated_after comparison). queryNotes always guarantees id + title.
    select: ["title", "type", "status", "updated"],
    sort: "updated",
    order: "desc",
    limit: 200, // MAX_LIMIT — over-fetch, then scope-drop + paginate locally.
  };

  const rows = await queryNotes(q);

  const updatedAfter =
    typeof filter.updated_after === "string" ? Date.parse(filter.updated_after) : NaN;

  const matched = rows.filter((row) => {
    const id = String(row.id ?? "");
    if (!id) return false;
    if (!canRead(`${id}.md`)) return false; // read-scope drop (AC#2).
    if (Number.isFinite(updatedAfter)) {
      const u = typeof row.updated === "string" ? Date.parse(row.updated) : NaN;
      if (!Number.isFinite(u) || u <= updatedAfter) return false;
    }
    return true;
  });

  const total = matched.length;
  const page = matched.slice(offset, offset + limit).map(projectRow);
  return { notes: page, total, hasMore: offset + limit < total, limit, offset };
}

/** Re-key a dataview row to the documented `{ noteId, ...projected }` shape. */
function projectRow(row: DataviewRow): Record<string, unknown> {
  const { id, ...rest } = row;
  return { noteId: id, ...rest };
}

/**
 * Canonical on-disk path of a skill note (without VAULT_DIR prefix), used for
 * the read-scope gate. Skills live under `70_pai/skills/` per the SPEC; the
 * scope-resolver matches against this `<id>.md` form exactly like the other
 * read-tools do.
 */
function skillNotePath(skillName: string): string {
  return `70_pai/skills/${skillName}.md`;
}

/* ------------------------------------------------------------------ *
 *  Story 12.3 — import_skill helpers (folder-skill import).
 * ------------------------------------------------------------------ */

/** Structured error payloads `import_skill` returns before touching disk. */
export type ImportSkillInputError = {
  error: "invalid-files";
  message: string;
};

/**
 * Validate + map the MCP `files` arg ({ rel_path, content }) onto core's
 * `ImportSkillFile` ({ relPath, content }). The MCP SDK does NOT enforce the
 * inputSchema, so each entry is checked explicitly: it must be an object with
 * a non-empty string `rel_path` and a string `content`. On any malformed entry
 * we return a single structured `invalid-files` error (the import is rejected
 * wholesale rather than silently dropping bad rows). Pure → unit-testable.
 */
export function parseImportSkillFiles(
  raw: unknown,
):
  | { ok: true; files: ImportSkillFile[] }
  | { ok: false; error: ImportSkillInputError } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: { error: "invalid-files", message: "`files` must be an array." },
    };
  }
  const files: ImportSkillFile[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object") {
      return {
        ok: false,
        error: { error: "invalid-files", message: `files[${i}] must be an object.` },
      };
    }
    const rel = (entry as Record<string, unknown>).rel_path;
    const content = (entry as Record<string, unknown>).content;
    if (typeof rel !== "string" || rel.trim().length === 0) {
      return {
        ok: false,
        error: {
          error: "invalid-files",
          message: `files[${i}].rel_path must be a non-empty string.`,
        },
      };
    }
    if (typeof content !== "string") {
      return {
        ok: false,
        error: {
          error: "invalid-files",
          message: `files[${i}].content must be a string.`,
        },
      };
    }
    files.push({ relPath: rel, content });
  }
  return { ok: true, files };
}

/** Normalize a relPath to POSIX slashes, stripping any leading slash. */
function normalizeRelForScope(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Is `relPath` the skill's top-level `SKILL.md` (case-insensitive)? */
function isSkillManifestRel(relPath: string): boolean {
  return normalizeRelForScope(relPath).toLowerCase() === "skill.md";
}

/**
 * Slugify a free-form skill name into the lowercase-kebab directory token —
 * MUST mirror core's `slugifySkillName` so the write-scope check targets the
 * SAME path core will write to. (Kept local rather than importing to avoid a
 * surface dependency on a core internal; covered by the e2e round-trip.)
 */
function slugifyForScope(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "skill";
}

/**
 * Runtime type-guard for the closed DOC_TYPES list (Story 10.2, AC#1/2).
 * The MCP SDK does not validate `arguments` against the inputSchema enum, so
 * the create_note handler relies on this explicit check to reject unknown
 * types instead of silently coercing them to "note".
 */
function isDocType(value: unknown): value is DocType {
  return typeof value === "string" && (DOC_TYPES as readonly string[]).includes(value);
}

/** Structured error payloads `create_note` returns before touching disk. */
export type CreateNoteInputError =
  | { error: "invalid-type"; got: unknown; allowed: string[] }
  | { error: "missing-path"; message: string; expectedFolder: string };

/** Resolved type + target path for a valid `create_note` request. */
export type CreateNoteInput =
  | { ok: true; type: DocType; path: string }
  | { ok: false; error: CreateNoteInputError };

/**
 * Resolve the `type` + `path` for a `create_note` call (Story 10.2,
 * AC#1/2/4). Pure + side-effect-free so it is unit-testable without a live
 * DB/git server.
 *
 *   - `type`: a present-but-unknown value is REJECTED (`invalid-type`),
 *     never coerced to "note". Absent → "note".
 *   - `path`: a non-empty `path` wins; else derive `{folder}/{…}` from
 *     `type` + `slug`; else `missing-path`. (Placement of an explicit path
 *     is validated downstream by `createNote({ validatePlacement:true })`.)
 */
export function resolveCreateNoteInput(
  args: Record<string, unknown>,
): CreateNoteInput {
  const rawType = args.type;
  let type: DocType;
  if (rawType === undefined || rawType === null) {
    type = "note";
  } else if (isDocType(rawType)) {
    type = rawType;
  } else {
    return {
      ok: false,
      error: { error: "invalid-type", got: rawType, allowed: [...DOC_TYPES] },
    };
  }

  if (typeof args.path === "string" && args.path.length > 0) {
    return { ok: true, type, path: args.path };
  }
  if (typeof args.slug === "string" && args.slug.length > 0) {
    return { ok: true, type, path: derivePathForType(type, args.slug) };
  }
  return {
    ok: false,
    error: {
      error: "missing-path",
      message: "Provide either `path` or `slug`.",
      expectedFolder: folderForType(type),
    },
  };
}

/* ------------------------------------------------------------------ *
 *  Story 13.1 — OS-MCP-contract (Epic 13) helpers.
 * ------------------------------------------------------------------ */

/**
 * Dotted-alias → snake_case-original dispatch map. A dotted alias is dispatched
 * through the SAME switch case as its original (identical args, scope, and
 * response) — registering the second name in ListTools and routing here is the
 * whole alias mechanism; there is zero duplicated handler logic. Genuinely-new
 * dotted tools (notes.create_managed, graph.get, pipes.import, pipes.status)
 * are intentionally ABSENT — they have their own cases.
 */
const DOTTED_ALIASES: Readonly<Record<string, string>> = {
  "notes.read": "read_note",
  "notes.list_by_type": "list_notes",
  "notes.search": "search_vault",
  "notes.update_content": "update_note",
  "vault.tree": "list_tree",
} as const;

/**
 * Story 13.1 — `resolveManagedCreate` + `slugifyTitle` (+ the input/result
 * types) now live in @lokyy/core (`notes/createManaged.ts`) so the MCP tool and
 * the HTTP POST /api/notes/create-managed route share ONE source (ISC-59). The
 * `notes.create_managed` handler imports `resolveManagedCreate` directly from
 * core; re-export it here so existing `./server.js` test imports keep resolving.
 */
export {
  resolveManagedCreate,
  slugifyTitle,
  type ManagedCreateInput,
  type ManagedCreateInputError,
} from "@lokyy/core";

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

interface TreeNode {
  type: "folder" | "note";
  name: string;
  path: string;
  children: TreeNode[];
}

/**
 * Whether the agent may write into a folder. A folder is created via a
 * `.gitkeep`, but an agent with a `.md`-only write scope (e.g. `**\/*.md`)
 * won't match the bare `.gitkeep` path — so we also accept the folder's
 * representative `_.md`. Single source of truth shared by `filterTreeByScope`
 * (empty-folder surfacing) and `create_folder` (Story 10.14).
 */
function canWriteFolder(path: string): boolean {
  return canWrite(`${path}/.gitkeep`) || canWrite(`${path}/_.md`);
}

function filterTreeByScope(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.type === "note") {
      if (canRead(`${n.path}.md`)) out.push(n);
    } else {
      const kids = filterTreeByScope(n.children);
      // Include folder if EITHER it has readable child notes OR the agent has
      // write-scope to it (so it knows where to put new notes). Empty folders
      // with only .gitkeep are surfaced with a [(empty)] marker so the model
      // sees the canonical SPEC structure (10_projects, 20_notes, …) even
      // before any notes land there.
      if (kids.length > 0) {
        out.push({ ...n, children: kids });
      } else if (canWriteFolder(n.path)) {
        out.push({
          ...n,
          name: `${n.name} (empty)`,
          children: [],
        });
      }
    }
  }
  return out;
}
