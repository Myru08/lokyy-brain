# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Identity

This project was renamed from **"sternwarte"** → **"lokyy-brain"** in Story 1.1 (Epic 1). All package names use the `@lokyy/*` scope (`@lokyy/shared`, future `@lokyy/core`, `@lokyy/mcp`). Active code, configs, and the PWA manifest no longer reference the old name; the only remaining references are documentation history paragraphs (this section, the README rename note, and the BMAD planning artifacts under `_bmad-output/`).

## Single Source of Truth (SSOT) — Verbindlich, überschreibt alles andere

> **Lokyy Brain ist die Single Source of Truth für das gesamte Lokyy-Programm (Brain + Lokyy OS).** Dies ist ein „million dollar project": **keine Entscheidung, kein Kontext, kein Task, kein Meilenstein, kein Problem und keine Lösung darf je verloren gehen.** Mein flüchtiger Session-Kontext ist NICHT der Speicher — der Vault (git-versioniert) ist es.

**Programm-Architektur (verbindlich, siehe ADR [[50_decisions/2026-05-31-lokyy-brain-os-schichtung]]):**
- **Brain = Daten + Speicher + API (SSOT).** Speichert Notizen mit Frontmatter; bleibt schlank; PWA als Eingriffs-Fallback. **Alle persistenten Daten — auch Formular-/Schema-Definitionen — leben in Brain** (damit jede angeschlossene KI sie kennt). Brain rendert keine Formulare und hat keine Formular-Logik.
- **Lokyy OS = die gesamte Logik- & Erlebnisschicht** (Formulare, Dashboards, Visualisierung, Hermes-Agent). OS konsumiert Brains API + Deep-Links. **Alles API-first**, damit der Agent jede Aktion als Link/Button ausliefern kann.

**Pflicht-Disziplin bei JEDER Aufgabe (Brain UND OS):**
1. **VORHER konsultieren:** `search_vault` / lies die relevanten Notizen, bevor du arbeitest oder entscheidest. **Nie raten** — wenn es im Vault steht, ist das die Wahrheit; fehlt es, frag den User.
2. **NACHHER dokumentieren:** Jede Entscheidung (als ADR in `50_decisions/`, Titel `YYYY-MM-DD-lokyy-…`), jeder Meilenstein/Task, jedes Problem + Lösung, jede Architektur-Änderung wird sofort als Notiz in Brain abgelegt und vom Programm-Dach [[10_projects/lokyy/README]] verlinkt.
3. **Beide Systeme im Blick:** Brain ↔ OS-Grenze + API-Verträge sind dokumentiert; Änderungen an einem System, die das andere betreffen, werden an der Grenze festgehalten.
4. **Session-Ende:** Stand in `70_pai/sessions/{YYYY-MM-DD}-…` festhalten (TL;DR, Entscheidungen, offene Punkte, Wikilinks).

Verstoß gegen diese Disziplin = Risiko für das Gesamtprojekt. Diese Regeln gelten vor den Workflow-Regeln unten.

## Workflow — Verbindlich

- **BMAD-only.** No ad-hoc coding. Every piece of implementation work must originate from a Story with defined acceptance criteria. BMAD is installed under `_bmad/`.
- **Claude is Orchestrator ONLY.** Plans, delegates, verifies. **Never writes production code directly.** Every implementation task — even one-line edits inside `server/`, `pwa/`, `packages/`, `mcp/` — MUST be delegated to a specialized `Agent` tool call. The Orchestrator is permitted to edit only: this `CLAUDE.md`, BMAD planning artifacts under `_bmad-output/`, and pure doc `*.md` files outside the code packages.
- **Parallel agent teams are the DEFAULT.** When multiple features are queued, fan them out in a single message with multiple `Agent` tool uses so they run concurrently. Group features into conflict-free file-sets (each agent owns disjoint NEW files); the Orchestrator handles cross-cutting wiring (e.g. `Editor.tsx` extension list, `App.tsx` layout) by delegating a final "wire-up" agent AFTER the parallel batch returns. Never let two parallel agents write the same file.
- **BMAD sequence must be respected:** Analyst → PM (PRD) → Architect (Architecture Doc) → Scrum Master (Stories) → Dev → QA. No phase may be skipped.
- **`/goal` per Dev-Story.** When driving a story, set a `/goal` whose condition is: story acceptance criteria + `pnpm -r build` green. Include a hard turn-cap in the condition.
- **Definition of Done:** `pnpm -r build` passes, story acceptance criteria met, QA sign-off, `.env.example` updated. Verification (build + Interceptor screenshot where UI is involved) is the Orchestrator's job; implementation is the agent's.

