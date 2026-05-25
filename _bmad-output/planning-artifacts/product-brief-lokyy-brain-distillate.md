---
title: "Product Brief Distillate: lokyy-brain"
type: llm-distillate
source: "product-brief-lokyy-brain.md"
created: "2026-05-14"
purpose: "Token-efficient context for downstream PRD creation"
---

# lokyy-brain — PRD Detail Pack

## Confirmed Technical Decisions

- **Monorepo:** pnpm workspaces — packages/shared (types), packages/core (all service logic), server (Hono routes only), pwa, mcp (new)
- **Frontend:** Vite + React 18 SPA as PWA via vite-plugin-pwa — explicitly NOT Next.js (SPA is simpler, no SSR needed)
- **Editor:** CodeMirror 6 — same engine as Obsidian; live preview as custom CM6 Decorations/Widgets (NOT a WYSIWYG editor); data model stays plain Markdown
- **Graph:** react-force-graph in PWA; d3-force used in existing mockup only
- **Backend:** Node + Hono; real git CLI; git ops serialized via promise-lock
- **MCP:** @modelcontextprotocol/sdk; stdio transport default; imports packages/core directly (no HTTP between processes on same machine)
- **Embedding model:** nomic-embed-text via Ollama
- **Vector store:** pgvector (Postgres already required for Auth)
- **Vault URL:** configurable via Setup Wizard at install, changeable in system settings later — NOT hardcoded
- **ULID library:** `ulid` package
- **Frontmatter:** `gray-matter` parse/serialize + `ajv` JSON schema validation
- **MCP scope assignment:** env/CLI arg per server instance at start time (NOT dynamically negotiated)
- **Tier 3 (temporal knowledge graph):** deferred entirely — Graphiti as preferred candidate when revisited; interface designed to accommodate it without rebuild

## Rejected Ideas (Do Not Re-Propose)

- **Next.js** — rejected: SPA + vite-plugin-pwa is simpler; no SSR needed
- **TipTap/Milkdown/Lexical** — rejected: would force WYSIWYG data model; Markdown must stay the truth
- **WYSIWYG editor** — same rejection reason as above
- **Pipe handlers writing to `inbox/`** — rejected: lokyy-vault SPEC requires `30_captures/{urls,youtube,voice,pdfs}/`
- **Tier 3 as mandatory dependency** — rejected: requires 32B+ LLM hardware; blocks adoption
- **HTTP between MCP and server on same machine** — rejected: unnecessary overhead; share packages/core directly
- **Dynamic MCP scope negotiation** — rejected: simpler security model is env/CLI arg at start
- **LanceDB for vector store** — deferred in favor of pgvector since Postgres is needed for Auth anyway

## Architecture Guardrails (Non-Negotiable)

- **Forgejo is the truth.** Every write goes through gitService. No write bypasses git.
- **Every .md file requires valid frontmatter.** Pre-commit hook enforces this. A hook failure is a distinct error type (not generic git error) so PWA and MCP can surface it meaningfully.
- **Memory sync is never blocking.** Forgejo commit first; Tier 2/3 index sync is fire-and-forget with error logging. A failing index must never prevent saves or server start.
- **MCP scoping from vault.** `00_meta/mcp-scopes.yaml` defines read/write globs and commit_prefix per agent. Default deny. The MCP server reads this file — no custom permission model.
- **packages/core is the shared service layer.** Both server (Hono) and mcp import from @lokyy/core. Neither reimplements service logic.
- **SPEC-valid frontmatter always.** createNote generates complete schema-valid frontmatter. saveNote preserves existing frontmatter, updates `updated` field only.

## Vault Schema Contract

- **Mandatory frontmatter fields:** `id` (ULID, 26 chars, stable on rename), `type`, `title`, `created` (immutable), `updated` (set by pre-commit hook)
- **Doc types (closed list):** note, capture, project, task, decision, meeting, customer, workflow, intervention, content
- **note** → `20_notes/**`, requires `note_type` ∈ {daily, topic, fleeting, permanent}
- **capture** → `30_captures/**`, requires `source` ∈ {url, youtube, voice, pdf, manual}, `captured_at`, `processed`
- **project** → `10_projects/*/README.md`, requires `slug`, `status`, `brand`
- **Naming:** kebab-case; Daily Notes `YYYY-MM-DD.md`; Decisions `YYYY-MM-DD-slug.md`
- **Vault folder structure:** 00_meta, 10_projects, 20_notes, 30_captures, 40_customers, 50_decisions, 60_meetings, 70_pai, 80_brand, 99_archive
- **Consolidation agent state:** `70_pai/memory/` (sync markers, last-run timestamp); interventions → `70_pai/interventions/`
- **Migration note:** Existing `Note.id` uses path-based id (e.g. "pai/hermes") — SPEC requires ULID. This is a breaking migration in Epic 2.

## Auth & Multi-User Model

- **Multi-user from day 1** — not single-user-first
- **Dual-vault architecture:** each user has a personal vault (private) + can join shared company/team vaults
- **Permissions per vault:** read/write/admin roles (not per-note, not per-folder in v1 — per vault)
- **Company vault use case:** multiple users sharing a vault for company knowledge (decisions, customers, projects); each also has their own private personal vault
- **Especially important for remote deployments** — local installations less critical for multi-user
- Admin account created during Setup Wizard
- SSO/LDAP/OAuth out of scope for v1

## Setup Wizard Requirements

