---
stepsCompleted: ["step-01-init", "step-02-discovery", "step-02b-vision", "step-02c-executive-summary", "step-03-success", "step-04-journeys", "step-05-domain", "step-06-innovation", "step-07-project-type", "step-08-scoping", "step-09-functional", "step-10-nonfunctional", "step-11-polish"]
releaseMode: phased
inputDocuments:
  - "_bmad-output/planning-artifacts/product-brief-lokyy-brain.md"
  - "_bmad-output/planning-artifacts/product-brief-lokyy-brain-distillate.md"
  - "docs/mockup/README.md"
  - "CLAUDE_CODE_AUFTRAG.md"
  - "README.md"
workflowType: 'prd'
classification:
  projectType: "saas_b2b+web_app_pwa"
  domain: "knowledge-management-developer-tools"
  complexity: "high"
  projectContext: "brownfield"
briefCount: 2
researchCount: 0
brainstormingCount: 0
projectDocsCount: 3
---

# Product Requirements Document - lokyy-brain

**Author:** Oliver
**Date:** 2026-05-14

## Executive Summary

lokyy-brain is a self-hosted Second Brain platform for the post-MCP era. It provides a unified knowledge layer accessible to humans (PWA with CodeMirror 6 editor and force-directed knowledge graph) and AI agents (Model Context Protocol server with scoped read/write access). The data model is Markdown files version-controlled by Git, with Forgejo as the remote source of truth — every index is derived and rebuildable; data ownership is unconditional.

The platform targets privacy-conscious knowledge workers, developers, and small teams (2–20 people) who need a self-hosted knowledge base with first-class AI agent integration. It addresses three failures of existing tools: data sovereignty locked behind proprietary cloud sync, AI integration bolted on without write-back capability or agent scoping, and knowledge that never actively compounds because no tool operates on the vault when the human is absent.

The defining capability is the **Consolidation Agent** — a scheduled process that examines changed notes, adds missing wikilinks, creates topic notes for recurring concepts, and writes discovered insights back into the vault via the same Git service as every other write. The vault grows richer without user effort.

The system supports a **dual-vault architecture**: each user maintains a private personal vault alongside shared company vaults with role-based permissions. A guided **Setup Wizard** covers both local and remote server installation, creating the admin account and configuring all services without manual `.env` editing.

This is a brownfield project. The existing Hono server, CM6 editor, gitService, notesService, graphService, and pipe queue form the working baseline. v1 refactors these into a shared `packages/core` layer, adds Auth and the Setup Wizard, implements Memory Tiers 1+2 (structural wikilink index + semantic vector search via nomic-embed-text + pgvector), delivers the MCP server workspace, and ships the Consolidation Agent with a review UI.

### What Makes This Special

No existing PKM tool was built ground-up for the MCP era. Competitors treat AI as a feature addition; lokyy-brain treats AI agents as first-class citizens with scoped vault access, write-back capability, commit-prefix audit trails, and simultaneous multi-agent operation. The defensible moat is the coherent combination of three properties: **Git-as-truth** (unconditional data sovereignty, rebuild-from-source guarantee, version history), **MCP-native architecture** (standardized agent interface, not a bolt-on), and **autonomous consolidation** (vault enrichment during idle time — no existing tool has shipped this). Each property can be copied individually; the coherent combination requires architectural intent from day one.

The Consolidation Agent embodies the core product insight: a Zettelkasten collapses under its own weight without constant curation. lokyy-brain eliminates the curation bottleneck by running synthesis on a schedule, making the vault an active asset rather than a passive archive.

## Success Criteria

### User Success

- **Day 1:** Oliver installs without manual `.env` editing via Setup Wizard; creates first note; completes first Pipe import (YouTube/URL); Consolidation Agent runs the first night and produces at least one useful wikilink or topic note
- **Daily driver:** Vault opened daily with zero friction on save, search, and import; offline PWA covers connection loss without data loss
- **Agent delight:** External MCP client connects, reads via `search_vault`, writes SPEC-valid frontmatter — all traceable in the commit log
- **Team vault:** Second user joins a company vault, writes a note, personal vault remains inaccessible to others

### Business Success

- **3 months:** System running stably on Oliver's production setup; no critical data loss incidents; Consolidation Agent measurably enriches vault
- **12 months:** ≥500 active self-hosted installations (definition: ≥1 vault commit in the past 30 days); positive signal on Hacker News or GitHub (≥200 stars); ≥1 third-party AI system integrated via MCP
- **24 months:** lokyy-brain cited as reference MCP knowledge server in at least one external publication or tool integration; third-party plugin API documented and in use

### Technical Success

- `pnpm -r build` green on every merge to main
- Semantic search returns relevant results in < 500ms for vaults up to 5,000 notes
- Consolidation Agent completes without crashing; hard upper bound prevents runaway runs
- Pre-commit hook never blocks valid frontmatter; invalid frontmatter errors surface to PWA and MCP as a distinct error type
- Git operations serialized — no race conditions under concurrent multi-agent writes
- Offline PWA replays save queue fully on reconnect without data loss

