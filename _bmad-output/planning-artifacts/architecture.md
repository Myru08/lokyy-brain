---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/product-brief-lokyy-brain.md"
  - "_bmad-output/planning-artifacts/product-brief-lokyy-brain-distillate.md"
  - "docs/mockup/README.md"
workflowType: 'architecture'
project_name: 'lokyy-brain'
user_name: 'Oliver'
date: '2026-05-14'
lastStep: 8
status: 'complete'
completedAt: '2026-05-14'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
51 FRs across 8 capability areas. Architecturally, they cluster into four core responsibilities:

1. **Vault I/O** (FR7–14, FR25–30, FR44–47): All write operations flow through gitService with promise-lock. Three distinct writer types (PWA user, MCP agent, Consolidation Agent) must converge on the same serialization layer — this is the central architectural constraint.
2. **Knowledge Retrieval** (FR15–19): Two-tier search model: structural index (Tier 1, partially present in graphService) + semantic vector index (Tier 2, pgvector + nomic-embed-text). Both behind a `MemoryProvider` interface in `packages/core`.
3. **Identity & Access** (FR38–43, FR28, FR42): Dual-vault RBAC + MCP scope enforcement are orthogonal systems that must both be applied to every operation. Vault isolation is server-side non-negotiable.
4. **Autonomous Operation** (FR31–37): Consolidation Agent runs on schedule, writes via the same gitService as everything else — the agent is not a special case, it is another MCP client with a defined scope.

**Non-Functional Requirements — architectural drivers:**

| NFR | Architectural Implication |
|---|---|
| Search p95 < 500ms (5k notes) | pgvector with HNSW index; nomic-embed-text 768-dim; no blocking sync |
| Note save < 3s | git add+commit+push sequential; promise-lock must not become a convoy bottleneck |
| Editor responsive during index sync | Tier 2 sync is fire-and-forget; never in the request path |
| Offline queue integrity | IndexedDB save queue with explicit replay-state; no silent discards |
| Vault isolation server-side | Middleware layer before all route handlers; no trust on client claims |
| MCP scope server-side | Scope resolver reads `mcp-scopes.yaml` at server start; no runtime expansion |
| Consolidation Agent hard upper bound | Loop has max-iterations + max-runtime guard |
| Graceful Ollama degradation | MemoryProvider Tier 2 wrapped in try/catch; Tier 1 always available |

**Scale & Complexity:**
- **Primary domain:** Self-hosted full-stack web platform + agent runtime
- **Complexity level:** High — 8 simultaneous complexity domains (Auth, Git-serialization, MCP, pgvector, IndexedDB, Consolidation Agent, PWA, Setup Wizard)
- **Estimated architectural components:** 13 distinct subsystems
- **Multi-tenancy:** Yes — dual-vault, RBAC per vault
- **Real-time:** Limited — SSE/polling for pipe status and agent progress (no WebSocket in v1)
- **Regulatory:** GDPR (operator responsibility), AGPL (licensing constraint for code distribution)

### Technical Constraints & Dependencies

**Brownfield Baseline (migrate, not rebuild):**
- `gitService.ts` — ensureRepo, pull, save, remove, move, lastModified + promise-lock ✓
- `notesService.ts` — listNotes, getNote, saveNote, getTree, createNote, createFolder, moveEntry, deleteEntry ✓
- `graphService.ts` — parseLinks, parseTags, parseTitle, buildGraph ✓
- `pipeQueue.ts` + handlers (youtube, scrape, crawl) ✓
- PWA: CM6 editor + wikilink extension + FileTree.tsx + ImportPanel.tsx ✓

**Hard Architectural Constraints:**
- Forgejo is truth — no direct filesystem writes bypassing gitService
- nomic-embed-text runs locally via Ollama only — no external embedding APIs
- No Next.js — SPA (Vite + React 18) + vite-plugin-pwa
- MCP scope from `00_meta/mcp-scopes.yaml` in vault — no custom permission model
- AGPL license: architecture must not introduce proprietary hard dependencies

**External Service Dependencies:**

| Service | Status | Graceful Degradation |
|---|---|---|
| Forgejo (HTTP API + SSH) | Required | Offline mode activates |
| Postgres ≥14 + pgvector | Required | None — auth depends on it |
| Ollama + nomic-embed-text | Required (Tier 2) | Yes — Tier 1 remains available |
| Supadata | Optional, user-configured | Pipe handlers disabled if absent |

### Cross-Cutting Concerns

1. **Git Write Serialization** — Promise-lock in gitService affects PWA, MCP, and Consolidation Agent simultaneously. Concurrency model must be correct per installation.
2. **Frontmatter Validation** — SPEC validation in notesService (first defense) + pre-commit hook (last defense). Error type must be typed, not a generic git error.
3. **Vault Scope Isolation** — Middleware on every API route; MCP scope enforcement in MCP server. Two separate mechanisms, both server-side.
4. **Fire-and-Forget Index Sync** — Tier 2 (pgvector) updated async after every commit. Sync failures must never block save or startup; must be logged.
5. **Error Type Hierarchy** — Distinct types required: `FrontmatterValidationError`, `GitConflictError`, `VaultPermissionError`, `OfflineQueueError` — all must propagate to PWA and MCP clients.
6. **packages/core as Shared Layer** — Both `server` (Hono) and `mcp` import from `@lokyy/core`. No service logic duplication.
7. **Consolidation Agent as MCP Client** — Agent runs in the MCP server process or as a standalone scheduler; writes via the same MCP interface as any external agent. No privileged bypass.

## Starter Template Evaluation

### Primary Technology Domain

**Brownfield — no starter template selection required.** The monorepo exists with defined workspaces. The task is migration + extension, not greenfield initialization.

**Existing Foundation:**