## Commands

```bash
# Build everything
pnpm -r build

# Dev (run in separate terminals)
pnpm --filter server dev      # tsx watch
pnpm --filter pwa dev         # Vite

# Type-check without building (tsc is a binary, not an npm script → use `exec`)
pnpm --filter server exec tsc --noEmit
pnpm --filter pwa exec tsc --noEmit

# Run server in production
pnpm --filter server start
```

## Architecture

```
packages/shared   — shared types only (@sternwarte/shared → @lokyy/shared)
server            — Hono API; imports from shared
pwa               — Vite SPA + PWA; imports from shared
```

**Target state** adds two more workspaces:
- `packages/core` — all service logic migrated here (`git`, `notes`, `graph`, `pipes`, `memory`); both `server` and `mcp` import from `@lokyy/core`
- `mcp` — `@lokyy/mcp` workspace, MCP-SDK server, imports core directly (no HTTP)

### Data Flow

```
PWA → HTTP/JSON → Server (Hono) → git CLI → Forgejo (truth)
                          ↑
                    .md on disk (local working copy)
```

**Forgejo is the truth.** Every write goes through `gitService` (add → commit → pull --rebase → push). Git operations are serialized via a promise-lock to prevent concurrent access to the working copy. On read: `git pull --rebase` first.

### Key Services (`server/src/`)

| Service | File | Responsibility |
|---------|------|----------------|
| `gitService` | `git/gitService.ts` | `ensureRepo`, `pull`, `save`, `remove`, `move`, `lastModified`. Serializes all git ops via lock. |
| `notesService` | `notes/notesService.ts` | `listNotes`, `getNote`, `saveNote`, `getTree`, `createNote`, `createFolder`, `moveEntry`, `deleteEntry` |
| `graphService` | `graph/graphService.ts` | `parseLinks`, `parseTags`, `parseTitle`, `buildGraph` (derives Wikilink graph from .md files) |
| `pipeQueue` | `pipes/pipeQueue.ts` | `registerHandler`, `detectType`, `enqueue`, `listJobs`. Handlers in `pipes/handlers/` |

Routes: `notes.ts` (`/api/notes`), `vault.ts` (`/api/vault`), `graph.ts` (`/api/graph`), `pipes.ts` (`/api/pipes`).

### PWA (`pwa/src/`)

CM6 editor under `editor/`. Core components: `App.tsx`, `FileTree.tsx`, `ImportPanel.tsx`. `api.ts` wraps all server calls. `theme.ts` for styling. Uses `vite-plugin-pwa`.

## Vault Contract (SPEC)

lokyy-brain works on the **lokyy-vault** — a standardized Markdown vault with a pre-commit hook that blocks commits with invalid frontmatter. The application layer must honor this contract:

