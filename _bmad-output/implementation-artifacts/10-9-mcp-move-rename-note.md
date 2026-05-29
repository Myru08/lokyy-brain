# Story 10.9: `move_note` / `rename_note` MCP-Tool

Status: ready-for-dev

> Welle 3. **Agent M** (`mcp/src/server.ts`). Core `moveEntry` existiert; Barrel-Export liefert
> Agent C1 (Story 10.10).

## Story

Als KI-Agent möchte ich `move_note(from, to)` / `rename_note(path, new_slug)` über MCP, damit ich
Notes/Ordner umstrukturieren kann, ohne neu-anlegen-und-Stub-umtexten (der heutige Workaround).

## Acceptance Criteria

1. `move_note({ from, to })` und `rename_note({ path, new_slug })` (rename = move im selben
   Elternordner) verdrahtet auf `moveEntry` (`notesService.ts:388`). Schreib-Scope für `from`/`to`.
2. ULID bleibt stabil (moveEntry invalidiert nur den Pfad-Cache); strukturierte Antwort `{ moved:
   {from, to} }`; `not-found`/Scope-Fehler strukturiert.
3. **Wikilink-Nachzug optional:** wenn schnell machbar, Backlinks auf den alten Pfad als Warning
   zurückgeben (welche Notes zeigten dorthin); echtes Rewrite ist Story 10.16-nah — hier NICHT
   blockierend bauen, nur Warning.
4. Tests (mcp): move landet, rename bleibt im Ordner, not-found. `pnpm -r build` + mcp-Tests grün.
5. Anti: kein direktes fs-Rename; nur `moveEntry`/`gitService`.

## Dev Notes
- `moveEntry` `notesService.ts:388` (kind "note"|"folder"); REST-Referenz `POST /api/vault/move`
  (`server/src/routes/vault.ts:161`). Barrel-Export von `moveEntry` kommt aus Story 10.10/Agent C1.

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 1.2]

## Dev Agent Record
### Agent Model Used
Claude Opus 4.7 (1M) — Dev agent "Agent M" (MCP-wiring slice, Wave 3).

### Completion Notes List
- **AC#1 (wired on moveEntry, write-scope on from+to):** `move_note({from,to})` and
  `rename_note({path,new_slug})` both route through a shared `moveNote(from,to)` helper that
  calls `moveEntry(from,to,"note")`. Write-scope (`canWrite(\`${id}.md\`)`) is checked on BOTH
  endpoints before any write. `rename_note` derives `to` via `renameTarget()` — keeps the parent
  folder, swaps only the final segment for `new_slug` (a slug containing `/` or `.md` is reduced
  to its basename so a rename can never silently re-file).
- **AC#2 (ULID stable, structured responses):** ULID stability is inherited from `moveEntry`
  (it only invalidates the path-cache). Success returns `{ moved:{from,to} }`; a missing source
  returns the structured `{ error:"not-found", path }` AND does not attempt the move (existence
  is checked via `getNote(from)` first). Scope failures flow through the existing Story-10.7
  `scope_violation` shape.
- **AC#3 (backlink WARNING only, no rewrite):** after a successful move, `backlinks(from)` is
  looked up best-effort. If any note still links the old path, a `warning` string listing those
  noteIds is attached to the response (NO rewrite). The lookup is wrapped in its own try/catch
  so it can never turn a successful move into a failure.
- **AC#5 (anti):** no direct fs rename — only `moveEntry`.

### File List
- `mcp/src/server.ts` — `move_note`/`rename_note` ListTools entries + CallTool cases; helpers
  `moveNote()` and `renameTarget()`; `backlinks` added to the `@lokyy/core` import.
- `mcp/src/server.test.ts` — e2e tests: move re-files (`moveEntry(…, "note")`), backlink warning
  surfaced, rename stays in folder, missing source → not-found with no move attempted.

### Change Log
- 2026-05-29 — Story 10.9 MCP wiring (Agent M). `pnpm -r build` exit 0; mcp tests green
  (53 passed). No core edits.