### Measurable Outcomes

| Metric | Target | Timeframe |
|--------|--------|-----------|
| Active installations | ≥500 | 12 months |
| GitHub Stars | ≥200 | 12 months |
| Third-party MCP integrations | ≥1 | 12 months |
| Build green rate | 100% on main | ongoing |
| Search latency (p95) | < 500ms | v1 |
| Enterprise licensing active | First commercial license | 24 months |

## Product Scope

### MVP — v1 Feature Set

1. **Rename + lokyy-vault Setup** — `sternwarte` → `lokyy-brain`, `@sternwarte/*` → `@lokyy/*`; lokyy-vault repo with SPEC/schemas/hook
2. **Core Refactor + Vault Compliance** — `packages/core`, frontmatter utility (ULID + gray-matter + ajv), SPEC-valid notesService, hook error type, pipe target to `30_captures/`
3. **Auth + Setup Wizard** — multi-user, dual-vault (personal + company), RBAC per vault (read/write/admin); interactive Setup Wizard for local + remote; admin account creation
4. **Memory Tier 1+2** — `MemoryProvider` interface in core; structural index (wikilinks/tags/full-text); semantic index (nomic-embed-text + pgvector); `search_vault`, `related_notes`; fire-and-forget sync
5. **MCP Server Workspace** — `@lokyy/mcp`, MCP-SDK, scoped tools, stdio transport, scoping from `00_meta/mcp-scopes.yaml`
6. **Consolidation Agent** — cron scheduler, MCP-based, SPEC-compliant writes, review UI (accept/reject/ignore per intervention), last-run marker in `70_pai/memory/`
7. **PWA Completion** — react-force-graph graph view, IndexedDB offline layer (save queue + replay)

**MVP Strategy:** Platform MVP — individual features have no value without the platform foundation (no MCP without Auth and Core; no Consolidation Agent without MCP and Memory Tier 1+2). Resource requirement: senior fullstack developer (TypeScript, Node, Postgres, PWA) with Git-internals and MCP-SDK experience; AI agents for all implementation stories.

**Internal Milestone — "Minimum Viable Brain":** Within v1 there is a natural mid-point: Setup Wizard + Single-User Auth + CM6 Editor + Tier 1+2 Search + Basic MCP. This milestone de-risks the more complex epics (Multi-Vault, Consolidation Agent) and delivers core value early. The full v1 scope is unchanged; this is an internal stability target, not a feature cut.

### Growth Features (Post-MVP)

- **v1.1:** Obsidian vault migration tooling — primary acquisition lever; after v1 stabilization
- SSO / LDAP / OAuth integration
- Plugin API for community agents
- Self-hosted Whisper transcription (full voice import)
- Tier 3 temporal knowledge graph (Graphiti — after real Tier 1+2 production usage)

### Vision

lokyy-brain as a knowledge node in personal and organizational AI operating systems. Every agent a user runs — assistant, coding agent, research agent — reads from and writes to the same unified knowledge base via MCP. AGPL core + enterprise dual-licensing.

### Scope Risk Mitigation

- *Riskiest assumption:* MCP SDK + Git serialization + pgvector + IndexedDB offline in one v1 release is tight. Epic sequence respects dependencies; no epic begins without a stable Core foundation.
- *Forgejo hard-dependency:* 4-service stack raises installation barrier. Open question for Architecture Doc: bare git remote as alternative for simpler setups.
- *Consolidation Agent quality:* Poor agent output erodes user trust rapidly. Review UI is mandatory in v1; no autonomous commit without user approval.
- *v1 over-scoped (7–8 complexity domains):* Mitigation via "Minimum Viable Brain" milestone; sequential epic work prevents parallel WIP accumulation.

## User Journeys

### Journey 1: Oliver — First Installation (Primary User, Day 1)

Oliver has a fresh Hetzner VPS ready. He clones `lokyy-brain`, opens the browser, navigates to `:3000/setup` — and sees a guided wizard, not a blank `.env.example`.

**Step 1 — Vault Setup (branch point):**
- **Option A — New Vault:** Oliver enters a repo name; the wizard uses a Forgejo API token to create the repo, commits the base vault structure (SPEC, schemas, pre-commit hook, folder skeleton) with the first commit. Requires a Forgejo admin token.
- **Option B — Existing Vault:** Oliver enters the repo URL. The wizard clones it and validates that `00_meta/SPEC.md` and `00_meta/schemas/` are present. If SPEC is missing, the wizard shows a clear error — not a silent failure.

**Step 2 — Services:** Postgres connection string (wizard tests connection inline, shows green/red). Ollama endpoint for nomic-embed-text — or skip Tier 2 for now.

**Step 3 — Admin Account:** Email + password. Click Install. 30 seconds later the PWA opens.