- Works for **both local and remote server** installation
- Interactive — guides user through all required config (vault URL, Postgres connection, Ollama endpoint, admin account creation, etc.)
- Creates admin account (email + password minimum)
- Must be idempotent — re-runnable without data loss (re-setup scenario)
- Result: fully running system with no manual .env editing required
- Vault URL must be changeable later in system settings (not locked at install time)

## Consolidation Agent Details

- Scheduled cron run via MCP server (same interface as any external agent)
- Processes notes changed since last run marker (stored in `70_pai/memory/`)
- Writes back: missing wikilinks, new topic notes for recurring concepts, insights/contradictions → `70_pai/interventions/`
- Must produce SPEC-valid frontmatter on every write
- Loop architecture: evaluator step after each pass checks if unconsolidated notes remain (not fixed iteration count); hard upper bound to prevent runaway runs
- **Requires review UI in v1:** accept/reject/ignore per intervention — without this, user trust in autonomous writing degrades over time
- Runs under its own MCP scope with commit_prefix for audit trail

## MCP Server Tools (Day 1)

- `search_vault` — semantic search (Tier 1+2 initially; Tier 3 additive later, same signature)
- `related_notes` — related note discovery
- `read_note` / `write_note` — scoped read/write
- `get_tree` — vault structure
- `trigger_import` — kick off a Pipe job
- All tools enforce scope from `00_meta/mcp-scopes.yaml`

## Existing Code (Baseline — Do Not Rebuild)

- **gitService.ts** — ensureRepo, pull, save, remove, move, lastModified; promise-lock serialization ✓
- **notesService.ts** — listNotes, getNote, saveNote, getTree, createNote, createFolder, moveEntry, deleteEntry ✓
- **graphService.ts** — parseLinks, parseTags, parseTitle, buildGraph ✓
- **pipeQueue.ts** — registerHandler, detectType, enqueue, listJobs ✓ with youtube+scrape+crawl handlers ✓
- **PWA:** CM6 editor with live-preview extension, wikilink CM6 extension, FileTree.tsx, ImportPanel.tsx ✓
- **NOT yet built:** react-force-graph view, IndexedDB offline layer, Auth, packages/core extraction, MCP workspace, Tier 2 semantic index, Consolidation Agent, Setup Wizard, Multi-vault

## Scope Realism Flags (For PM/Architect)

- v1 scope as defined contains 7-8 independent complexity domains simultaneously — over-scoping risk is high
- Suggestion: define a "Minimum Viable Brain" milestone within v1: Setup Wizard + Single-User Auth + CM6 Editor + Tier 1+2 + Basic MCP → ship that first, then add Multi-Vault + Consolidation Agent
- Forgejo hard-dependency adds installation complexity (4-service stack: Forgejo + Postgres + Ollama + lokyy); consider bare git remote as alternative for simpler setups
- Consolidation Agent without review UI is a trust-killer; review UI must be in scope if the agent writes autonomously

## Competitive Context (Key Points)

- **Obsidian:** Dominant, 5M+ users, CM6 engine, strong plugin ecosystem. Sync is proprietary + $96/yr. No MCP. No server-side processing. No team vaults without third-party plugins.
- **SilverBullet:** Most architecturally similar (client+server, Markdown, self-hosted). No MCP. No consolidation. Smaller ecosystem.
- **Logseq:** Strong community, local-first, block-based structure (not Markdown-file-based). Moving toward database model — alienating purists. Nascent LLM integration.
- **Foam:** VSCode-based, lightweight, dormant-ish. No server.
- **Trilium:** Database-backed (not file-based) — breaks Git-as-truth model.
- **Key gap across all competitors:** None has MCP-native + AI writes back + autonomous consolidation. This combination is the defensible moat.

## Licensing & Monetization

- **Decided:** Oliver wants to monetize
- **Recommended model:** AGPL for open-source core + commercial dual license for enterprise (avoids AGPL enterprise blacklisting) + Lokyy Cloud (managed hosted) as primary revenue stream
- **AGPL caveat:** AGPL is on many enterprise legal blacklists — dual licensing (AGPL community + commercial enterprise license) is the standard pattern (Nextcloud, MariaDB, GitLab model)
- **Lokyy Cloud:** planned but not built in v1 — architecture must not block it
- **Early monetization signal (v1):** GitHub Sponsors or similar; no hard paywall before community traction

## Open Questions (Unresolved — Carry to PRD)

- Forgejo required vs. bare git remote as alternative — final decision needed for Architecture Doc
- Exact Obsidian migration tooling: v1 or v1.1?
- Multi-vault permission granularity in v1: per-vault read/write/admin confirmed — folder-level permissions deferred?
- Prompt injection threat model for MCP write access (Pipes import web content → Consolidation Agent processes it → potential exploit vector) — needs security review in Architecture Doc
- iOS voice capture: Shortcuts fallback design for Web Share Target

## Visual Design Reference

- **Mockup:** `docs/mockup/lokyy-brain-mockup.jsx` — three-panel layout is the UX spec
- **Colors:** bg `#14110f`, panel `#1b1714`, elevated `#231e1a`, hover `#2b2520`, border `#322b25`, accent `#d2693f` (terracotta), accentHi `#e8814f`, gold `#c9a25e`, ok `#7fa37a`
- **Fonts:** Bricolage Grotesque (UI), Fraunces (serif/headings), JetBrains Mono (code/editor)
- **Layout:** file tree (left) / CM6 live-preview editor (center) / force-directed knowledge graph (right) + Pipes inbox (slide-over) + Forgejo status bar (bottom)
