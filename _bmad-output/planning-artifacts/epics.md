---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/architecture.md"
  - "_bmad-output/planning-artifacts/product-brief-lokyy-brain.md"
  - "_bmad-output/planning-artifacts/product-brief-lokyy-brain-distillate.md"
  - "docs/mockup/lokyy-brain-mockup.jsx"
  - "docs/mockup/README.md"
---

# lokyy-brain - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for lokyy-brain, decomposing the requirements from the PRD and Architecture decisions into implementable stories.

## Requirements Inventory

### Functional Requirements

**Installation & Setup**
- FR1: Admin can install the system via an interactive guided wizard without manually editing configuration files
- FR2: Admin can configure a new Forgejo repository as the vault through the Setup Wizard
- FR3: Admin can link an existing Forgejo repository as the vault through the Setup Wizard, with SPEC validation
- FR4: Admin can configure Postgres connection, Ollama endpoint, and vault URL through the Setup Wizard
- FR5: Admin can re-run the Setup Wizard without losing existing data
- FR6: Admin can change the vault URL in system settings after initial installation

**Note & Vault Management**
- FR7: User can create a new note with auto-generated schema-valid frontmatter (ULID, type, title, created timestamp)
- FR8: User can edit note content and frontmatter in a live-preview Markdown editor
- FR9: User can save notes to the vault via Git commit
- FR10: User can navigate the vault through a file tree organized by the vault folder structure
- FR11: User can rename or move a note without breaking existing wikilinks
- FR12: User can create and follow wikilinks between notes
- FR13: User can visualize note connections as an interactive graph
- FR14: User can create folders and organize notes within the vault structure

**Knowledge Discovery & Search**
- FR15: User can search notes by keywords, tags, and wikilinks
- FR16: User can find semantically related notes without exact keyword matches
- FR17: User can discover notes related to a currently viewed note
- FR18: AI agent can search the vault semantically via a dedicated MCP tool
- FR19: AI agent can discover related notes for a given note via a dedicated MCP tool

**Content Import (Pipes)**
- FR20: User can import YouTube video transcripts as capture notes
- FR21: User can import web page content as capture notes
- FR22: User can upload voice recordings for storage as capture notes
- FR23: User can view the status of active and completed import jobs
- FR24: AI agent can trigger a content import via a dedicated MCP tool

**AI Agent Integration (MCP)**
- FR25: AI agent can read notes within its defined scope
- FR26: AI agent can create and update notes with schema-valid frontmatter
- FR27: AI agent can retrieve the vault folder structure
- FR28: Each AI agent's read/write scope and commit prefix is defined per-agent in a vault configuration file
- FR29: Multiple AI agents can write to the vault concurrently without data conflicts
- FR30: Every AI agent write is traceable in the Git commit log with the agent's commit prefix

**Autonomous Knowledge Consolidation**
- FR31: System can run the Consolidation Agent on a configurable schedule
- FR32: Consolidation Agent can add missing wikilinks between related notes
- FR33: Consolidation Agent can create topic notes for recurring concepts across the vault
- FR34: Consolidation Agent can write discovered insights to a designated interventions folder
- FR35: User can review proposed Consolidation Agent interventions and accept, reject, or ignore each individually
- FR36: No Consolidation Agent write is committed to the vault without user review and acceptance
- FR37: Admin can trigger a Consolidation Agent run manually

**User & Access Management**
- FR38: Admin can create and manage user accounts
- FR39: Each user automatically has a private personal vault inaccessible to all other users
- FR40: Admin can create company vaults and assign users with read, write, or admin roles per vault
- FR41: User can authenticate with email and password
- FR42: Users can only access vaults for which they have been explicitly granted permission, enforced server-side
- FR43: Admin can revoke a user's access to a company vault without affecting their personal vault

**Offline & Synchronization**
- FR44: User can read and edit notes while offline
- FR45: User can save notes while offline; changes are queued automatically for later sync
- FR46: The PWA automatically replays queued saves in sequence on reconnection
- FR47: The system surfaces Git merge conflicts explicitly to the user rather than silently discarding changes

**Administration & Monitoring**
- FR48: Admin can view the availability status of all required services (Forgejo, Postgres, Ollama)
- FR49: Admin can view the Consolidation Agent's last-run timestamp and error log
- FR50: Admin can trigger a manual Consolidation Agent run from the admin interface
- FR51: System surfaces pre-commit hook frontmatter validation failures as a distinct error type, not a generic Git error

### NonFunctional Requirements

**Performance**
- NFR-P1: Semantic search (Tier 2) returns results in < 500ms for vaults up to 5,000 notes (p95)
- NFR-P2: Note save (including Git commit) completes in < 3 seconds under normal network conditions
- NFR-P3: The editor remains responsive during background index sync — no perceptible input lag
- NFR-P4: The knowledge graph renders and responds to interaction for vaults up to 5,000 notes without page freeze
- NFR-P5: YouTube Pipe import completes within 120 seconds for videos up to 60 minutes

**Security**
- NFR-S1: User passwords are hashed with bcrypt (cost factor ≥ 12); plaintext passwords are never stored or logged
- NFR-S2: Session tokens have a configurable lifetime (default: short) with refresh; expired tokens are rejected server-side
- NFR-S3: HTTPS is required in production; the application documents that a reverse proxy with TLS is mandatory
- NFR-S4: Personal vault data is never accessible to other users — enforced at the API layer on every request
- NFR-S5: MCP agent scope is enforced server-side; no client can expand its own permissions beyond mcp-scopes.yaml
- NFR-S6: Forgejo access tokens and secrets stored in env vars; never in API responses, logs, or vault commits
- NFR-S7: Content imported via Pipes is sanitized before being processed by the Consolidation Agent

**Data Integrity**
- NFR-D1: All write operations serialized through gitService with promise-lock; no direct filesystem writes bypass Git
- NFR-D2: The offline save queue never silently discards data; failed replay operations surface a distinct error
- NFR-D3: Pre-commit hook frontmatter validation failures halt the commit and return a typed error (not generic Git error)
- NFR-D4: Memory index sync failure never prevents note saves or server startup — fire-and-forget

**Reliability**
- NFR-R1: The Consolidation Agent has a hard execution time upper bound per run; it cannot run indefinitely
- NFR-R2: When Ollama is unavailable, read/write operations continue; Tier 2 search degrades gracefully
- NFR-R3: When Forgejo remote is temporarily unreachable, system operates offline; queued saves replay on reconnect
- NFR-R4: Database schema migrations are idempotent

**Accessibility**
- NFR-A1: The PWA meets WCAG 2.1 AA compliance level; accessibility AC defined explicitly per PWA story

### Additional Requirements (from Architecture)

- **Brownfield migration:** gitService, notesService, graphService, pipeQueue exist in `server/src/` — must be migrated to `packages/core/`, not rebuilt
- **New workspace: packages/core (@lokyy/core):** All service logic; imported by server and mcp; never by pwa
- **New workspace: mcp (@lokyy/mcp):** MCP server, consolidation agent, imports core directly (no HTTP)
- **Monorepo rename:** `sternwarte` → `lokyy-brain`, `@sternwarte/shared` → `@lokyy/shared` across all package.json files
- **Drizzle ORM migrations:** Schema in `packages/core/src/db/schema.ts`; migrations auto-applied at server startup
- **Docker Compose:** 4-service stack (lokyy-brain + forgejo + postgres + ollama); primary deployment artifact
- **Web-based Setup Wizard:** Server boots in setup mode until wizard complete; idempotent re-run
- **Server-side sessions:** Postgres `sessions` table; HttpOnly cookie; 30-day TTL sliding window
- **Vault-scoped REST routes:** All vault data under `/api/vaults/:vaultId/...`; vaultMiddleware on every route
- **Import graph enforced via tsconfig paths:** pwa imports only @lokyy/shared; no @lokyy/core in browser
- **Three Zones error model:** Zone 1 (core: throw), Zone 2 (server: catch+HTTP), Zone 3 (pwa: catch+display)
- **Fire-and-forget Tier 2 sync:** Never awaited; EmbeddingUnavailableError logged, never blocking
- **HNSW pgvector index:** `vector(768)`, m=16, ef_construction=64, cosine ops
- **MCP scope resolver:** Reads `00_meta/mcp-scopes.yaml` at startup; micromatch glob validation; default deny
- **React Query + Zustand state split:** Server state via React Query; UI state only in Zustand
- **Co-located tests:** `*.test.ts` next to source; integration tests for core services; real DB (no mocking)

### UX Design Requirements

Sources: `docs/mockup/lokyy-brain-mockup.jsx` (interactive React mockup) and `docs/mockup/README.md` (UX brief, German). The mockup is binding for layout and interaction patterns; deviations must be justified in a Story.

