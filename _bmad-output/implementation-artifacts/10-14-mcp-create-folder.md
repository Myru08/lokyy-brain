# Story 10.14: `create_folder` MCP-Tool

Status: ready-for-dev

> Welle 3. **Agent M** (`mcp/src/server.ts`). Core `createFolder` existiert; Barrel-Export liefert
> Agent C1 (Story 10.10).

## Story

Als KI-Agent möchte ich Ordner explizit über MCP anlegen können (`create_folder`), statt nur
implizit beim ersten `create_note` — optional mit auto-generiertem README.

## Acceptance Criteria

1. `create_folder({ path, with_readme? })` verdrahtet auf `createFolder` (`notesService.ts:379`,
   legt `.gitkeep` an). Schreib-Scope-Check.
2. `with_readme:true` → zusätzlich eine `README`-Note (type:note) im Ordner via `createNote`
   (mit gültiger Frontmatter); Default `false`.
3. Strukturierte Antwort `{ created: path }`; Scope-Fehler strukturiert.
4. Tests (mcp): Ordner entsteht (.gitkeep), with_readme legt README an, Scope greift. `pnpm -r
   build` + mcp-Tests grün.
5. Anti: kein direktes mkdir außerhalb `notesService`/`gitService`.

## Dev Notes
- `createFolder` `notesService.ts:379`; REST-Referenz `POST /api/vault/folder`
  (`server/src/routes/vault.ts:146`). Kanonische Ordner: siehe `get_vault_conventions` (Story 10.4).

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 1.3]

## Dev Agent Record
### Agent Model Used
Claude Opus 4.7 (1M) — Dev agent "Agent M" (MCP-wiring slice, Wave 3).

### Completion Notes List
- **AC#1 (wired on createFolder + write-scope):** `create_folder({path,with_readme?})` calls
  `createFolder(path)` (which drops `.gitkeep`). Write-scope is enforced via `canWriteFolder(path)`.
- **AC#2 (with_readme):** when `with_readme:true`, also creates `${path}/README` via `createNote`
  (type `note`, title `README`), gated on its own `.md` write-scope. Default `false`.
- **AC#3 (structured response):** returns `{ created: path }` (the folder path, NOT the void
  `createFolder` result), plus `{ readme }` when a README was created. Scope failures use the
  Story-10.7 `scope_violation` shape.
- **AC#5 (anti):** no direct `mkdir` — only `createFolder`/`createNote`.

#### Scope-gate fix (root cause of the initial create_folder test failures)
The first cut gated the folder solely on `canWrite(\`${path}/.gitkeep\`)`. Under a `.md`-only
write scope (the e2e fixture uses `**/*.md`), the bare `.gitkeep` path does NOT match micromatch,
so a legitimately write-scoped agent was wrongly denied and the tool returned `scope_violation`
(no `created` field) — surfacing as `out.created === undefined`. Root cause: **implementation**,
not the test. Fixed by gating with the new `canWriteFolder(path)` helper, which mirrors exactly
how `filterTreeByScope` already decides empty-folder writability: writable if EITHER the
`.gitkeep` OR the folder's representative `_.md` matches. `filterTreeByScope` was refactored to
call the same helper (single source of truth, identical behavior). Real SPEC `folder/**` scopes
(e.g. `30_captures/**`) match `.gitkeep` directly and are unaffected — proven by the
restricted-scope e2e suite (denied outside scope, allowed inside).

### File List
- `mcp/src/server.ts` — `create_folder` ListTools entry + CallTool case; new `canWriteFolder()`
  helper (also adopted by `filterTreeByScope`); `createFolder` imported.
- `mcp/src/server.test.ts` — e2e tests: folder-only (created === path, no README), with_readme
  creates README note, plus restricted-scope denied/allowed.

### Change Log
- 2026-05-29 — Story 10.14 MCP wiring (Agent M) + scope-gate fix (`canWriteFolder`). `pnpm -r
  build` exit 0; mcp tests green (53 passed). No core edits.