Oliver opens an existing note — frontmatter is validated, wikilinks light up. He imports a YouTube link via the Pipes panel. 90 seconds later the transcript lands as a `capture` note in `30_captures/youtube/`. That night the Consolidation Agent runs. Next morning: three new wikilinks between notes he hadn't connected himself. He accepts them with one click.

**Capabilities revealed:** Setup Wizard with vault branch (new/existing), Forgejo API integration, SPEC validation, Pipe import, Consolidation Agent review UI, ULID frontmatter generation.

---

### Journey 2: Lena — Company Vault (Secondary User, Team Knowledge)

Lena runs an 8-person consultancy. The team loses knowledge when projects end. Oliver, already running an instance, creates a company vault `contoso-company` and invites Lena as Admin. She adds three colleagues as Writers. Each keeps their private personal vault — but in the company vault they jointly write decisions, meeting notes, and customer dossiers.

Lena asks her MCP client: *"What did we decide about client Müller last year?"* The agent searches semantically across all company vault notes and returns the ADR in 2 seconds.

A colleague leaves the firm. His personal vault stays private. Company vault contributions remain fully intact, versioned, attributable — Git history shows every commit with author tag.

**Capabilities revealed:** Multi-vault, RBAC (read/write/admin per vault), user management, vault isolation, MCP search over company scope, Git audit trail.

---

### Journey 3: Admin — System Health (Operations User)

Oliver notices the Consolidation Agent hasn't completed a run in 3 days. He opens the admin panel, checks the last-run timestamp in `70_pai/memory/`. The error log shows: Ollama unreachable. He restarts Ollama, triggers a manual agent run from the admin UI.

The run starts, processes 47 unreviewed notes, writes 12 interventions. Oliver reviews them in the review UI: accepts 9, rejects 2, ignores 1. The vault is synchronized again.

**Capabilities revealed:** Admin panel, Consolidation Agent monitoring, manual trigger, error logging, review UI (accept/reject/ignore), last-run marker.

---

### Journey 4: Claude (AI Agent) — MCP Integration (API Consumer)

Oliver configures Claude Desktop with a lokyy-brain MCP server. On startup the server reads `00_meta/mcp-scopes.yaml` and assigns Claude the `personal` scope — read/write on `20_notes/**` and `30_captures/**`, commit_prefix `[claude]`.

Oliver asks Claude: *"Create a structured note about today's customer call."* Claude calls `write_note`, generates a ULID, creates valid `meeting` frontmatter, commits via gitService. Oliver later asks: *"What do I know about Postgres optimization?"* Claude calls `search_vault` — semantic search returns 4 relevant notes from Tier 2 that Oliver had never linked.

A second MCP client (company agent) runs concurrently with its own scope. Both write to different vault areas. The promise-lock serialization in gitService prevents conflicts. Every commit carries its `commit_prefix` — full audit trail.

**Capabilities revealed:** MCP scoping via YAML, `write_note` with SPEC-valid frontmatter, `search_vault` (Tier 2 semantic), git serialization, commit-prefix audit trail, concurrent multi-agent access.

---

### Journey 5: Oliver — Offline Recovery (Edge Case)

Oliver is on a train with no connection. He opens the PWA — the IndexedDB cache version of his vault is available. He writes a note and saves. The PWA queues the save in IndexedDB and shows an "offline — queued" badge. He saves two more notes. The train arrives.

The PWA detects reconnect and replays all three saves sequentially through gitService (add → commit → pull --rebase → push). No conflict because he was the only one editing those notes. If an agent had written in parallel, the rebase surfaces the conflict explicitly — not silently discards it.

**Capabilities revealed:** IndexedDB offline layer, save queue, reconnect replay, git pull --rebase conflict handling, offline UI indicator.

---

### Journey Requirements Summary

| Capability Area | Journeys |
|----------------|---------|
| Setup Wizard (new vault / existing vault branch) | 1 |
| Forgejo API integration (repo creation + SPEC validation) | 1 |
| Vault clone, pull, push | 1, 5 |
| Auth + RBAC per vault | 2, 3 |
| Multi-vault + user management | 2 |
| Pipe import (YouTube, URL) | 1 |
| Consolidation Agent + review UI | 1, 3 |
| Admin panel + monitoring | 3 |
| MCP server + scoped tools | 4 |
| Semantic search (Tier 2) | 2, 4 |
| Git audit trail + commit prefix | 2, 4 |
| Offline PWA + save queue | 5 |
| SPEC-valid frontmatter generation | 1, 4 |

## Domain-Specific Requirements

### Privacy & Data Sovereignty

- **GDPR:** lokyy-brain stores personal notes and potentially customer/meeting data. Since self-hosted, GDPR responsibility lies with the operator — lokyy-brain must provide clear data export and deletion paths
- **Data residency:** All data stays on the operator's server — no telemetry call-home, no external service except the Forgejo remote (user-configured) and Supadata (Pipes, optional)
- **Vault isolation:** A user's personal vault must never be readable by other users — isolation enforced server-side, not at the UI layer
- **Git history:** Sensitive data could end up in git history. v1 documents best practices; secret-scanning is not a v1 feature