| Workspace | Name | Key Packages |
|---|---|---|
| Root | `sternwarte` → `lokyy-brain` | pnpm@9.0.0, TypeScript 5.5.0 |
| `server` | `server` → `@lokyy/server` | Hono 4.6.0, @hono/node-server 1.13.0, tsx |
| `pwa` | `pwa` → `@lokyy/pwa` | Vite 5.4.0, React 18.3.0, CM6 6.x, vite-plugin-pwa 0.20.0 |
| `packages/shared` | `@sternwarte/shared` → `@lokyy/shared` | TypeScript-only types |

**New Workspaces (to create):**

| Workspace | Name | Purpose |
|---|---|---|
| `packages/core` | `@lokyy/core` | Shared service layer (git, notes, graph, pipes, memory) |
| `mcp` | `@lokyy/mcp` | MCP server, imports directly from @lokyy/core |

### Technology Stack (Confirmed)

**Language & Runtime:**
- TypeScript strict mode across all workspaces
- Node.js runtime (server + mcp); Bun as preferred package manager runner
- Build: `tsc` for server/core/mcp; Vite for PWA

**New Packages — Verified Versions:**

| Package | Version | Workspace | Purpose |
|---|---|---|---|
| `ulid` | 3.0.2 | core | Note ID generation |
| `gray-matter` | 4.0.3 | core | Frontmatter parse/serialize |
| `ajv` | 8.20.0 | core | JSON schema validation |
| `pg` | 8.20.0 | core | Postgres client |
| `pgvector` | 0.2.1 | core | pgvector Node.js integration |
| `@modelcontextprotocol/sdk` | 1.29.0 | core + mcp | MCP SDK |
| `node-cron` | 4.2.1 | mcp | Consolidation Agent scheduler |
| `bcryptjs` | 3.0.3 | server | Password hashing |
| `react-force-graph` | 1.48.2 | pwa | Knowledge graph visualization |
| `idb` | 8.0.3 | pwa | IndexedDB offline layer |
| `drizzle-orm` | 0.45.2 | core | Schema-as-code + Query Builder |
| `drizzle-kit` | 0.45.x | core | Migration CLI |
| `@tanstack/react-query` | 5.100.10 | pwa | Server State Management |
| `zustand` | 5.0.13 | pwa | UI State Management |
| `zod` | 3.25.x | server | HTTP input validation in route handlers |
| `micromatch` | 4.0.8 | core | Glob pattern matching in scope-resolver |

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
- Session management strategy — server-side sessions with Postgres `sessions` table
- Vault isolation enforcement — URL-segment routing + Hono middleware
- Database migration tooling — drizzle-orm schema-as-code
- Setup Wizard implementation — web-based wizard mode

**Important Decisions (Shape Architecture):**
- Frontend state split — TanStack Query (server state) + Zustand (UI state)
- Real-time updates — SSE (not WebSocket) for pipes + agent progress
- Error type contract — typed error shape across all layers

**Deferred Decisions (Post-v1):**
- API versioning — no versioning in v1 (internal PWA + MCP only consumers)
- Response caching — no cache layer in v1
- Distributed tracing / structured logging — v1 uses console logging

---

### Data Architecture

**Schema Migration: drizzle-orm@0.45.2 + drizzle-kit@0.45.x**

- Schema defined in `packages/core/src/db/schema.ts` (TypeScript, Drizzle table definitions)
- Migration files generated by `drizzle-kit generate`, applied at server start
- Postgres tables: `users`, `vaults`, `vault_memberships`, `sessions`, `note_embeddings`
- pgvector column on `note_embeddings`: `embedding vector(768)` with HNSW index
  (`CREATE INDEX ... USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)`)
- `packages/core` owns DB client singleton (`pg.Pool`) + Drizzle instance; server + mcp import from `@lokyy/core`

**Vault Schema (core tables):**
```sql
users             (id TEXT PK,  email TEXT UNIQUE, password_hash TEXT, created_at TIMESTAMPTZ)
vaults            (id TEXT PK,  name TEXT, forgejo_repo_url TEXT, owner_id TEXT FK, type TEXT)
vault_memberships (user_id TEXT FK, vault_id TEXT FK, role TEXT,
                   PRIMARY KEY(user_id, vault_id))
sessions          (id TEXT PK,  user_id TEXT FK, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ)
note_embeddings   (note_id TEXT, vault_id TEXT FK, embedding vector(768), updated_at TIMESTAMPTZ,
                   PRIMARY KEY(note_id, vault_id))
```

**Caching: None in v1**
- Auth lookups and note queries are small-volume; no cache layer introduced
- Re-evaluated if vault sizes exceed 10k notes (Tier 1 index already covers hot paths)

---

### Authentication & Security

**Session Management: Server-side sessions (Postgres-backed)**

- Rationale: vault-isolation middleware requires server-side user+vault context per request;
  immediate session revocation required when vault membership changes; stateless JWT would
  require blocklist anyway — no advantage over server sessions here
- Session token stored as HttpOnly, Secure, SameSite=Strict cookie
- Hono middleware reads session from cookie → validates against `sessions` table → attaches
  `{ userId, role }` to Hono context
- Session TTL: 30 days, sliding window on activity

**Vault Isolation: URL-segment + Hono middleware**

- All vault-scoped routes: `/api/vaults/:vaultId/notes`, `/api/vaults/:vaultId/search`, etc.
- `vaultMiddleware` verifies:
  1. Valid session (userId present)
  2. `vault_memberships` row for (userId, vaultId) exists
  3. Required role for operation (read vs. write vs. admin) satisfied
- Vault isolation is the last middleware before route handler — no route handler may skip it
- Client claims about vaultId are never trusted; enforcement is purely server-side

**MCP Scope Enforcement (separate layer):**

- MCP server reads `00_meta/mcp-scopes.yaml` at startup; scope map loaded once into memory
- Each MCP tool call validates `path` against the agent's allowed globs (`micromatch`)
- Scope violations return `VaultPermissionError` — not surfaced as git error

