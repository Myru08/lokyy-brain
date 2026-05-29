# Epic 10 — MCP & API Hardening

Status: in-progress

> **Quelle:** Vault-Note `90_ideas/lokyy-mcp-gaps` (ULID `01KSR6WV29T7SG6SK19PZX75MB`), Session
> 2026-05-28/29 — beim Aufbau des `35_tools`-Ordners, Skill-Setup und einem ungeplanten
> Total-Ausfall des MCP-Backends festgestellt.
>
> **Wichtig:** Mehrere Diagnosen aus der Quell-Note wurden durch Code-Investigation (2026-05-29)
> korrigiert. Die korrigierten Root-Causes stehen pro Story unter "Dev Notes". Vor allem:
> der „SQL-Injection"-Befund ist als String-Konkatenation **widerlegt** (Upsert ist
> parametrisiert) — der reproduzierbare Crash sitzt im ParadeDB-`@@@`-Such-Operator plus
> fehlendem Circuit-Breaker.

## Ziel

lokyy-brain als MCP-Backing-Store **produktionsreif für Multi-Agent-Nutzung** machen
(Spacebot-Memory-Integration als Treiber). Drei Cluster: (A) Backend-Stabilität &
Error-Hygiene, (B) CRUD-Vollständigkeit & Discoverability über MCP, (C) Komfort/Bulk.

## Wellen / Reihenfolge

### Welle 1 — Hot-Fix (akute Bugs aus der Ausfall-Session)

| Story | Titel | Files (konfliktfrei) |
|-------|-------|----------------------|
| **10.1** | Indexer-Resilienz: ParadeDB-Query härten + Per-Note-Circuit-Breaker + Pool-Isolation | `packages/core/src/memory/Tier1BM25.ts`, `packages/core/src/memory/index.ts`, `packages/core/src/db/index.ts` (+ tests) |
| **10.2** | `create_note` Type-Treue (kein stilles Umschreiben) + Type→Ordner-Ableitung/-Validierung | `packages/core/src/notes/notesService.ts`, `mcp/src/server.ts` (+ tests) |

### Welle 2 — Kurzfristig (sehr nervig)

| Story | Titel | Kern-Files |
|-------|-------|-----------|
| **10.3** | `delete_note` MCP-Tool (Soft-Delete nach `99_archive/_trash/`, `--hard` optional) | `mcp/src/server.ts` → `notesService.deleteEntry` |
| **10.4** | `get_vault_conventions()` MCP-Tool (Ordner-Map, Pfad-Patterns, Type-Enum, Frontmatter-Schema) | `mcp/src/server.ts`, neue `packages/core/src/conventions/` |
| **10.5** | Skill-Schema offiziell + Template `00_meta/templates/skill.md` + `get_skill_schema()` | `mcp/src/server.ts`, Vault-Seed |
| **10.6** | Git-Sync: Idempotenz-Check vor „Merge-Konflikt", Error-Klassifikation, `gitBranch`-Trim | `packages/core/src/git/gitService.ts`, `packages/core/src/util/coreConfig.ts`, `server/src/config.ts`, `server/src/routes/notes.ts` |
| **10.7** | Strukturierte Errors konsistent (Format existiert: `{error, error_class, retry_after_ms?, request_id}`) | `mcp/src/server.ts` (Dispatch-Wrapper) |
| **10.8** | `get_health()` MCP-Tool (sync_state, last_index_at, pending_writes, db_pool_used/max, vault_id) | `mcp/src/server.ts`, `packages/core/src/health/` |

### Welle 3 — Mittelfristig (vor Spacebot-Memory-Integration)

| Story | Titel | Kern-Files |
|-------|-------|-----------|
| **10.9** | `move_note`/`rename_note` MCP-Tool, Wikilinks nachziehen oder warnen | `mcp/src/server.ts` → `notesService.moveEntry` |
| **10.10** | Bulk-Ops: `create_notes`/`update_notes` (atomic: alle oder keine) | `mcp/src/server.ts`, `packages/core/src/notes/` |
| **10.11** | `list_notes(filter)` über MCP (Frontmatter-Filter, Pagination) — `queryNotes` aus `dataview` exposen | `mcp/src/server.ts` → `dataview.queryNotes` |
| **10.12** | Backend Write-Queue / Debouncing (sequentielle Git-Ops, Frequenz-Schutz) | `packages/core/src/git/gitService.ts` |
| **10.13** | Multi-Vault-Erkennung: Setup verhindert Doppel-Vault; MCP-Boot warnt laut; in `get_health()` als Problem | `mcp/src/resolveVaultId.ts`, Setup |
| **10.14** | `create_folder()` MCP-Tool (optional `with_readme` aus Template) | `mcp/src/server.ts` → `notesService.createFolder` |

### Welle 4 — Später

| Story | Titel |
|-------|-------|
| **10.15** | Custom Types erlauben (Warning bei unbekannt) ODER Type-Enum erweitern (`tool`, `resource`, `reference`) |
| **10.16** | `get_backlinks(path)` + `find_broken_links()` über MCP (`graphService.backlinks`/`listTags`) |
| **10.17** | Watch/Subscribe, History/Diff (Git über MCP), Frontmatter-Validation-Surface |

## Erledigt / nicht nötig (durch Investigation widerlegt)

- **Tool-Lazy-Loading-Fix (Doc 8.4):** entfällt — alle Tools statisch registriert; Staggering ist Client-seitig. → nur Doku-Hinweis.
- **`run_skill`-Template-Engine (Doc 17):** `{{var}}`-Substitution existiert bereits (`skills/index.ts:98-117`). → ggf. nur Conditionals/Loops als optionales Later-Item.
- **SQL parametrisieren (Doc 8.2.1):** Upsert ist bereits parametrisiert. Der reale Bug (ParadeDB-`@@@`-Parsing + Circuit-Breaker) ist Story 10.1.

## Definition of Done (Epic)

`pnpm -r build` grün · pro Story AC erfüllt + QA-Sign-off · `.env.example` aktualisiert wo nötig ·
kritische Stories (10.1, 10.6) mit Reproduktions-Test der ursprünglichen Crash-Bedingung.