### Security Architecture

- **MCP write-back + Prompt Injection:** Pipes import web content → Consolidation Agent processes it → potential exploit vector. Mitigation: agent output is never committed without user review; imported content is sanitized before agent processing
- **MCP scope enforcement:** Default deny. Every MCP client receives only explicitly granted read/write globs from `00_meta/mcp-scopes.yaml`. Scope is enforced server-side — clients cannot expand their own scope
- **Multi-user vault separation:** Company vault permissions are checked server-side on every read/write — never client-side
- **Forgejo token security:** Git remote token stored in `.env`, never committed to vault, never exposed in API responses

### Technical Constraints

- **Git as write serializer:** All write operations must go through the gitService promise-lock — no direct filesystem writes bypassing git
- **Frontmatter integrity:** No `.md` commit without valid SPEC frontmatter. Pre-commit hook is the last defense — notesService is the first. Hook failure surfaces as a distinct error type (not generic git error)
- **Embedding privacy:** nomic-embed-text runs locally via Ollama — no note content leaves the server for embedding generation. External embedding APIs are forbidden
- **Offline queue integrity:** IndexedDB save queue must never silently discard data on replay. Conflicts must be surfaced to the user

### Self-Hosting Constraints

- **Deployment requirements:** git CLI, Node.js runtime, Postgres, Ollama, Forgejo SSH access. Setup Wizard documents minimum requirements (RAM, disk) before installation begins
- **4-service stack:** Forgejo + Postgres + Ollama + lokyy-server — wizard walks through all four; post-install health check verifies all services
- **Updates:** No auto-updates without explicit user action. Migrations (DB schema, vault SPEC versions) must be idempotent

## Innovation & Novel Patterns

### Detected Innovation Areas

**1. MCP-Native PKM Architecture (Paradigm Shift)**
No existing PKM tool was built ground-up for the MCP era. Obsidian, SilverBullet, Logseq, Trilium — all treat AI as a bolt-on feature. lokyy-brain treats AI agents as first-class citizens with scoped access, write-back capability, and commit-prefix audit trail from day one. This is an architectural principle, not a UI plugin.

**2. Consolidation Agent — Autonomous Knowledge Synthesis (Novel Category)**
No PKM tool has shipped a system that actively works on the knowledge base when the human is absent. Zettelkasten curation is manual and collapses under its own weight. The Consolidation Agent eliminates the curation bottleneck: runs on schedule, adds missing wikilinks, creates topic notes, writes insights back — all via the same MCP interface as any external agent, with a review UI for user control.

**3. Defensible Moat Through Combination**
Any competitor can copy one of the three properties. The coherent combination requires architectural intent from day one:
- **Git-as-Truth**: Unconditional data sovereignty, rebuild-from-source guarantee, full version history
- **MCP-Native**: Standardized agent interface, not a bolt-on
- **Autonomous Consolidation**: Vault enrichment at idle time — no competitor has shipped this

### Market Context & Competitive Landscape

- MCP standardized November 2024; Google Cloud and Microsoft Azure have adopted it — timing window is open
- Obsidian pricing backlash ($96/year for sync) has created an active migration window among power users
- Enabling technology is mature: local embedding models (Ollama/nomic-embed-text), MCP SDKs, PWA Offline APIs

| Competitor | Git-as-Truth | MCP-Native | AI Writes Back | Consolidation Agent |
|---|---|---|---|---|
| Obsidian | Partial (local) | No | No | No |
| SilverBullet | Yes | No | No | No |
| Logseq | Yes | No | No | No |
| Trilium | No (DB-backed) | No | No | No |
| **lokyy-brain** | **Yes** | **Yes** | **Yes (scoped)** | **Yes** |

### Validation Approach

- **MCP-Native:** Day-1 — Claude Desktop connects, reads via `search_vault`, writes SPEC-valid frontmatter via `write_note`, all traceable in commit log. 12-month signal: ≥1 external AI system integrating via MCP
- **Consolidation Agent:** Night-1 — agent runs, produces at least one useful wikilink or topic note. Vault richness (wikilink density, topic note count) grows without manual effort
- **AI OS Vision:** External agents (coding agent, research agent) reading from and writing to the same vault via MCP — documented as reference use case

### Innovation Risk Mitigation

- *Consolidation Agent noise:* Review UI (accept/reject/ignore) — no autonomous commit without user approval; hard run-time upper bound; Pipes content sanitized before processing
- *MCP adoption niche:* lokyy-brain is fully usable without MCP; MCP is an extension, not a required path; AGPL release creates community pull independently
- *4-service stack complexity:* Setup Wizard eliminates manual `.env`; post-install health check verifies all services; Forgejo vs. bare git remote decision carried to Architecture Doc

## Platform Architecture Requirements

### Multi-Tenancy & Vault Isolation

