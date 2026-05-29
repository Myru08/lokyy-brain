# Story 10.11: `list_notes(filter)` MCP-Tool (Frontmatter-Filter)

Status: ready-for-dev

> Welle 3. **Agent M** (`mcp/src/server.ts`). Core `queryNotes` (dataview) existiert; Barrel-Export
> liefert Agent C1 (Story 10.10).

## Story

Als KI-Agent möchte ich `list_notes(filter)` über MCP, damit ich „alle Notes mit type:X und
status:Y" bekomme, ohne jede Note einzeln zu lesen (heutige Limitierung von `list_tree`).

## Acceptance Criteria

1. `list_notes({ filter:{ type?, folder?, tag?, status?, updated_after? }, limit?, offset? })`
   verdrahtet auf das vorhandene `queryNotes` (`dataview/index.ts:146`, Frontmatter-Equality +
   Ordner-Prefix + Tag-Filter, projiziert FM-Spalten). Pagination via limit/offset.
2. Read-Scope-Filter wie bei `list_tree`/`search_vault` (nur lesbare Notes; out-of-scope raus).
3. Antwort: Liste `{ noteId, title, type, ...projizierte FM }` + ggf. `total`/`hasMore`.
4. Tests (mcp): Filter nach type liefert nur passende; Scope-Filter greift; Pagination. `pnpm -r
   build` + mcp-Tests grün.
5. Anti: `queryNotes` nicht ändern (nur konsumieren); kein N+1-Einzelread wenn `queryNotes` es
   bündelt.

## Dev Notes
- `queryNotes` `packages/core/src/dataview/index.ts:146`; REST-Referenz `POST /api/dataview`
  (`server/src/routes/dataview.ts:16`). Scope-Helper `canRead` in `mcp/src/server.ts`.

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 5]

## Dev Agent Record
### Agent Model Used
Claude Opus 4.7 (1M) — Dev agent "Agent M" (MCP-wiring slice, Wave 3).

### Completion Notes List
- **AC#1 (wired on queryNotes + pagination):** `list_notes({filter,limit,offset})` maps the MCP
  filter onto `queryNotes` — `folder`→`from`, `type`/`status`→`where` equality, `tag`→the
  engine's special `where.tag`. `limit`/`offset` are clamped (`clampInt`, default 50/0). Since
  `queryNotes` has no `offset` and only does equality, the handler over-fetches at the engine's
  MAX_LIMIT (200), then applies `updated_after` (a strict `>` comparison the engine doesn't do
  natively), the read-scope drop, and `slice(offset, offset+limit)` locally. `queryNotes` is only
  consumed, never modified (AC#5).
- **AC#2 (read-scope filter):** every row is dropped unless `canRead(\`${id}.md\`)` — the same
  gate `list_tree`/`search_vault` use. Verified by the restricted-scope e2e suite (a
  `30_captures/**`-scoped agent sees only the in-scope row).
- **AC#3 (response shape):** returns `{ notes:[{ noteId, title, type, ...projected FM }], total,
  hasMore, limit, offset }`. Rows are re-keyed `id`→`noteId` via `projectRow`.
- **AC#4 (tests):** type filter → only matching + correct `where`/`from` passed to core;
  `updated_after` filter; limit/offset pagination with `total`/`hasMore`; out-of-scope drop.

### File List
- `mcp/src/server.ts` — `list_notes` ListTools entry + CallTool case; helpers `listNotes()`,
  `projectRow()`, `clampInt()`; `queryNotes` + `DataviewQuery`/`DataviewRow` types imported.
- `mcp/src/server.test.ts` — e2e tests: type/folder filter, updated_after, pagination, scope drop.

### Change Log
- 2026-05-29 — Story 10.11 MCP wiring (Agent M). `pnpm -r build` exit 0; mcp tests green. No core edits.