- **Every `.md` file requires frontmatter** with: `id` (ULID, 26 chars, stable on rename), `type`, `title`, `created` (immutable), `updated` (hook sets automatically).
- **`notesService` must never commit raw body without valid frontmatter.** A failed pre-commit hook must be surfaced as a distinct error type, not a generic git error.
- **`createNote` generates complete schema-valid frontmatter.** `saveNote` preserves existing frontmatter and updates `updated`.
- Doc types (`note`, `capture`, `project`, `task`, `decision`, `meeting`, `customer`, `workflow`, `intervention`, `content`, `peer`, `skill`, `tool`, `resource`, `reference`) are a closed list. The single source of truth is `DOC_TYPES` in `packages/core/src/frontmatter/types.ts`; the per-type JSON schemas in `00_meta/schemas/` (mirrored under `packages/core/src/frontmatter/schemas/`) and `base.json`'s `type` enum are kept in sync with it (enforced by the drift-guard in `frontmatter.test.ts`). `skill` notes (under `70_pai/skills/`) define reusable workflows exposed via the MCP meta-tools `list_skills`/`run_skill` (Epic 9, see `_bmad-output/planning-artifacts/skills-prd-phase1.md`).
- Pipe handlers write to `30_captures/{urls,youtube,voice,pdfs}/` with `type: capture` frontmatter (not `inbox/`).
- Required utilities: frontmatter parse/serialize/validate (recommended: `gray-matter` + `ajv`) and ULID generator (recommended: `ulid`).

## Memory Model

Three-tier model, all behind a `MemoryProvider` interface in `packages/core`:

- **Tier 1** (mandatory): structural index — Wikilinks, tags, folder structure, full-text. Largely exists in `graphService`.
- **Tier 2** (mandatory): semantic index — small self-hosted embedding model → pgvector/LanceDB. Enables semantic search without exact wikilinks.
- **Consolidation Agent** (mandatory): scheduled cron run via MCP server. Processes notes changed since last run; writes back wikilinks, topic notes, and interventions to `70_pai/interventions/`. Runs through `gitService`, must produce SPEC-valid frontmatter. State in `70_pai/memory/`.
- **Tier 3** (optional plugin): temporal knowledge graph (Graphiti candidate). Behind same `MemoryProvider` interface. Must never block server start or writes — Forgejo commit goes first, Tier 3 sync is fire-and-forget.

MCP scoping comes from `00_meta/mcp-scopes.yaml` in the vault — MCP server reads this file and enforces read/write globs and `commit_prefix` per agent. No custom permission model.

## Open Questions (status after Planning Phase)

> Resolved entries cite `_bmad-output/planning-artifacts/architecture.md`. Do not re-open without amending the Architecture doc.

1. ✅ **Tier 2 embedding + vector store** — `nomic-embed-text` via Ollama (768-dim), `pgvector` with HNSW (`m=16, ef_construction=64`). Source: architecture.md:29, 37, 167–169.
2. ⏳ **lokyy-vault hosting location + Forgejo instance** — still open. Architecture mandates a Docker-deployed Forgejo (port 3000 HTTP / 22 SSH) and the Setup Wizard validates the connection at install (architecture.md:303–314). Concrete host URL is chosen per deployment.
3. ✅ **ULID + frontmatter libraries** — `ulid@3.0.2`, `gray-matter@4.0.3`, `ajv@8.20.0`, all in `@lokyy/core`. Source: architecture.md:122–124.
4. ✅ **MCP client identity / scope assignment** — scope resolver in `@lokyy/mcp` reads `00_meta/mcp-scopes.yaml` **at startup** (no runtime expansion). Identity per server instance via env/CLI. Source: architecture.md:213–214, 354.
5. ⏸️ **Tier 3 tool choice** — deliberately deferred until Tier 1+2 are in production. Graphiti is the current candidate (CLAUDE.md Memory Model).

## Epic Sequence

1. Rename sternwarte → lokyy-brain + set up lokyy-vault repo
2. Core refactor (create `packages/core`, migrate services) + vault compliance (frontmatter utility, ULID, SPEC-valid notesService, hook error type)
3. Memory Layer Tier 1+2 (`MemoryProvider` interface, semantic index, fire-and-forget sync hooks, search routes)
4. Consolidation Agent (scheduled, MCP-based, writes through gitService)
5. MCP Server workspace (`@lokyy/mcp`, scoped tools, stdio transport)
6. Tier 3 Graph — optional, deferrable
7. Remaining PWA (react-force-graph frontend, IndexedDB offline layer)