- **Dual-Vault Architecture:** Each user owns exactly one personal vault (private, never accessible to others) and may be a member of any number of company vaults
- **Vault Isolation:** Enforced server-side on every read/write operation — never client-side. A user can never read another user's personal vault, including via direct API access
- **Company Vault Use Case:** Shared organizational knowledge (decisions, meetings, customers, projects); all contributions versioned and attributable via Git commit history with author tags
- **Vault Types:** `personal` (1 per user, auto-created on account creation), `company` (n per installation, admin-created)

### RBAC Matrix

| Role | Personal Vault (own) | Company Vault: Read | Company Vault: Write | Company Vault: Admin |
|---|---|---|---|---|
| Owner (personal) | Full | — | — | — |
| Reader | — | ✓ | ✗ | ✗ |
| Writer | — | ✓ | ✓ | ✗ |
| Admin | — | ✓ | ✓ | ✓ (user mgmt) |

- **v1 Granularity:** Per-vault RBAC (no per-folder or per-note permissions in v1)
- **MCP Scoping:** Orthogonal to RBAC — defined in `00_meta/mcp-scopes.yaml`; enforced server-side; default deny

### Integration Requirements

| Integration | Purpose | Required | Notes |
|---|---|---|---|
| Forgejo | Git remote (truth store) | Yes (v1) | HTTP API + SSH |
| Postgres + pgvector | Auth, semantic index | Yes (v1) | Postgres ≥14 with pgvector extension |
| Ollama + nomic-embed-text | Local embedding generation | Yes (v1) | Tier 2 semantic search; no content leaves server |
| Supadata | Pipes: YouTube transcript, web scrape | Optional (v1) | External API; user-configured |
| MCP Clients (Claude Desktop, etc.) | Agent interface | Yes (v1) | stdio transport |

### Licensing & Monetization

- **Deployment Model:** 100% self-hosted — the system is always operated on the user's or organization's server. No managed Cloud offering planned.
- **v1:** AGPL open source, no paywall; GitHub Sponsors as early monetization signal
- **Enterprise Dual-Licensing:** AGPL community + commercial enterprise license — covers regulated industries, SLA requirements, and organizations with AGPL on their legal blacklists (pattern: Nextcloud, MariaDB, GitLab)

### PWA Specifications

- **App Model:** Single-Page Application (Vite + React 18) — explicitly NOT Next.js (SPA simpler, no SSR required)
- **PWA Layer:** `vite-plugin-pwa` with Service Worker; offline mode via IndexedDB
- **Browser Support:** Modern evergreen browsers (Chrome, Firefox, Safari); PWA baseline; no IE/legacy support
- **Real-time Updates:** SSE or polling for Pipe import status and Consolidation Agent progress (no WebSocket required in v1)

## Functional Requirements

### Installation & Setup

- **FR1:** Admin can install the system via an interactive guided wizard without manually editing configuration files
- **FR2:** Admin can configure a new Forgejo repository as the vault through the Setup Wizard
- **FR3:** Admin can link an existing Forgejo repository as the vault through the Setup Wizard, with SPEC validation
- **FR4:** Admin can configure Postgres connection, Ollama endpoint, and vault URL through the Setup Wizard
- **FR5:** Admin can re-run the Setup Wizard without losing existing data
- **FR6:** Admin can change the vault URL in system settings after initial installation

### Note & Vault Management

- **FR7:** User can create a new note with auto-generated schema-valid frontmatter (ULID, type, title, created timestamp)
- **FR8:** User can edit note content and frontmatter in a live-preview Markdown editor
- **FR9:** User can save notes to the vault via Git commit
- **FR10:** User can navigate the vault through a file tree organized by the vault folder structure
- **FR11:** User can rename or move a note without breaking existing wikilinks
- **FR12:** User can create and follow wikilinks between notes
- **FR13:** User can visualize note connections as an interactive graph
- **FR14:** User can create folders and organize notes within the vault structure

### Knowledge Discovery & Search

- **FR15:** User can search notes by keywords, tags, and wikilinks
- **FR16:** User can find semantically related notes without exact keyword matches
- **FR17:** User can discover notes related to a currently viewed note
- **FR18:** AI agent can search the vault semantically via a dedicated MCP tool
- **FR19:** AI agent can discover related notes for a given note via a dedicated MCP tool

### Content Import (Pipes)

- **FR20:** User can import YouTube video transcripts as capture notes
- **FR21:** User can import web page content as capture notes
- **FR22:** User can upload voice recordings for storage as capture notes
- **FR23:** User can view the status of active and completed import jobs
- **FR24:** AI agent can trigger a content import via a dedicated MCP tool

### AI Agent Integration (MCP)

- **FR25:** AI agent can read notes within its defined scope
- **FR26:** AI agent can create and update notes with schema-valid frontmatter
- **FR27:** AI agent can retrieve the vault folder structure
- **FR28:** Each AI agent's read/write scope and commit prefix is defined per-agent in a vault configuration file
- **FR29:** Multiple AI agents can write to the vault concurrently without data conflicts
- **FR30:** Every AI agent write is traceable in the Git commit log with the agent's commit prefix