**Error Type Hierarchy:**
```typescript
FrontmatterValidationError  // pre-commit hook failure; includes field + schema path
GitConflictError            // pull --rebase conflict during push
VaultPermissionError        // insufficient vault role or MCP scope violation
OfflineQueueError           // IndexedDB save queue failure
EmbeddingUnavailableError   // Ollama/nomic-embed-text unreachable (non-fatal, Tier 1 fallback)
```

All error responses: `{ "error": "ErrorType", "message": "...", "details"?: unknown }`

---

### API & Communication Patterns

**REST API (Hono) — Vault-scoped Routes:**
```
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/vaults                          # list user's vaults
POST   /api/vaults                          # create vault

GET    /api/vaults/:vaultId/notes           # list notes (Tier 1 index)
POST   /api/vaults/:vaultId/notes           # create note
GET    /api/vaults/:vaultId/notes/:id       # get note
PUT    /api/vaults/:vaultId/notes/:id       # save note
DELETE /api/vaults/:vaultId/notes/:id       # delete note
GET    /api/vaults/:vaultId/tree            # folder tree
POST   /api/vaults/:vaultId/search          # Tier 1+2 search
GET    /api/vaults/:vaultId/graph           # wikilink graph

POST   /api/vaults/:vaultId/pipes           # enqueue pipe job
GET    /api/vaults/:vaultId/pipes/sse       # SSE stream for job status
GET    /api/vaults/:vaultId/pipes/:jobId    # job status (polling fallback)

GET    /api/setup/status                    # wizard mode check
POST   /api/setup/init                      # complete setup wizard
```

**Real-time: SSE (not WebSocket)**

- Hono `streamSSE()` for pipe job status + Consolidation Agent progress
- PWA connects to SSE endpoint after enqueue; falls back to polling if SSE unavailable
- No persistent connection required; SSE is request-scoped, no socket upgrade

**API Versioning: None in v1**
- Consumers are the PWA (co-deployed) and the MCP server (same monorepo)
- Versioning introduced when external third-party API consumers are planned

---

### Frontend Architecture

**State Split:**

| Layer | Tool | Version | Scope |
|---|---|---|---|
| Server state | @tanstack/react-query | 5.100.10 | Note fetching, mutations, offline retry |
| UI state | Zustand | 5.0.13 | Panel visibility, active note path, editor state |

**Rationale:**
- React Query handles background refetch, stale-while-revalidate, and mutation retry —
  maps directly to the offline save queue (failed mutations re-queued via `idb@8.0.3`)
- Zustand for ephemeral UI state that does not require server synchronization

**Offline Layer:**

- React Query `mutationCache` + `persistQueryClient` → IndexedDB via `idb`
- Failed note saves serialized to IndexedDB queue; replayed on reconnect
- Conflict: `git pull --rebase` failure during replay → surfaced as `GitConflictError` in UI

**CM6 Editor:**