- UX-DR1: Three-panel layout — FileTree (left, ~280px) | CM6 NoteEditor (center, flex) | GraphView (right, ~360px). All panels independently scrollable; right panel collapsible.
- UX-DR2: FileTree panel renders folder hierarchy + note titles + tag chips + Pipes-Inbox section showing incoming imports until they become saved notes.
- UX-DR3: CM6 NoteEditor implements Obsidian-style live preview as a CodeMirror 6 extension — caret-on-line shows raw Markdown, caret-off shows rendered formatting in the same line. No separate preview pane.
- UX-DR4: Wikilinks (`[[Note Title]]`) rendered as clickable affordances in both raw and preview modes; click navigates to target note.
- UX-DR5: GraphView is a force-directed knowledge graph using `react-force-graph` (not the mockup's d3-force). Nodes = notes, edges = wikilinks. Hover highlights direct neighbors; click opens the note in the editor.
- UX-DR6: Top status bar shows Forgejo pull/commit/push state (idle / syncing / behind / ahead / conflict) and updates on every gitService action.
- UX-DR7: Pipes-Inbox slide-over panel lists active and recent imports (YouTube, web, voice, PDF) with per-job status, until each becomes a saved capture note in `30_captures/`.
- UX-DR8: Color tokens — bg `#14110f`, panel `#1b1714`, elevated `#231e1a`, accent `#d2693f` (terracotta), gold `#c9a25e`, text-primary `#f3ece2`, text-muted `#9d9082`. Applied via CSS custom properties; theme is a single dark variant for v1.
- UX-DR9: Typography — Bricolage Grotesque (UI text), Fraunces (headings, note titles), JetBrains Mono (CM6 editor + code blocks). Self-hosted, no Google Fonts CDN.
- UX-DR10: Offline indicator visible whenever the service worker registers no Forgejo connectivity; queued writes shown in status bar with count.
- UX-DR11: Conflict resolution UI — when `git pull --rebase` produces a merge conflict on save, present a 3-pane diff (local | base | remote) with explicit "keep mine / take theirs / merge manually" controls. Never silently discard a user write.
- UX-DR12: Setup Wizard is a multi-step form (Forgejo → Postgres → Ollama → Admin User → Vault) with per-step connectivity test, error surface, and re-run safety. Lives at `/setup` until config is complete.

### FR Coverage Map

| FR | Epic | Note |
|----|------|------|
| FR1 | Epic 1 | Guided wizard install |
| FR2 | Epic 1 | New Forgejo repo as vault |
| FR3 | Epic 1 | Link existing Forgejo repo with SPEC validation |
| FR4 | Epic 1 | Postgres + Ollama + vault URL config |
| FR5 | Epic 1 | Idempotent re-run of wizard (Story 1.11) |
| FR6 | Epic 1 | Change vault URL via admin settings (Story 1.12) |
| FR7 | Epic 2 | Create note with auto-generated SPEC frontmatter (ULID, type, title, created) |
| FR8 | Epic 2 | Edit note in live-preview Markdown editor (CM6) |
| FR9 | Epic 2 | Save note via git commit |
| FR10 | Epic 2 | Navigate vault via file tree |
| FR11 | Epic 2 | Rename/move note without breaking wikilinks |
| FR12 | Epic 2 | Create & follow wikilinks |
| FR13 | Epic 5 | Visualize note connections as interactive graph (depends on Tier 1 index) |
| FR14 | Epic 2 | Create folders and organize notes |
| FR15 | Epic 5 | Search by keywords/tags/wikilinks (Tier 1) |
| FR16 | Epic 5 | Semantic related-notes search (Tier 2) |
| FR17 | Epic 5 | Related-notes for currently viewed note |
| FR18 | Epic 7 | Agent semantic search via MCP tool |
| FR19 | Epic 7 | Agent related-notes via MCP tool |
| FR20 | Epic 6 | YouTube transcript import as capture |
| FR21 | Epic 6 | Web page content import as capture |
| FR22 | Epic 6 | Voice recording upload as capture |
| FR23 | Epic 6 | View status of active/completed import jobs |
| FR24 | Epic 7 | Agent triggers content import via MCP tool |
| FR25 | Epic 7 | Agent reads scoped notes |
| FR26 | Epic 7 | Agent creates/updates notes with SPEC frontmatter |
| FR27 | Epic 7 | Agent retrieves vault folder structure |
| FR28 | Epic 7 | Per-agent scope + commit prefix from `mcp-scopes.yaml` |
| FR29 | Epic 7 | Concurrent MCP writes serialized via gitService lock |
| FR30 | Epic 7 | Every MCP write traceable in git log with commit prefix |
| FR31 | Epic 8 | Consolidation Agent runs on configurable schedule |
| FR32 | Epic 8 | Agent adds missing wikilinks |
| FR33 | Epic 8 | Agent creates topic notes for recurring concepts |
| FR34 | Epic 8 | Agent writes interventions to designated folder |
| FR35 | Epic 8 | User reviews proposed interventions individually |
| FR36 | Epic 8 | No agent write committed without review |
| FR37 | Epic 8 | Admin triggers Consolidation run manually |
| FR38 | Epic 3 | Admin creates/manages user accounts |
| FR39 | Epic 3 | Each user gets private personal vault |
| FR40 | Epic 3 | Admin creates company vaults + assigns roles |
| FR41 | Epic 3 | Email/password auth |
| FR42 | Epic 3 | Server-side vault access enforcement |
| FR43 | Epic 3 | Admin revokes company vault access |
| FR44 | Epic 4 | Read/edit offline |
| FR45 | Epic 4 | Save offline → queued for sync |
| FR46 | Epic 4 | Auto-replay queued saves on reconnect |
| FR47 | Epic 4 | Surface git merge conflicts explicitly (no silent discard) |

## Epic List

### Epic 1: Foundation & Vault Setup 🚀 MVP
**Goal:** An administrator can stand up a fresh lokyy-brain instance against a Forgejo + Postgres + Ollama stack via a guided web wizard, and the resulting vault is provably SPEC-compliant.

**User Outcome:** A new admin moves from `docker compose up` to "the system is configured, the vault validates, I can sign in" without editing any config files by hand.

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6.

**Implementation scope (Architecture-driven, embedded in stories — not separate epics):**
- Monorepo rename `sternwarte` → `lokyy-brain`, `@sternwarte/shared` → `@lokyy/shared`, manifest + index.ts + PWA manifest cleanup.
- New workspace `packages/core` (`@lokyy/core`); migrate `gitService`, `notesService`, `graphService`, `pipeQueue` from `server/src/` into it; `server` and the future `mcp` import from core.
- Vault compliance foundation: `ulid@3.0.2`, `gray-matter@4.0.3`, `ajv@8.20.0` integrated in `@lokyy/core`; `notesService.createNote` produces SPEC-valid frontmatter; `saveNote` preserves `id`/`created`, updates `updated`; distinct `FrontmatterValidationError` surfaced when the vault hook rejects.
- Drizzle schema (`users`, `vaults`, `vault_memberships`, `sessions`, `note_embeddings`) + migrations applied at server startup.
- 4-service Docker Compose stack (`lokyy-brain`, `forgejo`, `postgres+pgvector`, `ollama`).
- Setup Wizard (UX-DR12): Forgejo / Postgres / Ollama / Admin User / Vault, idempotent, per-step connectivity test.

**Standalone:** After Epic 1, the system runs and an admin can sign in. No notes UI yet; that comes in Epic 2.

---

### Epic 2: Notes Management & Editing 🚀 MVP
**Goal:** A signed-in user can create, edit, organize, and link notes inside a single vault, with every write committed through `gitService` and every file SPEC-valid.

**User Outcome:** "I can write a note, save it, see it in the file tree, link to another note, rename a note, and the system never breaks the links or eats my changes."

**FRs covered:** FR7, FR8, FR9, FR10, FR11, FR12, FR14.

**UX-DRs covered:** UX-DR1, UX-DR2 (left + center panels), UX-DR3 (CM6 live preview), UX-DR4 (clickable wikilinks), UX-DR8 (colors), UX-DR9 (fonts).

**Implementation scope:**
- CM6 NoteEditor with the live-preview extension (Obsidian-style caret-driven raw↔rendered).
- FileTree panel: folder hierarchy, note titles, tag chips.
- Wikilink resolver (`[[Title]]` → note id) shared between editor + graph; rename/move updates all incoming wikilinks atomically through `gitService` (single commit).
- `notesService.moveEntry` covers rename + move + folder creation; preserves `id`, updates `updated`, writes link-rewrites in the same commit.
- All writes flow through the gitService promise-lock.

**Standalone:** Single-user, single-vault knowledge work end-to-end. No search/graph yet, no other users yet.

---

### Epic 3: Multi-User & Vault Access 🚀 MVP
**Goal:** Multiple human users coexist on one instance with isolated personal vaults and optionally shared company vaults under role-based access, enforced server-side on every request.

**User Outcome:** "I can invite a colleague; she gets her own private vault she alone can read; we both have access to the company vault she edits but I only read."

**FRs covered:** FR38, FR39, FR40, FR41, FR42, FR43.

**Implementation scope:**
- Email/password auth, server-side sessions (Postgres `sessions` table, HttpOnly cookie, 30-day sliding window).
- `users`, `vaults`, `vault_memberships` tables with `role ∈ {read, write, admin}`.
- `vaultMiddleware` on every `/api/vaults/:vaultId/...` route — server-side enforcement, never client-trusted.
- Admin UI for user CRUD + vault CRUD + role assignment.
- Personal vault auto-provisioned on user creation; unreachable to others.

**Standalone:** Multi-tenant after this epic. Auth + vault scope works without search, pipes, or MCP.

---

### Epic 4: Offline & Resilience 🚀 MVP
**Goal:** The PWA continues to read and write while offline, queues unsynced writes, replays them on reconnect, and surfaces Git merge conflicts to the user instead of swallowing them.

**User Outcome:** "I worked on the train without signal; when I reconnected, my notes synced; when there was a conflict with my colleague's edit, I saw a clear diff and chose."

**FRs covered:** FR44, FR45, FR46, FR47.

**UX-DRs covered:** UX-DR10 (offline indicator), UX-DR11 (conflict 3-pane diff).

**Implementation scope:**
- Service worker registers offline cache + IndexedDB write queue.
- Queue-replay loop on reconnect with sequential, idempotent retries.
- `GitConflictError` propagated to the PWA, rendered as the conflict resolution UI (UX-DR11).
- Status bar (UX-DR6) reflects sync state on every transition.

**Standalone:** Epic 4 closes the MVP. After this, a small group of external users can use lokyy-brain as a multi-tenant Markdown knowledge system.

---

### Epic 5: Knowledge Discovery (Tier 1 + Tier 2 + Graph)
**Goal:** A user finds the notes they need through keyword/tag/wikilink search, through semantically-related-notes recommendations, and through an interactive graph of the vault.

**User Outcome:** "I forgot the exact note title but I remember the topic — I find it. I open a note and see five others that are semantically close. I visualize how my knowledge connects."

**FRs covered:** FR13, FR15, FR16, FR17.

**UX-DRs covered:** UX-DR5 (force-directed graph, react-force-graph).

**Implementation scope:**
- `MemoryProvider` interface in `@lokyy/core` with Tier 1 (structural: wikilinks/tags/folder/full-text) + Tier 2 (semantic) implementations.
- Tier 2: `nomic-embed-text` via Ollama → `pgvector` with HNSW (`m=16, ef_construction=64`), 768-dim, cosine ops.
- Fire-and-forget sync after every `gitService.save`: never awaited, `EmbeddingUnavailableError` logged, never blocks save.
- `POST /api/vaults/:vaultId/search` returns combined Tier 1 + Tier 2 results.
- GraphView panel with hover-neighbors + click-to-open.

**Standalone:** Knowledge discovery layer on top of the MVP. Vault still functions if Ollama is down — only Tier 2 degrades.

---

### Epic 6: Content Import (Pipes)
**Goal:** A user can drop a YouTube link, a web URL, an audio recording, or a PDF and have it appear as a `type: capture` note in `30_captures/` with valid frontmatter, surfaced through the Pipes-Inbox.

**User Outcome:** "I capture an idea by sharing a URL or recording a voice memo, and it shows up in my vault searchable and linkable like any other note."

**FRs covered:** FR20, FR21, FR22, FR23.

**UX-DRs covered:** UX-DR7 (Pipes-Inbox).

**Implementation scope:**
- `pipeQueue` handlers for YouTube (transcript), web (readability extract), voice (transcript via Whisper or similar), PDF (text extract).
- Handlers write to `30_captures/{youtube,urls,voice,pdfs}/` with `type: capture` frontmatter (not `inbox/`).
- Job status surface: PWA polls `/api/pipes/jobs` and renders UX-DR7.

**Standalone:** Adds an ingest path; the vault and search continue to function without it.

---

### Epic 7: AI Agent Integration (MCP)
**Goal:** External AI agents read, search, and write the vault through scoped MCP tools, with every write traceable in the git log and per-agent scope enforced server-side.

**User Outcome:** "I can plug Claude, my IDE agent, or my CLI assistant into my vault; each has a defined scope; their commits are tagged so I always know which agent wrote what."

**FRs covered:** FR18, FR19, FR24, FR25, FR26, FR27, FR28, FR29, FR30.

**Implementation scope:**
- New workspace `mcp` (`@lokyy/mcp`) using `@modelcontextprotocol/sdk@1.29.0`, stdio transport, imports `@lokyy/core` directly (no HTTP).
- MCP scope resolver reads `00_meta/mcp-scopes.yaml` at startup; `micromatch` glob validation; default-deny.
- Tools: `read_note`, `search_vault` (Tier 1+2), `related_notes`, `list_tree`, `create_note`, `update_note`, `trigger_import`.
- Agent identity per server instance via env/CLI arg; commit prefix per agent baked into `gitService.save` calls.

**Standalone:** Agents can use the vault without any consolidation behavior.

---

### Epic 8: Autonomous Knowledge Consolidation
**Goal:** A scheduled Consolidation Agent processes notes changed since its last run and proposes wikilinks, topic notes, and interventions for the user to accept, reject, or ignore individually. Nothing lands without user review.

**User Outcome:** "Overnight my system finds connections I missed; I wake up to a short review queue; I accept the good ones with one click each."

**FRs covered:** FR31, FR32, FR33, FR34, FR35, FR36, FR37.

**Implementation scope:**
- Consolidation Agent runs in the `@lokyy/mcp` process (or sibling scheduler) — never bypasses MCP scope.
- Writes proposals to `70_pai/interventions/` as `type: intervention` notes; state in `70_pai/memory/`.
- PWA intervention review UI: list pending proposals, per-item accept / reject / ignore; accept = `gitService.save` of the proposed change with the consolidation-agent commit prefix.
- Admin-triggered manual run via `/api/admin/consolidation/run`.

**Standalone:** Final epic. Requires Epic 5 (Tier 2 + MemoryProvider) and Epic 7 (MCP scope) to function.

---

## Epic 1: Foundation & Vault Setup — Stories

### Story 1.1: Monorepo Rename to lokyy-brain

As a developer,
I want the monorepo, package names, and identifying strings renamed from `sternwarte` / `@sternwarte/*` to `lokyy-brain` / `@lokyy/*`,
So that all future work happens under the project's actual identity and `pnpm -r build` stays green.

**Acceptance Criteria:**

**Given** the repo at `/media/oliver/Volume3/eigene_projekte_neu/lokyy-brain`
**When** the rename completes
**Then** root `package.json` `name` is `lokyy-brain`
**And** `packages/shared/package.json` `name` is `@lokyy/shared`
**And** every workspace `package.json` that referenced `@sternwarte/shared` now references `@lokyy/shared`
**And** `server/src/index.ts` no longer references the string `sternwarte`
**And** `pwa/vite.config.ts` PWA manifest `name`/`short_name` reference `lokyy-brain`
**And** `pnpm -r build` exits 0
**And** `grep -ri "sternwarte" --include="*.{ts,tsx,json,md,html,yaml}" .` returns no hits outside `_bmad-output/` and `Plans/`

---

### Story 1.2: Bootstrap `packages/core` Workspace

As a developer,
I want a new pnpm workspace `packages/core` named `@lokyy/core`,
So that service logic can be shared between `server` and the future `mcp` package without duplication.

**Acceptance Criteria:**

**Given** the workspace does not yet exist
**When** Story 1.2 is complete
**Then** `packages/core/package.json` exists with `name: "@lokyy/core"`, `main`, `types`, `exports`, and `scripts.build` entries
**And** `packages/core/tsconfig.json` extends the same base as `packages/shared`
**And** `packages/core/src/index.ts` exists exporting a placeholder
**And** `pnpm-workspace.yaml` includes `packages/core`
**And** `pnpm install` resolves without errors
**And** `pnpm --filter @lokyy/core build` exits 0
**And** the full `pnpm -r build` still exits 0

---

### Story 1.3: Migrate `gitService` to `@lokyy/core`

As a developer,
I want `gitService` moved from `server/src/git/` into `packages/core/src/git/`,
So that the future MCP package can call git operations directly without HTTP.

**Acceptance Criteria:**

**Given** `gitService` currently lives in `server/src/git/gitService.ts`
**When** Story 1.3 is complete
**Then** `packages/core/src/git/gitService.ts` exists with the migrated implementation including the promise-lock
**And** `packages/core/src/index.ts` re-exports `gitService` (or the appropriate symbols)
**And** `server/` imports `gitService` from `@lokyy/core` (no relative path)
**And** the old `server/src/git/` files are deleted (no dead duplicates)
**And** `pnpm -r build` exits 0
**And** an integration test against a real local git repo confirms `ensureRepo`, `pull`, `save`, `remove`, `move`, `lastModified` still behave correctly

---

### Story 1.4: Migrate `notesService`, `graphService`, `pipeQueue` to `@lokyy/core`

As a developer,
I want `notesService`, `graphService`, and `pipeQueue` migrated into `packages/core`,
So that the entire service layer is in one shared package and routes shrink to thin HTTP adapters.

**Acceptance Criteria:**

**Given** the three services live under `server/src/{notes,graph,pipes}/`
**When** Story 1.4 is complete
**Then** each service lives under `packages/core/src/{notes,graph,pipes}/`
**And** `packages/core/src/index.ts` exports them
**And** all imports in `server/src/routes/` reference `@lokyy/core`
**And** the old `server/src/{notes,graph,pipes}/` are deleted
**And** `pnpm -r build` exits 0
**And** existing route behavior is unchanged (covered by an HTTP smoke test against `/api/notes`, `/api/graph`, `/api/pipes`)

---

### Story 1.5: Vault Compliance Utility (Frontmatter + ULID + AJV)

As a developer,
I want a shared frontmatter utility in `@lokyy/core` using `ulid`, `gray-matter`, and `ajv`,
So that every note write is provably SPEC-valid and rejection from the vault hook surfaces as a typed error.

**Acceptance Criteria:**

**Given** the dependencies are not yet present
**When** Story 1.5 is complete
**Then** `@lokyy/core` declares `ulid@3.0.2`, `gray-matter@4.0.3`, `ajv@8.20.0`
**And** `packages/core/src/frontmatter/` exposes `parseFrontmatter`, `serializeFrontmatter`, `validateFrontmatter(doc, type)`, `generateUlid()`
**And** `packages/core/src/frontmatter/schemas/` contains one JSON schema per doc type (`note`, `capture`, `project`, `task`, `decision`, `meeting`, `customer`, `workflow`, `intervention`, `content`)
**And** `packages/core/src/errors/FrontmatterValidationError.ts` exports a distinct error class with `cause`, `noteId`, and `errors` fields
**And** a Vitest unit suite covers: valid round-trip, missing-required-field rejection, invalid-type rejection, ULID format check, and `serialize → parse` round-trip preservation
**And** `pnpm --filter @lokyy/core test` exits 0

---

### Story 1.6: `notesService.createNote` Produces SPEC-Valid Frontmatter

As a user,
I want every note created through `notesService.createNote` to have a complete, schema-valid frontmatter block,
So that the lokyy-vault pre-commit hook never rejects writes initiated by the app.

**Acceptance Criteria:**

**Given** Story 1.5 is complete
**When** Story 1.6 is complete
**Then** `createNote(vaultId, path, type, title)` produces a file whose frontmatter contains `id` (ULID, 26 chars), `type`, `title`, `created` (ISO-8601), `updated` (ISO-8601 equal to `created`)
**And** the value passes `validateFrontmatter(doc, type)`
**And** an integration test against a fresh local vault confirms `git commit` succeeds and the pre-commit hook does not fire any errors
**And** if a caller supplies an explicit `id`, it is preserved (no overwrite)

---

### Story 1.7: `notesService.saveNote` Preserves `id` / `created`, Updates `updated`

As a user,
I want saving an existing note to preserve its identity and creation timestamp while updating the modification timestamp,
So that the vault contract holds across the entire note lifecycle and wikilinks survive saves.

**Acceptance Criteria:**

**Given** Story 1.6 is complete
**When** Story 1.7 is complete
**Then** `saveNote(vaultId, path, body)` reads existing frontmatter, preserves `id` and `created`, sets `updated` to now, and writes the result
**And** if the supplied body has no frontmatter, the call throws `FrontmatterValidationError`
**And** if validation fails, `FrontmatterValidationError` is thrown and no git commit is attempted
**And** a Vitest integration test confirms the `id` and `created` values are byte-identical before and after save
**And** an integration test confirms that when the pre-commit hook rejects, the caller receives `FrontmatterValidationError`, not a generic git error

---

### Story 1.8: Drizzle Schema + Auto-Migrations at Startup

As an admin,
I want the server to apply the database schema automatically when it boots against a fresh Postgres,
So that there is no manual migration step in the installation path.

**Acceptance Criteria:**

**Given** an empty Postgres database with pgvector installed
**When** the server starts
**Then** Drizzle migrations run idempotently to create `users`, `vaults`, `vault_memberships`, `sessions`, `note_embeddings`
**And** `note_embeddings.embedding` is `vector(768)` with an HNSW index using `vector_cosine_ops`, `m=16`, `ef_construction=64`
**And** ULID columns are stored as `TEXT`
**And** a second start against the same database is a no-op (`drizzle-kit migrate` reports zero pending)
**And** the migration runner logs every applied migration name to stdout
**And** if the database is unreachable, server start fails fast with a clear error message

---

### Story 1.9: Docker Compose Stack (lokyy-brain + Forgejo + Postgres + Ollama)

As an admin,
I want a `docker-compose.yml` that brings up the full stack on a single host,
So that I can install and run lokyy-brain with one command.

**Acceptance Criteria:**

**Given** Docker and Docker Compose are installed
**When** I run `docker compose up -d`
**Then** four services start: `lokyy-brain`, `forgejo`, `postgres` (with pgvector extension), `ollama`
**And** Forgejo is reachable on `http://localhost:3000` and SSH on `:22`
**And** Postgres has the `pgvector` extension pre-installed in its image
**And** Ollama auto-pulls `nomic-embed-text` on first start (or includes a sidecar init container that does so)
**And** all services are on a single named bridge network
**And** named volumes persist Forgejo repos and Postgres data across `docker compose down && docker compose up`
**And** `docker compose ps` shows all four services healthy

---

### Story 1.10: Setup-Mode Boot + `/api/setup` Endpoints

As an admin,
I want the server to boot in setup mode until configuration is complete and expose `/api/setup/*` endpoints,
So that the Setup Wizard frontend has a backend to drive.

**Acceptance Criteria:**

**Given** a fresh installation with no configuration in the database
**When** the server starts
**Then** it boots in setup mode (a flag persisted in Postgres `system_config`)
**And** all `/api/vaults/*` routes return 503 with `{ error: "setup-required" }`
**And** `/api/setup/status`, `/api/setup/test-forgejo`, `/api/setup/test-postgres`, `/api/setup/test-ollama`, `/api/setup/admin`, `/api/setup/vault`, `/api/setup/complete` are reachable
**And** each `test-*` endpoint performs a real connection check and returns a typed result
**And** `/api/setup/complete` flips the setup-mode flag to `false`, requires admin user + vault to be provisioned, and is idempotent on re-run
**And** an integration test runs the full wizard sequence end-to-end against a clean stack

---

### Story 1.11: Setup Wizard Frontend (UX-DR12)

As an admin,
I want a guided web wizard that walks me through Forgejo, Postgres, Ollama, admin-user, and vault configuration,
So that I can install lokyy-brain without editing any config files by hand (FR1).

**Acceptance Criteria:**

**Given** the server is in setup mode
**When** I open the PWA
**Then** I am routed to `/setup` regardless of the URL I requested
**And** the wizard renders five steps in order: Forgejo → Postgres → Ollama → Admin User → Vault
**And** each step shows a "Test Connection" button that calls the corresponding `/api/setup/test-*` endpoint and shows pass/fail with the error message on fail
**And** I cannot advance to step N+1 until step N's test passes
**And** the Admin User step creates the first user with `role: admin`
**And** the Vault step either creates a new Forgejo repo or links an existing one with SPEC validation (FR2, FR3)
**And** completing the wizard calls `/api/setup/complete` and redirects me to the sign-in page
**And** re-running the wizard from a fresh browser does not break existing data (FR5)
**And** the wizard UI uses the design tokens from UX-DR8 and fonts from UX-DR9

---

### Story 1.12: Admin System Settings — Change Vault URL Post-Install

As an admin,
I want a settings screen to change the configured vault URL after the system is already running,
So that I can rotate the vault repo (move to a new Forgejo instance, switch from personal to team repo) without reinstalling (FR6).

**Acceptance Criteria:**

**Given** the system is past setup (Story 1.10 setup-mode flag is `false`) and I am signed in as an admin
**When** I navigate to `/admin/system-settings`
**Then** I see the current `vault_url` and a "Change Vault URL" form
**And** the form accepts a new Forgejo URL + optional credentials
**And** "Test Connection" calls a `/api/admin/system-settings/test-vault-url` endpoint that performs a real Forgejo connectivity check and SPEC validation of the target repo
**And** "Save" calls `PUT /api/admin/system-settings/vault-url` which atomically updates `system_config`, drains in-flight git operations, re-clones the working copy from the new URL, and emits an audit log entry
**And** the operation refuses if there are unsynced writes in any user's offline queue (returns 409 with a list of pending users)
**And** non-admin users get 403 on both the route and the API

---

## Epic 2: Notes Management & Editing — Stories

### Story 2.1: Three-Panel Layout Shell

As a user,
I want the main editor screen rendered as a three-panel layout with the project's color tokens and fonts,
So that the visual foundation matches the mockup before any feature work lands on it.

**Acceptance Criteria:**

**Given** I am signed in and have selected a vault
**When** I land on `/vaults/:vaultId`
**Then** the screen shows three panels: FileTree (left, 280px), NoteEditor (center, flex), GraphView (right, 360px)
**And** the right panel can be collapsed via a toggle in the status bar
**And** CSS custom properties define `--bg`, `--panel`, `--elevated`, `--accent`, `--gold`, `--text-primary`, `--text-muted` matching UX-DR8
**And** Bricolage Grotesque, Fraunces, and JetBrains Mono are self-hosted under `pwa/public/fonts/` and loaded via `@font-face` (no Google Fonts CDN)
**And** an `Interceptor` screenshot at `/vaults/:vaultId` confirms layout matches the mockup proportions

---

### Story 2.2: Basic CM6 NoteEditor (Markdown Editing + Save)

As a user,
I want a CodeMirror 6 editor in the center panel that lets me edit the body of the currently selected note and save it,
So that I have a working write loop before live-preview lands.

**Acceptance Criteria:**

**Given** Story 2.1 is complete and a note is selected
**When** I type in the editor and press Cmd/Ctrl+S
**Then** the editor calls `notesService.saveNote(vaultId, path, body)` through the existing `/api/notes` route
**And** the status bar transitions idle → syncing → idle (or idle → conflict on error)
**And** the editor uses the markdown language extension and JetBrains Mono
**And** if save fails with `FrontmatterValidationError`, the error is shown inline in the editor footer with the failing rule
**And** unsaved-changes indicator (dot in the title bar) appears on dirty state and clears after successful save

---

### Story 2.3: CM6 Live-Preview Extension (Obsidian-Style)

As a user,
I want the editor to render Markdown formatting inline when my caret is not on the line, and show raw Markdown when it is,
So that I get Obsidian-style live preview without a separate preview pane (UX-DR3).

**Acceptance Criteria:**

**Given** Story 2.2 is complete
**When** my caret moves into a line containing `**bold**`, `# heading`, `- list`, `[text](url)`, or `[[Wikilink]]`
**Then** that line renders the raw Markdown
**When** my caret leaves the line
**Then** the line renders the formatted output (bold, heading, list bullet, link)
**And** the extension is a real CM6 `ViewPlugin` with `Decoration.replace` ranges, not a regex post-processor
**And** the implementation lives in `pwa/src/editor/livePreview.ts` with a Vitest snapshot test for each Markdown construct

---

### Story 2.4: Wikilink Resolver + Clickable Navigation

As a user,
I want `[[Note Title]]` rendered as a clickable affordance in both raw and preview modes, opening the target note,
So that I can navigate my knowledge graph by clicking (FR12, UX-DR4).

**Acceptance Criteria:**

**Given** Story 2.3 is complete
**When** my note body contains `[[Some Other Note]]`
**Then** the rendering shows it as styled (accent color, underlined-on-hover) and intercepts click
**And** clicking calls a wikilink-resolver that finds the note by title via a Tier 1 index lookup
**And** if exactly one match exists, the editor loads that note; if zero, the user is offered "Create note 'Some Other Note'"; if multiple, a small disambiguation picker shows
**And** the resolver lives in `@lokyy/core/src/wikilinks/` and is shared with the future graph view
**And** unit tests cover: exact match, no match, multiple matches, and case-insensitive matching

---

### Story 2.5: FileTree Panel with Folder Hierarchy and Tags

As a user,
I want the left panel to render the vault's folder hierarchy with note titles and tag chips,
So that I can navigate my vault visually (FR10, UX-DR2).

**Acceptance Criteria:**

**Given** Story 2.1 is complete and the vault contains nested folders with notes
**When** I view the FileTree
**Then** folders render as collapsible nodes with a chevron, notes render as leaf items showing their `title` frontmatter value
**And** clicking a note loads it into the NoteEditor
**And** each note shows its tags (parsed from frontmatter `tags:`) as inline chips
**And** the tree state (which folders are expanded) is persisted to `localStorage` per vault
**And** the tree updates within 500ms after a save that creates or moves a file (via React Query invalidation)

---

### Story 2.6: Create Folder

As a user,
I want to create a new folder anywhere in the vault tree,
So that I can organize notes into the SPEC's standard folder structure (FR14).

**Acceptance Criteria:**

**Given** Story 2.5 is complete
**When** I right-click a folder (or the vault root) and choose "New folder"
**Then** a prompt appears for the folder name
**And** on confirm, a new folder is created (committed via gitService as an empty directory marker `.gitkeep` if Forgejo rejects empty directories)
**And** the FileTree updates to show the new folder
**And** folder names are validated client-side: no `/`, no leading dot, max 200 chars
**And** if the folder already exists, the user sees an inline error and no commit happens

---

### Story 2.7: Rename / Move Note with Atomic Wikilink Update

As a user,
I want to rename or move a note and have every incoming wikilink rewritten in the same git commit,
So that links never break and history is clean (FR11).

**Acceptance Criteria:**

**Given** at least three notes link to the note I am renaming
**When** I rename the note from "Old Title" to "New Title"
**Then** the note file's `title` frontmatter is updated and the file is moved if its path changed
**And** every incoming wikilink `[[Old Title]]` in the vault is rewritten to `[[New Title]]`
**And** all changes (the renamed file + all link-rewrite edits) are committed in a single git commit with message `Rename: Old Title → New Title`
**And** the operation is serialized through the gitService promise-lock — no concurrent vault write can interleave
**And** if any link rewrite fails validation, the entire operation is rolled back and an error is surfaced

---

## Epic 3: Multi-User & Vault Access — Stories

### Story 3.1: Email/Password Auth + Server-Side Sessions

As a user,
I want to register and sign in with email and password and have my session persisted server-side,
So that I can access my vault across requests without re-authenticating (FR41).

**Acceptance Criteria:**

**Given** the `users` and `sessions` tables exist (Story 1.8)
**When** Story 3.1 is complete
**Then** `POST /api/auth/register` accepts `{ email, password, name }`, hashes the password with `bcrypt` cost 12, and creates a user
**And** `POST /api/auth/login` validates credentials, creates a row in `sessions`, sets an HttpOnly + Secure + SameSite=Lax cookie `lokyy_session`
**And** sessions have 30-day TTL with sliding-window refresh (every authenticated request bumps `expires_at`)
**And** `POST /api/auth/logout` deletes the session row and clears the cookie
**And** `GET /api/auth/me` returns the current user or 401
**And** integration tests cover: register, login, authenticated request, sliding refresh, logout, expired session

---

### Story 3.2: Personal Vault Auto-Provisioning

As an admin,
I want every new user to automatically get a private personal vault that nobody else can read,
So that users have a default workspace from day one (FR39).

**Acceptance Criteria:**

**Given** Story 3.1 is complete
**When** a new user is created (via wizard, admin, or self-registration if enabled)
**Then** a row is inserted into `vaults` with `kind: 'personal'`, `owner_id: <new user id>`
**And** a row is inserted into `vault_memberships` with `role: 'admin'` for that user
**And** the underlying Forgejo repo is created in a per-user namespace (e.g. `vault-<user-ulid>`) and seeded with the SPEC folder structure + a `.gitignore` + a `README.md`
**And** no other user (including system admins by default) appears in `vault_memberships` for this vault
**And** an attempt by another user to `GET /api/vaults/:vaultId` returns 404 (not 403, to avoid leaking existence)

---

### Story 3.3: `vaultMiddleware` — Server-Side Access Enforcement

As a security architect,
I want every `/api/vaults/:vaultId/...` request validated by middleware that confirms the caller has access at the required role,
So that vault scope cannot be bypassed by a malicious or buggy client (FR42).

**Acceptance Criteria:**

**Given** Stories 3.1 and 3.2 are complete
**When** Story 3.3 is complete
**Then** `vaultMiddleware(requiredRole)` wraps every route under `/api/vaults/:vaultId`
**And** it loads the current session, looks up the membership row for `(user_id, vault_id)`, and rejects with 404 if missing or 403 if role insufficient
**And** the middleware uses a typed `VaultPermissionError` distinct from generic 401/403
**And** a request without a session cookie returns 401
**And** an integration suite covers: read-role user calling write route → 403; non-member calling any route → 404; admin role hitting any route → 200

---

### Story 3.4: Admin User Management UI

As an admin,
I want a screen at `/admin/users` to list, create, and delete users,
So that I can manage who has access to the instance (FR38).

**Acceptance Criteria:**

**Given** I am signed in as a user with `role: admin`
**When** I navigate to `/admin/users`
**Then** I see a table of all users with email, name, created, last login
**And** I can click "New user" → form (email, name, temporary password) → POST to `/api/admin/users` → row appears
**And** I can click "Delete user" → confirm modal → DELETE to `/api/admin/users/:id` → row disappears, user's personal vault is preserved but their sessions are revoked
**And** non-admin users get 403 on `/admin/users` (both the UI route and the API)
**And** an audit log entry is written to `audit_log` for every user create/delete

---

### Story 3.5: Company Vault CRUD + Role Assignment

As an admin,
I want to create company vaults and add users to them with `read`, `write`, or `admin` role,
So that teams can share vaults (FR40, FR43).

**Acceptance Criteria:**

**Given** Story 3.4 is complete
**When** Story 3.5 is complete
**Then** `/admin/vaults` lists all vaults with `kind: company` and their member counts
**And** "New company vault" form (name, slug) → POST → vault created with the creating admin as `role: admin`
**And** opening a vault shows the membership list with role pickers and a "remove" action per row
**And** removing a user from a company vault revokes their access immediately on the next request (FR43)
**And** removing a user from a company vault does not affect their personal vault (verified by integration test)
**And** non-admin users get 403 on all `/admin/vaults` endpoints

---

### Story 3.6: PWA Login + Session UI

As a user,
I want a sign-in page that authenticates me and a session-aware shell that knows who I am,
So that the rest of the PWA can rely on a known identity.

**Acceptance Criteria:**

**Given** Stories 3.1 and 3.3 are complete
**When** I open the PWA without a valid session
**Then** I am routed to `/login` regardless of the requested URL
**And** `/login` shows an email + password form that calls `POST /api/auth/login`
**And** on success, the PWA queries `/api/auth/me`, stores user info in a React Query cache, and routes me to my last-visited vault or my personal vault
**And** the top-right shows my name with a "Sign out" menu item that calls `POST /api/auth/logout`
**And** a 401 from any API call automatically routes me to `/login` and preserves the intended URL via a `?next=` parameter

---

## Epic 4: Offline & Resilience — Stories

### Story 4.1: Service Worker + Offline Read Cache

As a user,
I want the PWA shell and recently opened notes available offline,
So that I can keep reading my vault on a flaky or absent connection (FR44).

**Acceptance Criteria:**

**Given** `vite-plugin-pwa` is configured
**When** Story 4.1 is complete
**Then** the service worker caches the PWA shell (HTML/JS/CSS/fonts) using `precacheAndRoute`
**And** notes fetched via `/api/vaults/:vaultId/notes/:path` use a `StaleWhileRevalidate` strategy with a per-vault cache key
**And** with DevTools "offline" enabled and the PWA cold-loaded, the shell still loads and previously opened notes are still readable
**And** a visible "offline" indicator (UX-DR10) is shown in the status bar whenever `navigator.onLine === false` or three consecutive API calls fail
**And** Lighthouse PWA score for the build artifact is ≥ 90

---

### Story 4.2: IndexedDB Write Queue

As a user,
I want saves performed offline to be queued locally,
So that no work is lost when I lose connectivity (FR45).

**Acceptance Criteria:**

**Given** Story 4.1 is complete
**When** I edit and save a note while offline
**Then** the save is appended as an entry to an `IndexedDB` object store `write_queue` with fields `{ id, vaultId, path, body, queuedAt, attempts }`
**And** the editor reports "Saved locally — pending sync" in the status bar
**And** the queue survives a full browser restart while still offline
**And** the queue badge in the status bar shows the pending count
**And** Vitest tests cover queue append, queue read, queue clear, and restart-survival via a fake-indexeddb adapter

---

### Story 4.3: Queue Replay on Reconnect

As a user,
I want my offline-queued saves to replay automatically when I'm back online,
So that my work syncs without manual action (FR46).

**Acceptance Criteria:**

**Given** Story 4.2 is complete
**When** the `online` event fires or a periodic poll detects connectivity returning
**Then** the replay loop drains the queue in `queuedAt` order, posting each entry to `/api/vaults/:vaultId/notes/:path`
**And** the loop is serial (one in-flight save at a time) to preserve gitService ordering
**And** a successful save removes the entry from the queue
**And** a failed save increments `attempts`, keeps the entry, and retries with exponential backoff capped at 5 minutes
**And** on a `GitConflictError` response, the entry is moved to a `conflict_queue` store and Story 4.4's UI is triggered for that note
**And** the status bar transitions syncing → idle when the queue is drained

---

### Story 4.4: Git Conflict Surface + 3-Pane Resolver UI

As a user,
I want a clear 3-pane diff when my save conflicts with a remote change, with explicit choices to keep mine, take theirs, or merge manually,
So that I never silently lose my edits (FR47, UX-DR11).

**Acceptance Criteria:**

**Given** Story 4.3 is complete and a queued save returns `GitConflictError`
**When** Story 4.4 is complete
**Then** the server returns 409 with a body containing `{ noteId, base, theirs, mine }` (three Markdown bodies)
**And** the PWA renders a full-screen 3-pane diff view with the three versions side-by-side
**And** three buttons: "Keep mine", "Take theirs", "Merge manually"
**And** "Keep mine" re-saves my body force-overwriting (server uses a `force=true` query param that the route honors)
**And** "Take theirs" discards my body and reloads
**And** "Merge manually" loads an editable merged version (initially `theirs`) and saves it on confirm
**And** the conflict entry is removed from `conflict_queue` on any of the three choices
**And** no resolution path silently discards user content — every branch either persists my work or is the explicit "Take theirs" choice

---

### Story 4.5: Status Bar — Sync State + Offline Indicator + Queue Count

As a user,
I want a persistent status bar that shows me whether my vault is in sync, offline, syncing, or in conflict, with the queue count when relevant,
So that I always know the state of my data (UX-DR6, UX-DR10).

**Acceptance Criteria:**

**Given** Stories 4.1–4.4 are complete
**When** Story 4.5 is complete
**Then** a bottom status bar is visible on every authenticated route
**And** it shows one of: `Synced` / `Syncing…` / `Offline — N pending` / `Conflict — needs review`
**And** the indicator color uses the accent token for `Syncing`, gold for `Offline`, and a distinct red token for `Conflict`
**And** the queue count is live-updated when queue entries are added/removed
**And** clicking `Conflict` opens the resolver for the first conflicting note

---

## Epic 5: Knowledge Discovery (Tier 1 + Tier 2 + Graph) — Stories

### Story 5.1: `MemoryProvider` Interface in `@lokyy/core`

As a developer,
I want a single `MemoryProvider` interface that abstracts Tier 1 and Tier 2 search,
So that the server, MCP, and Consolidation Agent all hit the same surface.

**Acceptance Criteria:**

**Given** `@lokyy/core` exports services from Stories 1.3–1.4
**When** Story 5.1 is complete
**Then** `packages/core/src/memory/MemoryProvider.ts` defines an interface with `search(vaultId, query, opts)`, `relatedNotes(vaultId, noteId, opts)`, `indexNote(vaultId, noteId)`, `removeNote(vaultId, noteId)`
**And** a no-op `NullMemoryProvider` exists for tests
**And** an architectural lint rule (or simple grep CI step) forbids any non-core module from importing pgvector or Ollama directly — they must go through `MemoryProvider`

---

### Story 5.2: Tier 1 Implementation — Structural Index

As a user,
I want full-text, wikilink, tag, and folder-scoped search over my vault,
So that I can find notes by keyword without depending on Ollama (FR15).

**Acceptance Criteria:**

**Given** Story 5.1 is complete
**When** Story 5.2 is complete
**Then** `packages/core/src/memory/Tier1Provider.ts` implements `MemoryProvider`
**And** it builds an in-memory inverted index over titles, body tokens, frontmatter `tags`, and wikilink targets, refreshed on every save
**And** `search(vaultId, "term", { fields: ["title","body","tags"] })` returns ranked results with snippet + score
**And** queries support tag filters (`tag:foo`), folder filters (`in:projects/`), and wikilink-target filters (`linksTo:[[Note]]`)
**And** for a vault of 5,000 notes, p95 query latency is < 100ms (measured by a benchmark in CI)

---

### Story 5.3: Tier 2 Implementation — Ollama + pgvector Embeddings

As a user,
I want semantically related notes returned even when my query terms don't match exactly,
So that I can find ideas, not just words (FR16).

**Acceptance Criteria:**

**Given** Stories 5.1, 5.2 are complete and Ollama is reachable with `nomic-embed-text`
**When** Story 5.3 is complete
**Then** `packages/core/src/memory/Tier2Provider.ts` implements `MemoryProvider`
**And** `indexNote` calls Ollama `/api/embeddings` with model `nomic-embed-text`, receives a 768-dim vector, and upserts into `note_embeddings`
**And** `search` runs an HNSW cosine similarity query and returns ranked notes with score
**And** `relatedNotes` runs a cosine-similarity query against the target note's embedding and excludes the target
**And** if Ollama is unreachable, `indexNote` throws `EmbeddingUnavailableError`, `search` falls back to Tier 1 transparently (with a flag in the response), and the server logs the failure
**And** for a vault of 5,000 notes with embeddings, p95 query latency is < 500ms (measured in CI)

---

### Story 5.4: Fire-and-Forget Tier 2 Sync Hook (Post-Save)

As a developer,
I want every successful note save to enqueue an asynchronous embedding update that never blocks the save or the request,
So that the user's write path stays fast even if Ollama is slow or down (Architecture Additional Req).

**Acceptance Criteria:**

**Given** Story 5.3 is complete
**When** `notesService.saveNote` returns successfully
**Then** an embedding refresh is enqueued via `setImmediate` / a small in-process queue, NOT awaited in the request handler
**And** if the embedding refresh throws `EmbeddingUnavailableError`, it is logged with `{ vaultId, noteId, error }` and silently dropped (no retry storm)
**And** unit tests with a slow stub Tier 2 provider confirm the save route returns in < 50ms even when the stub takes 5 seconds
**And** integration tests with Ollama killed mid-test confirm saves continue to succeed and the server stays healthy

---

### Story 5.5: Combined Search Route `POST /api/vaults/:vaultId/search`

As a user,
I want a single search endpoint that returns Tier 1 + Tier 2 results merged with provenance,
So that the PWA's search UI works against one shape (FR15, FR16).

**Acceptance Criteria:**

**Given** Stories 5.2 and 5.3 are complete
**When** Story 5.5 is complete
**Then** `POST /api/vaults/:vaultId/search` accepts `{ query, limit, tiers: ['t1','t2'] }`
**And** it returns `{ results: [{ noteId, title, snippet, score, tier }], degraded: false }`
**And** when Tier 2 is unavailable, `degraded: true` and `tier: 't1'` on all results
**And** results are merged with a reproducible deterministic order (Tier 1 first by score, then Tier 2 entries not already present)
**And** the route is guarded by `vaultMiddleware('read')`

---

### Story 5.6: Related-Notes Endpoint + Sidebar UI

As a user,
I want a "Related Notes" panel showing semantically close notes to the one I'm currently reading,
So that I discover connections without leaving the editor (FR17).

**Acceptance Criteria:**

**Given** Story 5.5 is complete
**When** Story 5.6 is complete
**Then** `GET /api/vaults/:vaultId/notes/:path/related` returns the top-N related notes from Tier 2 (with Tier 1 fallback)
**And** the PWA renders a "Related" section below the GraphView (or as a tab in the right panel) with up to 5 notes, each clickable
**And** the related list refreshes within 1 second after a save to the current note
**And** if the current note has no embedding yet, the list shows "Indexing…" instead of empty

---

### Story 5.7: GraphView Panel with `react-force-graph`

As a user,
I want a force-directed graph of my vault that highlights neighbors on hover and opens notes on click,
So that I can navigate my knowledge spatially (FR13, UX-DR5).

**Acceptance Criteria:**

**Given** Story 5.2 is complete (the structural index is the graph's data source)
**When** Story 5.7 is complete
**Then** `pwa/src/components/GraphView.tsx` renders a `react-force-graph-2d` instance with nodes = notes, edges = wikilinks
**And** node labels use the design tokens (accent on hover, gold on selection)
**And** hovering a node highlights direct neighbors (1-hop)
**And** clicking a node loads it in the editor
**And** the graph re-fetches its data via React Query whenever a save occurs in the current vault
**And** for a 5,000-note vault, initial render completes in < 2 seconds (measured with `performance.mark` and surfaced in DevTools)

---

## Epic 6: Content Import (Pipes) — Stories

### Story 6.1: Pipe Handler Framework + `pipeQueue` Status Surface

As a developer,
I want a clean handler-registration pattern in `pipeQueue` plus a status-listing endpoint,
So that adding new pipe types is mechanical and the PWA can show progress (FR23).

**Acceptance Criteria:**

**Given** `pipeQueue` is in `@lokyy/core` (Story 1.4)
**When** Story 6.1 is complete
**Then** `pipeQueue.registerHandler(type, handler)` registers a handler keyed by mime/type
**And** `pipeQueue.enqueue({ vaultId, type, payload })` returns a `jobId` and persists job state in Postgres
**And** `GET /api/pipes/jobs?vaultId=...` returns active + completed (last 50) jobs with `{ jobId, type, status, createdAt, completedAt, error?, resultNoteId? }`
**And** job status transitions through `queued → running → completed | failed` and is observable from the response
**And** integration tests cover registration, enqueue, status query, and failure path

---

### Story 6.2: YouTube Transcript Handler

As a user,
I want to drop a YouTube URL and get its transcript as a capture note,
So that I can pull video content into my vault (FR20).

**Acceptance Criteria:**

**Given** Story 6.1 is complete
**When** I `POST /api/pipes/youtube` with `{ vaultId, url }`
**Then** a job is enqueued and the YouTube handler fetches the transcript (via `youtube-transcript` or equivalent)
**And** on success, a new note is created at `30_captures/youtube/<slug>.md` with frontmatter `type: capture`, `source: youtube`, `url`, plus the auto-generated `id/title/created/updated`
**And** the body contains the transcript followed by a `## Metadata` section with video title, channel, duration
**And** if the video has no available transcript, the job ends `failed` with a clear error message
**And** the note is committed via `gitService` and passes the SPEC validation hook

---

### Story 6.3: Web Page Capture Handler

As a user,
I want to drop a web URL and get a cleaned, readable extraction of the page as a capture note,
So that I can save articles into my vault (FR21).

**Acceptance Criteria:**

**Given** Story 6.1 is complete
**When** I `POST /api/pipes/url` with `{ vaultId, url }`
**Then** the handler fetches the URL and runs a Readability-style extraction (`@mozilla/readability` or equivalent)
**And** a new note is created at `30_captures/urls/<slug>.md` with frontmatter `type: capture`, `source: url`, the canonical URL, and a `title` derived from the page
**And** body contains the extracted Markdown
**And** images are NOT downloaded for v1 — image URLs are preserved as-is with a note in the frontmatter `images_inlined: false`
**And** non-HTML responses fail the job with a clear error

---

### Story 6.4: Voice Recording Handler (Whisper Transcript)

As a user,
I want to upload an audio file and get its transcript as a capture note,
So that I can capture voice memos in the vault (FR22).

**Acceptance Criteria:**

**Given** Story 6.1 is complete
**When** I `POST /api/pipes/voice` with a multipart audio body (`audio/wav`, `audio/m4a`, `audio/mp3`)
**Then** the handler stores the raw file in `30_captures/voice/<slug>.<ext>`, calls a transcription backend (Whisper.cpp via subprocess, OpenAI Whisper API, or local Ollama-served STT — backend chosen per Story 6.4 spike), and produces a transcript
**And** a capture note is created at `30_captures/voice/<slug>.md` with frontmatter `type: capture`, `source: voice`, `audio_path: <relative path to audio file>`
**And** body contains the transcript
**And** the transcription backend is configurable via `pipe_voice_backend` in `system_config`

---

### Story 6.5: PDF Text Extract Handler

As a user,
I want to upload a PDF and get its text as a capture note,
So that I can pull PDF content into the vault.

**Acceptance Criteria:**

**Given** Story 6.1 is complete
**When** I `POST /api/pipes/pdf` with a multipart PDF body
**Then** the handler stores the raw PDF at `30_captures/pdfs/<slug>.pdf` and extracts text via `pdfjs-dist` or equivalent
**And** a capture note is created at `30_captures/pdfs/<slug>.md` with frontmatter `type: capture`, `source: pdf`, `pdf_path`, `page_count`
**And** body contains the extracted text segmented by page headers (`## Page 1` …)
**And** OCR is out of scope for v1 — scanned PDFs with no extractable text fail the job with a clear message

---

### Story 6.6: Pipes-Inbox Panel UI

As a user,
I want a slide-over panel that shows active and recent imports with per-job status,
So that I can see what's coming into my vault (UX-DR7, FR23).

**Acceptance Criteria:**

**Given** Stories 6.2–6.5 are complete
**When** I click the Pipes-Inbox icon in the FileTree header
**Then** a slide-over panel renders the last 50 jobs grouped by type (YouTube / URL / Voice / PDF)
**And** each row shows status (queued/running/completed/failed), age, and (on completed) a link to the produced note
**And** an "Import" button in the panel opens a typed form per pipe type (URL input for YouTube/URL, file upload for Voice/PDF)
**And** the panel auto-refreshes every 3 seconds while at least one job is in `queued` or `running`
**And** failed jobs show the error message inline and offer "Retry"

---

## Epic 7: AI Agent Integration (MCP) — Stories

### Story 7.1: `@lokyy/mcp` Workspace Bootstrap

As a developer,
I want a new pnpm workspace `mcp` that builds an MCP server using `@modelcontextprotocol/sdk` and imports `@lokyy/core` directly,
So that the MCP integration is colocated with the rest of the monorepo.

**Acceptance Criteria:**

**Given** Stories 1.2–1.4 are complete
**When** Story 7.1 is complete
**Then** `mcp/package.json` exists with `name: "@lokyy/mcp"`, `bin: { "lokyy-mcp": "./dist/bin.js" }`, dependencies on `@modelcontextprotocol/sdk@1.29.0` and `@lokyy/core`
**And** `mcp/src/server.ts` starts a stdio-transport MCP server
**And** `mcp/src/bin.ts` is the CLI entry that reads env vars (`LOKYY_VAULT_ID`, `LOKYY_AGENT_ID`, `LOKYY_DB_URL`) and starts the server
**And** `pnpm -r build` exits 0 and `dist/bin.js` is executable
**And** an end-to-end smoke test pipes a `tools/list` MCP request and gets a response

---

### Story 7.2: MCP Scope Resolver (`mcp-scopes.yaml`)

As a security architect,
I want the MCP server to load `00_meta/mcp-scopes.yaml` from the vault at startup, parse per-agent scopes, and enforce them on every tool call,
So that agents only see what they are allowed to see (FR28, Architecture additional req).

**Acceptance Criteria:**

**Given** Story 7.1 is complete
**When** Story 7.2 is complete
**Then** on server start, the MCP server reads `<vault>/00_meta/mcp-scopes.yaml` once, parses agents (`agent_id → { read_globs, write_globs, commit_prefix }`)
**And** if the file is missing or invalid, the server refuses to start with a clear error
**And** every tool invocation looks up the agent's scope and validates the target path with `micromatch` against the scope globs
**And** a path outside scope returns a typed MCP error `scope_violation` and is logged
**And** unit tests cover: read inside scope, read outside scope, write inside scope, write outside scope, no entry for agent (default deny)

---

### Story 7.3: MCP Tool — `read_note`

As an AI agent,
I want a `read_note` tool that returns the body and frontmatter of a scoped note,
So that I can use vault content as context (FR25).

**Acceptance Criteria:**

**Given** Story 7.2 is complete
**When** I call `read_note` with `{ path }`
**Then** the server validates `path` against my read globs
**And** if allowed, it returns `{ path, frontmatter, body }`
**And** if denied, it returns `scope_violation` with the disallowed path
**And** an integration test confirms an agent scoped to `30_captures/**` can read a capture note but not a note in `40_projects/`

---

### Story 7.4: MCP Tool — `search_vault` (Tier 1 + Tier 2)

As an AI agent,
I want to search the vault and get ranked results,
So that I can find context relevant to my task (FR18).

**Acceptance Criteria:**

**Given** Story 7.2 is complete and Epic 5 is in production
**When** I call `search_vault` with `{ query, limit }`
**Then** the server runs the combined Tier 1 + Tier 2 search using the same `MemoryProvider`
**And** results are filtered by my read globs (paths outside scope are silently dropped from results, not returned with a flag)
**And** the response shape matches the HTTP `/search` route's shape for parity
**And** if Tier 2 is unavailable, `degraded: true` is returned

---

### Story 7.5: MCP Tool — `related_notes`

As an AI agent,
I want to fetch notes semantically close to a given note,
So that I can pull in related context for reasoning (FR19).

**Acceptance Criteria:**

**Given** Story 7.4 is complete
**When** I call `related_notes` with `{ path }`
**Then** the server resolves the embedding for that path and returns the top-N closest notes
**And** results are filtered by my read globs
**And** if the target path is outside my scope, the call returns `scope_violation`

---

### Story 7.6: MCP Tool — `list_tree`

As an AI agent,
I want to retrieve the vault folder structure (filtered to my scope),
So that I can navigate the vault programmatically (FR27).

**Acceptance Criteria:**

**Given** Story 7.2 is complete
**When** I call `list_tree`
**Then** the server returns a nested folder/file tree
**And** only entries matching my read globs are included
**And** the response is stable between calls when the vault hasn't changed

---

### Story 7.7: MCP Tools — `create_note` and `update_note` with Commit Prefix

As an AI agent,
I want to create and update notes inside my write scope, with my commit prefix on every git commit,
So that my contributions are traceable (FR26, FR29, FR30).

**Acceptance Criteria:**

**Given** Story 7.2 is complete and Stories 1.5–1.7 are in production
**When** I call `create_note` or `update_note` with a path inside my write globs
**Then** the server creates/updates the note via `notesService` with SPEC-valid frontmatter (auto-fill `id` if creating)
**And** the git commit message is prefixed with my scope's `commit_prefix` (e.g. `[agent:consolidation] Add wikilinks to Note Foo`)
**And** the write is serialized through the gitService promise-lock — two MCP writes from different agents do not corrupt each other (FR29)
**And** a write outside my scope returns `scope_violation` and no file changes
**And** an integration test runs two MCP clients concurrently writing different notes and asserts both commits land cleanly with their respective prefixes

---

### Story 7.8: MCP Tool — `trigger_import`

As an AI agent,
I want to enqueue a YouTube/URL/Voice/PDF import,
So that I can bring external content into the vault on the user's behalf (FR24).

**Acceptance Criteria:**

**Given** Epic 6 is in production and Story 7.7 is complete
**When** I call `trigger_import` with `{ type, payload }`
**Then** the server validates the eventual write target against my write globs (capture notes go to `30_captures/<type>/`)
**And** the job is enqueued via `pipeQueue.enqueue` with the agent's `commit_prefix`
**And** the response includes the `jobId` so I can poll status if needed
**And** if my scope doesn't include `30_captures/<type>/`, the call returns `scope_violation`

---

## Epic 8: Autonomous Knowledge Consolidation — Stories

### Story 8.1: Consolidation Agent Scheduler (Scheduled + Manual)

As an admin,
I want the Consolidation Agent to run on a configurable schedule and also support manual triggering,
So that knowledge consolidation happens automatically with an escape hatch (FR31, FR37).

**Acceptance Criteria:**

**Given** Epic 7 is in production
**When** Story 8.1 is complete
**Then** the Consolidation Agent runs inside the MCP server process (or a sibling scheduler) and uses an MCP client with a dedicated agent identity (`agent:consolidation`)
**And** a cron-style schedule is configurable via `system_config.consolidation_schedule` (default daily at 03:00 local)
**And** `POST /api/admin/consolidation/run` triggers a run immediately (admin-only)
**And** each run logs `started_at`, `completed_at`, `notes_processed`, `proposals_written` to a `consolidation_runs` table
**And** if a run is already in progress, a second trigger no-ops with `{ status: 'already-running' }` (no overlap)

---

### Story 8.2: Wikilink Suggestion Logic

As the Consolidation Agent,
I want to scan recently changed notes and propose new wikilinks where notes mention concepts that match existing note titles,
So that the vault becomes denser over time (FR32).

**Acceptance Criteria:**

**Given** Story 8.1 is complete
**When** a consolidation run starts
**Then** the agent fetches notes with `updated > last_run` via `notesService`
**And** for each, it scans the body for token sequences that match existing note titles (case-insensitive, multi-word) and are not already wikilinked
**And** each candidate is materialized as a proposal `{ noteId, position, suggestedWikilink, confidence }`
**And** confidence threshold is configurable (default 0.7) — below the threshold, candidates are dropped
**And** unit tests cover: exact match, multi-word match, false-positive avoidance (common words), already-linked detection

---

### Story 8.3: Topic Note Creation Logic

As the Consolidation Agent,
I want to detect recurring concepts across the vault and propose a topic note that links to all occurrences,
So that emergent themes get a home (FR33).

**Acceptance Criteria:**

**Given** Story 8.2 is complete
**When** the agent runs
**Then** it identifies multi-note concept clusters using Tier 2 embeddings (cosine similarity > 0.85, min-cluster-size 3)
**And** if a cluster has no existing topic note, the agent proposes a new note with `type: note`, a generated `title`, and a body listing wikilinks to all cluster members
**And** the proposal is queued for user review, not committed directly
**And** proposed topic notes target `20_topics/<slug>.md`
**And** the agent does NOT propose more than 5 topic notes per run (rate limit to keep the review queue manageable)

---

### Story 8.4: Intervention Writer

As the Consolidation Agent,
I want every proposal serialized as a `type: intervention` note in `70_pai/interventions/`,
So that proposals are themselves part of the vault and survive across runs (FR34).

**Acceptance Criteria:**

**Given** Stories 8.2 and 8.3 are complete
**When** the agent produces a proposal
**Then** a new note is created at `70_pai/interventions/<run_id>-<seq>.md` with frontmatter `type: intervention`, `intervention_kind: 'wikilink' | 'topic_note' | 'other'`, `target_note_id`, `proposed_action`, `confidence`, `status: 'pending'`
**And** the body documents the proposed change in human-readable form with a "before" and "after" excerpt
**And** these notes are written via `gitService` with the consolidation commit prefix
**And** they are SPEC-valid and survive the pre-commit hook

---

### Story 8.5: Intervention Review API

As an admin,
I want endpoints to list pending interventions and to accept/reject/ignore each one,
So that the PWA can build a review UI on top (FR35, FR36).

**Acceptance Criteria:**

**Given** Story 8.4 is complete
**When** Story 8.5 is complete
**Then** `GET /api/vaults/:vaultId/interventions?status=pending` returns the list with full proposed-action detail
**And** `POST /api/vaults/:vaultId/interventions/:id/accept` applies the proposed change via `gitService.save` (with a normal commit message, NOT the consolidation prefix — accepted changes are the user's edits), updates the intervention note's `status: accepted` field, and bumps `updated`
**And** `POST /api/vaults/:vaultId/interventions/:id/reject` sets `status: rejected` and writes back
**And** `POST /api/vaults/:vaultId/interventions/:id/ignore` sets `status: ignored`
**And** no proposal mutation reaches the rest of the vault unless the user explicitly accepts (FR36)
**And** integration tests cover the full accept / reject / ignore lifecycle

---

### Story 8.6: Intervention Review UI

As a user,
I want a review screen where I can flip through pending consolidation proposals and decide individually,
So that I can absorb improvements without losing control (FR35).

**Acceptance Criteria:**

**Given** Story 8.5 is complete
**When** Story 8.6 is complete
**Then** `/vaults/:vaultId/interventions` lists pending proposals with a "next/prev" card flow
**And** each card shows the target note, the proposed change as a before/after diff, the confidence, and three buttons: Accept / Reject / Ignore
**And** keyboard shortcuts: `A` accept, `R` reject, `I` ignore, `→` next, `←` prev
**And** a per-vault count badge in the FileTree header shows the pending intervention count
**And** an empty state ("All caught up — no pending proposals") is shown when the list is empty