### Autonomous Knowledge Consolidation

- **FR31:** System can run the Consolidation Agent on a configurable schedule
- **FR32:** Consolidation Agent can add missing wikilinks between related notes
- **FR33:** Consolidation Agent can create topic notes for recurring concepts across the vault
- **FR34:** Consolidation Agent can write discovered insights to a designated interventions folder
- **FR35:** User can review proposed Consolidation Agent interventions and accept, reject, or ignore each individually
- **FR36:** No Consolidation Agent write is committed to the vault without user review and acceptance
- **FR37:** Admin can trigger a Consolidation Agent run manually

### User & Access Management

- **FR38:** Admin can create and manage user accounts
- **FR39:** Each user automatically has a private personal vault inaccessible to all other users
- **FR40:** Admin can create company vaults and assign users with read, write, or admin roles per vault
- **FR41:** User can authenticate with email and password
- **FR42:** Users can only access vaults for which they have been explicitly granted permission, enforced server-side
- **FR43:** Admin can revoke a user's access to a company vault without affecting their personal vault

### Offline & Synchronization

- **FR44:** User can read and edit notes while offline
- **FR45:** User can save notes while offline; changes are queued automatically for later sync
- **FR46:** The PWA automatically replays queued saves in sequence on reconnection
- **FR47:** The system surfaces Git merge conflicts explicitly to the user rather than silently discarding changes

### Administration & Monitoring

- **FR48:** Admin can view the availability status of all required services (Forgejo, Postgres, Ollama)
- **FR49:** Admin can view the Consolidation Agent's last-run timestamp and error log
- **FR50:** Admin can trigger a manual Consolidation Agent run from the admin interface
- **FR51:** System surfaces pre-commit hook frontmatter validation failures as a distinct error type, not a generic Git error

## Non-Functional Requirements

### Performance

- **NFR-P1:** Semantic search (Tier 2) returns results in < 500ms for vaults up to 5,000 notes (p95)
- **NFR-P2:** Note save (including Git commit) completes in < 3 seconds under normal network conditions
- **NFR-P3:** The editor remains responsive during background index sync — no perceptible input lag
- **NFR-P4:** The knowledge graph renders and responds to interaction for vaults up to 5,000 notes without page freeze
- **NFR-P5:** YouTube Pipe import completes within 120 seconds for videos up to 60 minutes

### Security

- **NFR-S1:** User passwords are hashed with bcrypt (cost factor ≥ 12); plaintext passwords are never stored or logged
- **NFR-S2:** Session tokens have a configurable lifetime (default: short) with refresh; expired tokens are rejected server-side
- **NFR-S3:** HTTPS is required in production; the application documents that a reverse proxy with TLS is mandatory
- **NFR-S4:** Personal vault data is never accessible to other users — enforced at the API layer on every request, never only at UI layer
- **NFR-S5:** MCP agent scope is enforced server-side; no client can expand its own read/write permissions beyond what is defined in `mcp-scopes.yaml`
- **NFR-S6:** Forgejo access tokens and other secrets are stored in environment variables and never appear in API responses, logs, or vault commits
- **NFR-S7:** Content imported via Pipes is sanitized before being processed by the Consolidation Agent

### Data Integrity

- **NFR-D1:** All write operations are serialized through gitService with a promise-lock; no direct filesystem writes bypass Git
- **NFR-D2:** The offline save queue never silently discards data; failed replay operations surface a distinct error to the user
- **NFR-D3:** Pre-commit hook frontmatter validation failures halt the commit and return a typed error; they do not produce a generic Git error
- **NFR-D4:** Memory index sync failure (Tier 2/Ollama) never prevents note saves or server startup — Forgejo commit goes first, index sync is fire-and-forget

### Reliability

- **NFR-R1:** The Consolidation Agent has a hard execution time upper bound per run; it cannot run indefinitely
- **NFR-R2:** When Ollama is unavailable, the system continues to function for all read/write operations; Tier 2 search degrades gracefully (Tier 1 remains available)
- **NFR-R3:** When the Forgejo remote is temporarily unreachable, the system operates in offline mode; queued saves replay on reconnect
- **NFR-R4:** Database schema migrations are idempotent; running a migration twice produces the same result as running it once

### Accessibility

- **NFR-A1:** The PWA meets WCAG 2.1 AA compliance level; accessibility acceptance criteria are explicitly defined per PWA story

---

## Section 7 — Cognitive Loop Vision (added 2026-05-25 after research synthesis)

> Vollständige Architektur-Doku: `vault://10_projects/lokyy-brain/vision-cognitive-loop-v2.md`. Diese Section fasst die für das PRD relevanten Anforderungen zusammen.

### Framing