- CM6 state managed locally within editor component (CM6's own EditorState/EditorView)
- On save: React Query mutation → PUT `/api/vaults/:vaultId/notes/:id`
- Autosave: debounced 2s, only if content changed (EditorState equality check)

---

### Infrastructure & Deployment

**Primary: Docker Compose**

`docker-compose.yml` (project root) defines four services:
- `lokyy-brain` — Hono API server + MCP server (same Node.js process or separate; decided in Epic 5)
- `forgejo` — Forgejo instance (ports 3000 HTTP + 22 SSH)
- `postgres` — PostgreSQL 16 with pgvector extension pre-installed
- `ollama` — Ollama with nomic-embed-text model

All services on a named bridge network; named volumes for Forgejo repositories + Postgres data.

**Setup Wizard: Web-based (single-page, server mode)**

- Server detects "setup required": empty `users` table or `SETUP_COMPLETE` env flag absent
- In setup mode: serves wizard at `/setup`; all other routes redirect to `/setup`
- Wizard steps: (1) Forgejo connection test, (2) Postgres connection test, (3) Ollama test,
  (4) Admin account creation, (5) First vault initialization
- On completion: admin user written to DB, `SETUP_COMPLETE=true` persisted, server exits setup mode
- Idempotent: re-runnable; re-setup updates config without dropping user data

**Logging: Console (v1)**
- Structured JSON lines via `console.log/error` in production mode
- Docker Compose log driver handles aggregation; no external logging service in v1

**Environment Configuration:**
```
DATABASE_URL        # postgres://...
FORGEJO_URL         # https://forgejo.example.com
FORGEJO_TOKEN       # admin API token
OLLAMA_URL          # http://ollama:11434
SESSION_SECRET      # 32-byte random hex
SETUP_COMPLETE      # true after wizard completes
PORT                # default 3000
```

---

### Decision Impact Analysis

**Implementation Sequence (Entscheidungen bestimmen Epic-Reihenfolge):**

1. `packages/core` mit Drizzle-Schema + Migrations → Fundament für Auth (Epic 2)
2. Server-side sessions + `vaultMiddleware` → blockiert alle geschützten Routes (Epic 2)
3. Vault-scoped Route-Struktur → PWA und MCP können parallel entwickelt werden (Epic 3+)
4. Docker Compose + Setup Wizard → erste lauffähige Installation (Epic 2, letzter Schritt)
5. React Query + Zustand Setup in PWA → Fundament vor CM6-Integration (Epic 7)

**Cross-Component Dependencies:**

- `packages/core` exportiert: DB-Client (pg.Pool + Drizzle), Error-Types, gitService,
  notesService, graphService, pipeQueue, MemoryProvider, MCP-Scope-Resolver
- `server` importiert ausschließlich aus `@lokyy/core` — keine eigene Servicelogik
- `mcp` importiert ausschließlich aus `@lokyy/core` — kein HTTP zwischen mcp und server
- `pwa` importiert ausschließlich aus `@lokyy/shared` — nur Types, keine Core-Services im Browser
- `vaultMiddleware` in `server` ist der einzige Ort, wo `vault_memberships` geprüft wird
- MCP Scope-Resolver in `mcp` ist der einzige Ort, wo `mcp-scopes.yaml` gelesen wird

## Implementation Patterns & Consistency Rules

### Identified Conflict Points

9 areas where parallel AI agents would make different choices without explicit rules.
All patterns below are MANDATORY for every agent working on this codebase.

---

### Naming Patterns

**Database (Drizzle schema in `packages/core/src/db/schema.ts`):**
- Tables: `plural_snake_case` — `users`, `vaults`, `vault_memberships`, `note_embeddings`
- Columns: `snake_case` — `user_id`, `created_at`, `forgejo_repo_url`
- Foreign keys: `{referenced_table_singular}_id` — `user_id`, `vault_id`
- Indexes: `idx_{table}_{column(s)}` — `idx_note_embeddings_vault_id`
- ULID primary keys stored as `TEXT`, never UUID type

**API Endpoints (Hono routes in `server/src/routes/`):**
- Resources: plural noun — `/vaults`, `/notes`, `/pipes`
- Vault-scoped: `/api/vaults/:vaultId/{resource}` — never flat `/api/notes`
- Actions (non-CRUD): noun+verb suffix — `/pipes/sse`, `/setup/init`
- Route params: `:camelCase` — `:vaultId`, `:noteId`
- Query params: `camelCase` — `?includeArchived=true`

**TypeScript Code:**
- Files: `kebab-case.ts` — `git-service.ts`, `vault-middleware.ts`
- React components: `PascalCase.tsx` — `FileTree.tsx`, `NoteEditor.tsx`
- Functions: `camelCase` verbs — `getUserById`, `validateFrontmatter`, `buildGraph`
- Types/Interfaces: `PascalCase` — `Note`, `VaultMembership`, `MaybeError`
- Constants: `SCREAMING_SNAKE_CASE` — `MAX_ITERATIONS`, `SESSION_TTL_MS`
- Zustand stores: `use{Name}Store` — `useVaultStore`, `useEditorStore`
- React Query keys: `[resource, id?]` arrays — `['notes', vaultId]`, `['note', vaultId, noteId]`

---

### Structure Patterns

**Monorepo Workspace Layout:**
```
packages/core/src/
  db/
    schema.ts         # Drizzle table definitions (single file)
    migrations/       # drizzle-kit generated, never hand-edited
    client.ts         # pg.Pool singleton + Drizzle instance export
  services/
    git-service.ts
    notes-service.ts
    graph-service.ts
    pipe-queue.ts
  memory/
    memory-provider.ts  # MemoryProvider interface
    tier1-index.ts
    tier2-embeddings.ts
  mcp/
    scope-resolver.ts
  errors.ts           # ALL error types defined here, exported from index
  index.ts            # explicit named exports only — no barrel re-export of everything

server/src/
  middleware/
    session.ts        # session validation
    vault.ts          # vaultMiddleware (vault isolation)
  routes/
    auth.ts
    vaults.ts
    notes.ts
    search.ts
    graph.ts
    pipes.ts
    setup.ts
  index.ts            # Hono app + route registration only

pwa/src/
  features/           # feature-based, not type-based
    editor/           # CM6 editor + autosave + offline queue
    file-tree/        # FileTree component + tree state
    graph/            # react-force-graph view
    pipes/            # ImportPanel + SSE client
    vault/            # vault selector + RBAC context
    setup/            # Setup Wizard screens
  stores/             # Zustand stores
  api/                # React Query hooks + fetch wrappers (no raw fetch outside api/)
  theme.ts
  App.tsx
```

**Test Placement:**
- Co-located with source: `git-service.test.ts` next to `git-service.ts`
- Integration tests only for `packages/core` services (DB-touching code)
- No mocking of `packages/core` services in `server` tests — use real DB (test DB instance)
- PWA: Vitest + React Testing Library; no browser tests in v1

---

### Format Patterns

**API Response Format:**

Success → direct object (no wrapper):
```typescript
// GET /api/vaults/:vaultId/notes/:id
{ id: "01HX...", title: "My Note", content: "...", frontmatter: {...} }

// GET /api/vaults/:vaultId/notes
{ notes: [...], total: 42 }   // arrays always in named key, never bare array
```

Error → typed object:
```typescript
{ "error": "FrontmatterValidationError", "message": "...", "details"?: unknown }
```

HTTP status codes:
- `200` — successful GET/PUT
- `201` — successful POST (created)
- `204` — successful DELETE (no body)
- `400` — validation error (FrontmatterValidationError, bad input)
- `401` — unauthenticated (no valid session)
- `403` — unauthorized (VaultPermissionError, wrong role)
- `409` — conflict (GitConflictError)
- `503` — upstream unavailable (Forgejo/Ollama unreachable)

**JSON Field Naming:** `camelCase` in all API responses and request bodies.
Drizzle returns snake_case from DB — convert at the service boundary in `packages/core`.

**Date/Time Format:** ISO 8601 strings everywhere in API — `"2026-05-14T15:00:00Z"`.
Never Unix timestamps in API responses; formatting for display happens in PWA only.

**ULID Representation:** Plain string, always 26 characters uppercase — `"01JXYZ123456789012345678AB"`.

---

### Communication Patterns

**No Event Bus.** lokyy-brain uses direct function calls and React Query mutations.
No pub/sub, no EventEmitter between services — call the function, return the result.

**SSE Payload Shape:**
```typescript
// All SSE events from /pipes/sse or agent progress:
{ event: "job.progress" | "job.complete" | "job.error", data: { jobId: string, ...payload } }
```

**State Management Rules (PWA):**
- React Query: all server data (notes, vaults, search results, pipe jobs)
  — never store server data in Zustand
- Zustand: ephemeral UI state only (active note path, panel open/closed, editor scroll position)
  — never store server-fetched data in Zustand

**gitService Concurrency Contract:**
- All writes (save, remove, move) go through the promise-lock in gitService
- No caller bypasses the lock — even internal callers in packages/core
- Consolidation Agent does NOT get a priority queue — it waits in the same lock queue

---

### Process Patterns

**Error Handling — The Three Zones:**

```
Zone 1 — packages/core:   THROW typed errors (FrontmatterValidationError etc.)
Zone 2 — server routes:   CATCH, map to HTTP status + error JSON, LOG with console.error
Zone 3 — pwa:             CATCH from React Query, display user-facing message, never re-throw
```

Errors are THROWN in Zone 1, CAUGHT once in Zone 2 (server) and Zone 3 (PWA).
No double-catching. No swallowed errors. No `catch(e) {}` without `console.error`.

**Fire-and-Forget Index Sync (Tier 2 pgvector):**
```typescript
// After every successful gitService.save():
syncEmbeddings(vaultId, noteId).catch((e) =>
  console.error("[tier2] embedding sync failed", { vaultId, noteId, error: e })
);
// Never await. Never block the save response.
```

**Loading States (PWA):**
- Use React Query's `isPending` / `isFetching` — never hand-rolled `isLoading` booleans in Zustand
- Skeleton UI for note list; spinner for save mutation; no blocking full-page spinners

**Validation Timing:**
- Frontmatter validated in `notesService.saveNote()` BEFORE calling gitService (Zone 1)
- HTTP input validated in Hono route handler via Zod schema BEFORE calling service (Zone 2)
- No validation in gitService — it trusts its callers

**Autosave Debounce (PWA):**
```
CM6 onChange → debounce 2000ms → check content changed → PUT /notes/:id
```
Never fire save on mount, focus, or blur — only on content change after debounce.

---

### Enforcement Guidelines

**All AI Agents MUST:**
- Use `packages/core/src/errors.ts` for ALL error type definitions — never define new error
  types in `server`, `mcp`, or `pwa`
- Return camelCase JSON from all API endpoints — convert at service layer, not in route handler
- Import from `@lokyy/core` in `server` and `mcp` — never copy service logic across packages
- Use the vault-scoped route structure — never add flat routes for vault data
- Co-locate tests with source files — never create a top-level `__tests__/` directory
- Use `console.error` with structured context for all caught errors — never silent catch

**Pattern Violations to Flag in Code Review:**
- Any `try/catch` without a `console.error` call → silent failure
- Any Zustand state that mirrors React Query data → state duplication
- Any `fetch()` call outside `pwa/src/api/` → untracked server call
- Any service logic in `server/src/routes/` → packages/core extraction required
- Any write to the vault filesystem that does not go through `gitService` → hard constraint violation

## Project Structure & Boundaries

### Complete Project Directory Structure

```
lokyy-brain/                         # pnpm workspace root
├── package.json                     # workspaces: ["packages/*", "server", "pwa", "mcp"]
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json               # strict: true, shared TS config
├── docker-compose.yml               # lokyy-brain + forgejo + postgres + ollama
├── .env.example                     # DATABASE_URL, FORGEJO_URL, FORGEJO_TOKEN, OLLAMA_URL, ...
├── .gitignore
├── CLAUDE.md
├── README.md
│
├── packages/
│   ├── shared/                      # @lokyy/shared — types only
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── types.ts             # Note, Vault, VaultMembership, PipeJob, GraphNode
│   │
│   └── core/                        # @lokyy/core — all service logic
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts             # explicit named exports (no barrel re-export)
│           ├── errors.ts            # FrontmatterValidationError, GitConflictError,
│           │                        # VaultPermissionError, OfflineQueueError,
│           │                        # EmbeddingUnavailableError
│           ├── db/
│           │   ├── schema.ts        # Drizzle: users, vaults, vault_memberships,
│           │   │                    #          sessions, note_embeddings
│           │   ├── client.ts        # pg.Pool singleton + drizzle(pool) export
│           │   └── migrations/      # drizzle-kit generated — never hand-edited
│           ├── services/
│           │   ├── git-service.ts        # ensureRepo, pull, save, remove, move + promise-lock
│           │   ├── git-service.test.ts
│           │   ├── notes-service.ts      # createNote, saveNote, getNote, listNotes,
│           │   │                         # deleteEntry, moveEntry, getTree
│           │   ├── notes-service.test.ts
│           │   ├── graph-service.ts      # parseLinks, parseTags, buildGraph
│           │   ├── graph-service.test.ts
│           │   ├── pipe-queue.ts         # registerHandler, enqueue, listJobs, detectType
│           │   ├── pipe-queue.test.ts
│           │   └── pipes/
│           │       └── handlers/
│           │           ├── youtube-handler.ts
│           │           ├── scrape-handler.ts
│           │           └── crawl-handler.ts
│           ├── memory/
│           │   ├── memory-provider.ts    # MemoryProvider interface (search, index, related)
│           │   ├── tier1-index.ts        # wikilink + tag + full-text index
│           │   ├── tier1-index.test.ts
│           │   ├── tier2-embeddings.ts   # nomic-embed-text via Ollama → pgvector
│           │   └── tier2-embeddings.test.ts
│           ├── mcp/
│           │   ├── scope-resolver.ts     # reads mcp-scopes.yaml, validates path globs
│           │   └── scope-resolver.test.ts
│           └── auth/
│               ├── session.ts            # createSession, validateSession, deleteSession
│               ├── session.test.ts
│               └── password.ts           # hashPassword, verifyPassword (bcryptjs)
│
├── server/                          # @lokyy/server — Hono API only
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                 # Hono app init + middleware registration + route mounting
│       ├── middleware/
│       │   ├── session.ts           # reads session cookie → attaches { userId } to context
│       │   └── vault.ts             # vaultMiddleware: verifies vault_memberships + role
│       └── routes/
│           ├── auth.ts              # POST /login, POST /logout, GET /me
│           ├── vaults.ts            # GET /vaults, POST /vaults
│           ├── notes.ts             # CRUD /vaults/:vaultId/notes
│           ├── search.ts            # POST /vaults/:vaultId/search
│           ├── graph.ts             # GET /vaults/:vaultId/graph
│           ├── pipes.ts             # POST /pipes, GET /pipes/sse, GET /pipes/:jobId
│           └── setup.ts             # GET /setup/status, POST /setup/init
│
├── mcp/                             # @lokyy/mcp — MCP server
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                 # stdio transport entry point
│       ├── server.ts                # McpServer init + tool registration
│       ├── tools/
│       │   ├── search-vault.ts      # search_vault tool (Tier 1+2)
│       │   ├── related-notes.ts     # related_notes tool
│       │   ├── read-note.ts         # read_note tool
│       │   ├── write-note.ts        # write_note tool (scope-checked)
│       │   ├── get-tree.ts          # get_tree tool
│       │   └── trigger-import.ts    # trigger_import tool
│       └── consolidation/
│           ├── agent.ts             # consolidation loop: evaluator + writer + upper-bound guard
│           ├── agent.test.ts
│           ├── scheduler.ts         # node-cron schedule → agent.run()
│           └── intervention-writer.ts  # SPEC-valid writes to 70_pai/interventions/
│
└── pwa/                             # @lokyy/pwa — Vite SPA + PWA
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts               # vite-plugin-pwa config + React plugin
    ├── index.html
    └── src/
        ├── main.tsx                 # React root + QueryClient + router
        ├── App.tsx                  # three-panel layout: FileTree | NoteEditor | GraphView
        ├── theme.ts                 # color tokens (terracotta, gold, dark bg palette)
        ├── api/                     # React Query hooks (all fetch calls live here)
        │   ├── notes.ts             # useNote, useNotes, useSaveNote, useCreateNote
        │   ├── vaults.ts            # useVaults, useCreateVault
        │   ├── search.ts            # useSearch
        │   ├── pipes.ts             # usePipeJob, useEnqueuePipe
        │   └── auth.ts              # useMe, useLogin, useLogout
        ├── stores/                  # Zustand stores (UI state only)
        │   ├── vault-store.ts       # activeVaultId, setActiveVault
        │   └── editor-store.ts      # activeNotePath, panelState, scrollPosition
        ├── features/
        │   ├── editor/
        │   │   ├── NoteEditor.tsx        # CM6 EditorView wrapper
        │   │   ├── autosave.ts           # debounced 2000ms → useSaveNote mutation
        │   │   ├── offline-queue.ts      # idb queue + replay on reconnect
        │   │   └── extensions/
        │   │       ├── wikilink-extension.ts
        │   │       └── live-preview-extension.ts
        │   ├── file-tree/
        │   │   └── FileTree.tsx
        │   ├── graph/
        │   │   └── GraphView.tsx         # react-force-graph wrapper
        │   ├── pipes/
        │   │   ├── ImportPanel.tsx        # slide-over Pipes inbox
        │   │   └── sse-client.ts          # SSE connection + job status updates
        │   ├── vault/
        │   │   └── VaultSelector.tsx      # vault switcher + RBAC context
        │   └── setup/
        │       ├── SetupWizard.tsx
        │       └── steps/
        │           ├── ForgejoStep.tsx
        │           ├── PostgresStep.tsx
        │           ├── OllamaStep.tsx
        │           ├── AdminAccountStep.tsx
        │           └── VaultInitStep.tsx
        └── public/
            ├── manifest.webmanifest
            └── icons/               # PWA icons (192×192, 512×512)
```

---

### Architectural Boundaries

**API Boundaries:**

| Boundary | Direction | Protocol | Auth Required |
|---|---|---|---|
| PWA → server | Outbound | HTTP/JSON REST | Session cookie |
| MCP client → mcp server | Inbound | stdio (MCP SDK) | MCP scope from yaml |
| server → Forgejo | Outbound | HTTP API + git CLI | FORGEJO_TOKEN |
| server → Postgres | Outbound | pg.Pool | DATABASE_URL |
| server → Ollama | Outbound | HTTP (Ollama API) | None (local) |
| Consolidation Agent → vault | Internal | @lokyy/core directly | MCP scope (agent scope) |

**Workspace Import Graph (enforced via tsconfig paths):**
```
@lokyy/shared    →  no imports from other workspaces
@lokyy/core      →  imports from @lokyy/shared only
@lokyy/server    →  imports from @lokyy/core + @lokyy/shared only
@lokyy/mcp       →  imports from @lokyy/core + @lokyy/shared only
@lokyy/pwa       →  imports from @lokyy/shared only (NO @lokyy/core in browser)
```

**Data Boundaries:**
- Vault `.md` files: written only via `gitService.save()` in `@lokyy/core`
- Postgres auth tables: read/written only via `@lokyy/core/auth/` and `@lokyy/core/db/`
- pgvector embeddings: written only via `tier2-embeddings.ts` (fire-and-forget after git commit)
- IndexedDB offline queue: read/written only via `pwa/src/features/editor/offline-queue.ts`
- MCP scope config: read only via `@lokyy/core/mcp/scope-resolver.ts`

---

### Requirements to Structure Mapping

**Epic 1 — Rename + Vault Setup:**
- `package.json` (root + all workspaces) → rename `sternwarte` → `lokyy-brain`, `@sternwarte/` → `@lokyy/`
- `docker-compose.yml` → Forgejo service definition
- `.env.example` → all required vars

**Epic 2 — Core Refactor + Auth + Setup Wizard:**
- `packages/core/src/` → service migrations from `server/src/`
- `packages/core/src/db/schema.ts` → Drizzle schema (users, vaults, vault_memberships, sessions)
- `packages/core/src/auth/` → session.ts, password.ts
- `server/src/middleware/` → session.ts, vault.ts
- `server/src/routes/auth.ts` + `vaults.ts` + `setup.ts`
- `pwa/src/features/setup/` → SetupWizard + 5 steps

**Epic 3 — Memory Layer Tier 1+2:**
- `packages/core/src/memory/memory-provider.ts` → MemoryProvider interface
- `packages/core/src/memory/tier1-index.ts` + `tier2-embeddings.ts`
- `packages/core/src/db/schema.ts` → `note_embeddings` table + HNSW index migration
- `server/src/routes/search.ts` → POST /vaults/:vaultId/search

**Epic 4 — Consolidation Agent:**
- `mcp/src/consolidation/agent.ts` → loop + evaluator + upper-bound guard
- `mcp/src/consolidation/scheduler.ts` → node-cron
- `mcp/src/consolidation/intervention-writer.ts` → SPEC-valid writes
- `pwa/src/features/pipes/` → review UI (accept/reject/ignore interventions)

**Epic 5 — MCP Server:**
- `mcp/src/index.ts` → stdio transport
- `mcp/src/tools/` → 6 scoped tools
- `packages/core/src/mcp/scope-resolver.ts` → mcp-scopes.yaml parser

**Epic 7 — Remaining PWA:**
- `pwa/src/features/graph/GraphView.tsx` → react-force-graph
- `pwa/src/features/editor/offline-queue.ts` → idb save queue + replay
- `pwa/src/stores/` → Zustand stores
- `pwa/src/api/` → React Query hooks

**Cross-Cutting Concerns:**
- Error types: `packages/core/src/errors.ts` — referenced everywhere
- Frontmatter validation: `packages/core/src/services/notes-service.ts` (Zone 1)
- Git serialization: `packages/core/src/services/git-service.ts` — promise-lock
- Tier 2 sync: fire-and-forget in `notes-service.ts` after `gitService.save()`

---

### Integration Points & Data Flows

**Note Save Flow:**
```
PWA editor
  → debounce 2000ms
  → React Query mutation (PUT /api/vaults/:vaultId/notes/:id)
  → session middleware (cookie → userId)
  → vaultMiddleware (userId + vaultId → role check)
  → notesService.saveNote() (frontmatter validate → gitService.save() via lock)
  → git add + commit + pull --rebase + push → Forgejo
  → [async fire-and-forget] tier2-embeddings.syncEmbeddings()
  → 200 response to PWA
```

**Semantic Search Flow:**
```
PWA search input
  → React Query query (POST /api/vaults/:vaultId/search)
  → vaultMiddleware
  → MemoryProvider.search()
      → Tier 1: graphService (wikilinks + tags + full-text)
      → Tier 2: pgvector cosine similarity (HNSW, nomic-embed-text 768-dim)
  → Merged ranked results → 200 response
```

**Consolidation Agent Flow:**
```
node-cron scheduler (nightly)
  → agent.run(vaultId, lastRunMarker from 70_pai/memory/)
  → read changed notes since lastRun (notesService.listNotes + lastModified)
  → evaluator: are there unconsolidated notes? (loop condition)
  → for each note batch:
      → LLM call (via MCP tool) → suggested wikilinks + topic notes + interventions
      → scope-resolver validates paths
      → intervention-writer: SPEC-valid frontmatter + gitService.save() via lock
      → update lastRun marker in 70_pai/memory/
  → upper-bound guard: max-iterations + max-runtime enforced at loop level
```

---

### Build & Development Workflow

**Build Order (pnpm -r build):**
1. `@lokyy/shared` — types only
2. `@lokyy/core` — tsc, depends on shared
3. `@lokyy/server` — tsc, depends on core
4. `@lokyy/mcp` — tsc, depends on core
5. `@lokyy/pwa` — Vite, depends on shared

**Dev Setup:**
```bash
docker-compose up -d postgres ollama forgejo
pnpm --filter @lokyy/core build
pnpm --filter server dev          # tsx watch
pnpm --filter pwa dev             # Vite HMR
```

**Drizzle Migrations:**
```bash
pnpm --filter @lokyy/core drizzle-kit generate   # schema → SQL
pnpm --filter @lokyy/core drizzle-kit migrate    # apply to DB
```
Server applies pending migrations automatically at startup.

## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:**
All technology choices are mutually compatible. drizzle-orm uses pg as its Postgres adapter
(same pg@8.20.0 in packages/core). pgvector Node.js integration requires pg — no conflict.
TanStack Query v5 supports React 16–19; zustand v5 is React-version-agnostic.
vite-plugin-pwa 0.20.0 is the correct version for Vite 5.x.
react-force-graph 1.48.2 uses three.js internally and is compatible with React 18.

**Pattern Consistency:**
- Naming conventions (snake_case DB, camelCase TS/API) are consistent across all layers
- Error Zone model (throw → catch once → surface to client) aligns with Hono middleware structure
- Fire-and-forget sync pattern is architecturally consistent with the "Forgejo-first" constraint
- SSE pattern for real-time aligns with Hono's native `streamSSE()` support

**Structure Alignment:**
- Import graph (shared ← core ← server/mcp, shared ← pwa) is enforceable via tsconfig paths
- All vault-data routes are vault-scoped — no flat routes in the structure
- vaultMiddleware placement (last middleware before route handler) is consistent across all routes
- packages/core owns all DB logic — server routes contain zero service logic

---

### Requirements Coverage Validation ✅

**FR Cluster Coverage:**

1. **Vault I/O (FR7–14, FR25–30, FR44–47):**
   gitService promise-lock + notesService SPEC-valid writes + FrontmatterValidationError ✅

2. **Knowledge Retrieval (FR15–19):**
   MemoryProvider interface + tier1-index (wikilinks/tags/full-text) +
   tier2-embeddings (nomic-embed-text/pgvector HNSW) + search route ✅

3. **Identity & Access (FR38–43, FR28, FR42):**
   session middleware + vaultMiddleware (vault_memberships + role) +
   scope-resolver (mcp-scopes.yaml, micromatch globs, default deny) ✅

4. **Autonomous Operation (FR31–37):**
   Consolidation Agent (agent.ts loop + scheduler.ts + intervention-writer.ts) +
   upper-bound guard (max-iterations + max-runtime) + Review UI in pwa/features/pipes/ ✅

**NFR Coverage:**

| NFR | Architectural Solution | Status |
|---|---|---|
| Search p95 < 500ms | pgvector HNSW (m=16, ef_construction=64), 768-dim, Tier 1 fallback | ✅ |
| Note save < 3s | promise-lock sequential — convoy risk acceptable at single-user install scale | ✅ |
| Editor responsive during sync | tier2 sync fire-and-forget; never awaited in save path | ✅ |
| Offline queue integrity | idb@8.0.3 + React Query mutationCache + explicit replay-state | ✅ |
| Vault isolation server-side | vaultMiddleware on every vault-scoped route | ✅ |
| MCP scope server-side | scope-resolver reads yaml at startup; no runtime expansion | ✅ |
| Consolidation Agent upper bound | max-iterations + max-runtime guard in agent.ts loop | ✅ |
| Graceful Ollama degradation | EmbeddingUnavailableError caught; Tier 1 always available | ✅ |

---

### Implementation Readiness Validation ✅

**Decision Completeness:**
All critical decisions documented with verified package versions.
Two packages (zod, micromatch) added during validation; drizzle-kit version pinned to 0.45.2.

**Structure Completeness:**
Complete file tree defined across all 5 workspaces (shared, core, server, mcp, pwa).
All route files, middleware, feature directories, and stores specified.
Drizzle migration workflow documented; build order explicit.

**Pattern Completeness:**
All 9 identified conflict points addressed. Three Zones error model documented with examples.
Fire-and-forget pattern specified with code snippet. Autosave debounce contract explicit.

---

### Gap Analysis Results

**Critical Gaps:** None

**Important Gaps (resolved in this validation step):**
- `zod` missing from packages table → added (3.25.x, server workspace)
- `micromatch` missing from packages table → added (4.0.8, core workspace)
- `drizzle-kit` version vague ("0.45.x") → pinned to 0.45.2

**Nice-to-Have (deferred, not blocking):**
- CORS configuration for Hono (relevant when PWA served from different origin than server)
- Rate limiting on POST /api/auth/login (pre-public-launch hardening)
- Structured logging library (Pino) — v1 uses console; upgrade path is non-breaking

---

### Architecture Completeness Checklist

**Requirements Analysis**
- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed (High — 8 domains, 13 subsystems)
- [x] Technical constraints identified (Forgejo-truth, AGPL, no Next.js, Ollama-only)
- [x] Cross-cutting concerns mapped (7 concerns documented)

**Architectural Decisions**
- [x] Critical decisions documented with versions (15 verified packages total)
- [x] Technology stack fully specified (all workspaces, build tooling, runtime)
- [x] Integration patterns defined (6 API boundaries, import graph, data boundaries)
- [x] Performance considerations addressed (HNSW params, p95 targets, convoy analysis)

**Implementation Patterns**
- [x] Naming conventions established (DB, API, TypeScript, React Query keys)
- [x] Structure patterns defined (feature-based PWA, co-located tests, workspace layout)
- [x] Communication patterns specified (no event bus, SSE shape, gitService contract)
- [x] Process patterns documented (Three Zones, fire-and-forget, validation timing, debounce)

**Project Structure**
- [x] Complete directory structure defined (all files across 5 workspaces)
- [x] Component boundaries established (import graph + data boundaries)
- [x] Integration points mapped (3 data flow diagrams)
- [x] Requirements to structure mapping complete (7 Epics → specific files)

---

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** High

**Key Strengths:**
- Brownfield foundation eliminates greenfield risk — gitService, notesService, CM6, pipeQueue
  are production-ready starting points requiring migration, not rebuild
- Single shared layer (@lokyy/core) eliminates service duplication between server and mcp
- Fire-and-forget Tier 2 sync ensures Forgejo-first guarantee is never violated by index failures
- Vault isolation at two independent layers (vaultMiddleware + MCP scope-resolver) — a bug in
  one layer cannot by itself violate vault isolation
- Error type hierarchy ensures PWA and MCP clients receive meaningful, actionable errors

**Areas for Future Enhancement:**
- Rate limiting on auth endpoints (pre-public-launch)
- Pino structured logging to replace console (non-breaking upgrade)
- CORS hardening for remote-server deployments
- Tier 3 temporal knowledge graph (Graphiti) — MemoryProvider interface accommodates it without rebuild

---

### Implementation Handoff

**AI Agent Guidelines:**
- Follow all architectural decisions exactly as documented — no deviation without architecture update
- Use the Enforcement Guidelines (Implementation Patterns section) as a code review checklist
- Respect the workspace import graph — tsconfig paths violations are build errors, not warnings
- Refer to data flow diagrams for any uncertainty about write paths or sync timing

**First Implementation Priority (Epic 1):**
```bash
# 1. Rename workspace packages (sternwarte → lokyy-brain, @sternwarte → @lokyy)
# 2. Create packages/core/package.json + tsconfig.json
# 3. Create mcp/package.json + tsconfig.json
# 4. Add tsconfig.base.json with strict: true + paths for @lokyy/* aliases
# 5. pnpm install
# Verify: pnpm -r build passes with empty index.ts in each new workspace
```