Lokyy-Brain positioniert sich als die ernsthafte Implementation von Andrej Karpathys "LLM Wiki"-Vision (Gist vom 4. April 2026, 17M views): Vault als kollaborativ vom LLM gepflegtes Wissens-Codebase. PLUS die Lücke die Karpathy explizit hand-waved: die **Lint-Operation** (Widerspruchs-Erkennung, Orphan-Detection, Cross-Reference-Konsistenz, Schema-Drift-Flagging).

Diese Vision ist konvergent validiert durch drei unabhängige Research-Stränge (Mai 2026):
- **Neuroscience + Cognitive Science** — Complementary Learning Systems (McClelland et al. 1995), Spreading Activation (Collins & Loftus 1975), Encoding Specificity (Tulving 1973), Synaptic Homeostasis (Tononi 2003), Power-Law Forgetting (Anderson & Schooler 1991), Recognition-vs-Recall (Yonelinas 2002)
- **AI Memory-Systems State-of-the-Art** — Mem0 (best LoCoMo 92.5%), Letta/MemGPT (filesystem-as-memory 74%), Graphiti (bi-temporal edges), HippoRAG (PPR over KG, +20.9pp multi-hop), GraphRAG (community summaries), RAPTOR, Self-RAG, HyDE
- **Production Engineering** — pgvector HNSW + ParadeDB pg_search + Late Chunking + RRF Hybrid + bge-reranker-v2-m3 + Lost-in-Middle Layout

### Functional Requirements (additive)

- **FR-CL1: Importance-Scoring** — Jede Note trägt einen computed `importance_score` (0-1) im frontmatter, kombiniert aus Origin-Type, Recency-Decay, Backlink-Count, User-Touch-Signal und Co-Citation-Strength
- **FR-CL2: Power-Law Recency-Decay** — `recency_score = 1 / (1 + (age_days / half_life)^1.2)` mit type-spezifischen Half-Lives (decision=720d, project=540d, note=180d, meeting=90d, customer=365d, capture=30d). Touch (Lese/Edit/neues incoming Wikilink) resetet recency
- **FR-CL3: Retrieval-Trace-Log** — Jede Note-Access (search/wikilink/cmd-k/cmd-o/hover/embed) schreibt ein `retrieval_traces`-Row mit (note_id, session_id, source, query, preceding_notes, context)
- **FR-CL4: Multi-Chunk Embeddings** — Pro Note werden mehrere Embedding-Chunks erzeugt: title, body_full (für Notes ≤6000 tokens via Late Chunking), section (H2-Boundaries), sliding_3para (für lange Notes). Anchor-Text-Injection (`{title}\n{H1 > H2 > H3}\n\n{chunk}`) vor jedem embed
- **FR-CL5: Hybrid Retrieval mit Intent-Routing** — Query wird klassifiziert in (exact_recall, topical, associative, question). Hybrid-Retrieval via SQL-CTE: BM25 (pg_search) + Dense (pgvector HNSW), fusioniert mit RRF (k=60). α-Gewichtung dynamisch per Intent
- **FR-CL6: Spreading Activation / Personalized PageRank** — Für associative-intent: RRF-Top-20 als PPR-Seeds, Personalized PageRank über Wikilink-Graph (α-personalization=0.15, damping=0.5), fused mit RRF-Liste
- **FR-CL7: Encoding-Context-Match Boost** — Frontmatter-Block `encoded:` (device, app_state, time_of_day, weekday, preceding_notes, session_duration) wird beim Retrieval mit aktueller Session abgeglichen — Match boostet Result um 1.3-1.8× (Encoding Specificity Principle)
- **FR-CL8: Re-Ranking mit bge-reranker-v2-m3** — Top-25 nach Hybrid+PPR → Cross-Encoder Re-Score, multipliziert mit Importance-Score → Top-5
- **FR-CL9: Lost-in-the-Middle Layout** — Final-Context Anordnung als `[rank1, rank3, rank5, rank4, rank2]`, Query VOR UND NACH Context, Compress auf 3-5 chunks
- **FR-CL10: Self-RAG Reflection** — LLM emit `[need_more_retrieval: yes/no]`-token; Loop bis max 3 hops oder Termination
- **FR-CL11: Cognitive Loop (Sleep-Agent) — 4 Phasen**
  - **Phase A (Wake)**: live indexing, retrieval-trace-logging, Hebbian-Edge-Updates mit STDP-Timing
  - **Phase B (NREM)**: 30min idle ODER nightly 03:00 — re-embed, multi-trace consolidation, synaptic pruning (weak edges → graveyard), importance-recompute, power-law decay
  - **Phase C (REM)**: weekly — Mem0 ADD/UPDATE/DELETE/NOOP-Classifier, Leiden community detection, Topic-Note-Synthesis (Claude Haiku), bi-temporal validation
  - **Phase D (LINT)**: daily — Orphan-Detection, Contradiction-Detection, Cross-Reference-Konsistenz, Schema-Drift, Duplicate-Detection, Stale-Capture-Detection. Output: User-Dashboard "5 Sachen die Lokyy heute Nacht über deinen Vault rausgefunden hat"
  - **Phase E (Dream)**: continuous background — spreading activation aus aktiver Note, predictive prefetch, spacing-effect surfacing
- **FR-CL12: Bi-Temporal Edges** — Edge-Tabelle mit `(t_created, t_expired, t_valid, t_invalid)`-Spalten (Graphiti-Pattern). Edge-Invalidation statt Delete bei Widerspruch
- **FR-CL13: 5-Layer Vault-Architektur** — Working (ephemeral), Episodic (`30_captures/`, `40_daily/`, `60_meetings/` — immutable), Semantic (`10_projects/`, `20_notes/`, `40_customers/`, `50_decisions/` — curated), Wisdom (`70_pai/topics/auto-*` — agent-derived), Autobiographic (`70_pai/profile.md`)
- **FR-CL14: Auto-Content Workflow** — Agent-generated Content lebt immer in `70_pai/topics/auto-*` ODER `70_pai/interventions/auto-*` mit frontmatter `origin: agent, confidence: 0.x`. User-Acceptance bewegt nach kuratiertem Ordner und setzt `origin: curated, confidence: 1.0`
- **FR-CL15: Cite & Explain** — Jedes Retrieval-Ergebnis zeigt WARUM es gefunden wurde: "Match via Titel + Embed-Score X + Y Hops via [[Z]] + Recency-Boost + Encoding-Context-Match"

### Non-Functional Requirements (additive)

- **NFR-CL-P1**: Retrieval-Latency p95 ≤ 250ms (interactive Mode), ≤ 1.7s (deep-investigation Mode mit Multi-Hop IRCoT)
- **NFR-CL-P2**: Sleep-Agent NREM-Phase muss innerhalb 10 Minuten pro Run komplett laufen (kein open-ended)
- **NFR-CL-P3**: REM-Phase LLM-Cost ≤ $5/Monat pro aktiver User (Claude Haiku, weekly Topic-Synthesis)
- **NFR-CL-P4**: Lint-Phase muss komplett lokal ohne externe API laufen (Llama 3.1 8B / spaCy / GLiNER)
- **NFR-CL-D1**: Nichts wird hart gelöscht — Forgetting ist Score-Rank-Decay, nicht Datenverlust. Synaptic Pruning verschiebt edges in `weak_edges_graveyard` (recoverable)
- **NFR-CL-D2**: Bi-Temporal-History bleibt erhalten — alte Facts werden invalidated (`t_invalid` gesetzt), nicht überschrieben
- **NFR-CL-D3**: Agent-generated Content ist immer klar als solcher markiert (`origin: agent` + Folder `70_pai/topics/auto-*`). User-Trust durch Transparenz

### Strategic Differentiation

Lokyy-Brain unterscheidet sich von Obsidian/Notion/Roam, Mem0/Letta/Graphiti, GraphRAG/HippoRAG durch die Kombination von:
1. **Vault-as-Truth** (Letta-Benchmark-validated: 74% LoCoMo schlägt spezialisierte Memory-Libs)
2. **5-Phase Cognitive Loop** (kein Konkurrent hat NREM/REM/Lint/Dream-Trennung)
3. **Lint-Operation als first-class Feature** (Karpathys hand-waved Lücke)
4. **Encoding-Context als first-class metadata** (niemand sonst implementiert Tulving)
5. **User-owned LLM stack** (Ollama lokal, Forgejo lokal, kein Vendor Lock-in)
6. **Open Source self-hostable** (vs Mem0/Zep SaaS-Only)

### Phasenplan (vollständig in vision-cognitive-loop-v2.md)

- **Phase A — Foundation** (1-2 Wochen, kein LLM-Risk): Importance-Scoring, Late Chunking, Multi-Chunk-Embeddings, ParadeDB Integration, Retrieval-Trace-Logging, Intent-Classifier, Sleep-Agent Walking Skeleton
- **Phase B — Cognitive Power** (2-3 Wochen): PPR, HyDE, RAG-Fusion, bge-reranker, Lost-in-Middle, Self-RAG, Encoding-Context-Match, Working-Memory + Spacing
- **Phase C — Cognitive Loop** (3-4 Wochen): Mem0-Classifier, Bi-Temporal, Leiden, **Karpathy-Lint** (Differenziator), Pruning, Entity-Extraction, Peer-Abstraction
- **Phase D — Polish + Tier-3**: variabel

### Voraussetzungen

- Phase A erfordert Phase 1 (current state, marathon-fertig) als getestete Production-Basis
- Vor Phase A: Hand-Test aller 14 Marathon-Features + Coolify-Deploy abschließen

### Referenz

Vollständige Architektur, Datenmodelle, Pipeline-Pseudocode und Citation-Trail siehe `vault://10_projects/lokyy-brain/vision-cognitive-loop-v2.md` (Forgejo-getrackte Single-Source-of-Truth).
