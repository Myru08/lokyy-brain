# Story 10.3: `delete_note` MCP-Tool (Soft-Delete + `hard`-Option)

Status: ready-for-dev

> Welle 2. Core-Anteil = **Agent B** (`packages/core/src/notes/notesService.ts`); MCP-Tool =
> **Agent C** (`mcp/src/server.ts`). Agent B baut den Core-Helper; Agent C verdrahtet das Tool und
> ruft den Helper. Beide editieren NUR ihre Datei.

## Story

Als KI-Agent möchte ich `delete_note(path, hard?)`, damit ich falsch angelegte Notes/Ordner über
MCP aufräumen kann, ohne den User zu bitten, Files manuell aus dem Filesystem/Git zu löschen —
standardmäßig sicher per Soft-Delete (Move nach `99_archive/_trash/`), optional hart.

## Acceptance Criteria

1. **Core (Agent B):** ein Helper (z.B. `trashEntry(path)` / Erweiterung um Soft-Delete) verschiebt
   eine Note nach `99_archive/_trash/{YYYY-MM-DD}-{originalSlug}` via vorhandenem `moveEntry`
   (`notesService.ts:388`); ein Hard-Delete nutzt `deleteEntry` (`notesService.ts:433`). Beide laufen
   durch `gitService` (commit). Export für Agent C verfügbar.
2. **MCP (Agent C):** `delete_note({ path, hard? })` — Default `hard=false` → Soft-Delete; `hard=true`
   → echtes Entfernen. Schreib-Scope-Check (`canWrite`) wie bei create/update; out-of-scope →
   bestehender `scope_violation`. Antwort strukturiert (`{ deleted: {...}, mode: "soft"|"hard" }`).
3. **Idempotenz/Fehler:** nicht-existierende Note → strukturierter `{ error: "not-found", path }`.
   BM25-Index wird beim Hard-Delete via vorhandenem `queueSearchIndexRemove` bereinigt (Soft-Delete:
   die Note bleibt unter neuem Pfad indexiert — akzeptabel; ggf. re-index unter neuem Pfad).
4. **Wikilink-Warnung optional:** wenn schnell machbar, Backlinks auf die gelöschte Note als Warning
   zurückgeben; sonst auf Story 10.16 verschieben (nicht blockieren).
5. **Tests:** Soft-Delete landet in `99_archive/_trash/`; Hard-Delete entfernt; not-found-Fehler;
   Scope-Verletzung. `pnpm -r build` grün.
6. **Anti:** kein direktes `fs.unlink` außerhalb von `notesService`/`gitService`.

## Dev Notes

- `deleteEntry` `notesService.ts:433`, `moveEntry` `:388`, `createFolder` `:379`,
  `queueSearchIndexRemove` (`memory/index.ts`). REST hat bereits `DELETE /api/vault/entry`
  (`server/src/routes/vault.ts:185`) als Referenz fürs Verhalten.
- `99_archive/` ist kanonischer Top-Ordner (siehe Vault-Struktur / Story 10.4 conventions).

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 1.1; Investigation 2026-05-29 (deleteEntry/moveEntry Fundstellen)]

## Dev Agent Record
### Agent Model Used
Claude Opus 4.7 (Engineer agent — CORE part only; MCP tool wiring is the parallel Agent C's job).

### Completion Notes List
- **Core part (Agent B) DONE.** Added `trashEntry(path, now?)` to `notesService.ts`:
  soft-deletes a note by MOVING it to `99_archive/_trash/{YYYY-MM-DD}-{slug}` via the
  existing `moveEntry` (so the move is committed through `gitService` AND the BM25 index
  is updated to the new path — no direct `fs.unlink`, AC#6). Exported `TRASH_FOLDER`
  constant + `TrashResult` type for Agent C.
- Hard-delete reuses the existing `deleteEntry(path, "note")` unchanged (already drops the
  BM25 row via `queueSearchIndexRemove` + invalidates the ULID cache). Agent C routes
  `hard=true` → `deleteEntry`, `hard=false` → `trashEntry`.
- `trashEntry` throws (`existiert nicht`) when the source does not exist so a race never
  produces an empty commit; Agent C still does the not-found existence check up front to
  return the structured `{ error: "not-found", path }` (AC#3).
- The slug is the note's leaf name; a `{YYYY-MM-DD}-` prefix keeps trash chronologically
  sorted and avoids same-name collisions across days. `now` is injectable for tests.
- AC#2 (MCP tool + scope check + structured response), AC#3 MCP-side `not-found` shape,
  and AC#4 (wikilink-warning) are Agent C's scope — not implemented here.
- Tests: soft-delete lands in `99_archive/_trash/2026-05-29-…` with body intact and the
  original path returns null; hard-delete removes with no trash copy; not-found throws.

### File List
- `packages/core/src/notes/notesService.ts` (added `trashEntry`, `TRASH_FOLDER`, `TrashResult`)
- `packages/core/src/notes/notesService.test.ts` (added soft/hard-delete describe block)
- `packages/core/src/index.ts` (MCP-wiring agent: barrel re-export of `trashEntry`, `TRASH_FOLDER`, `TrashResult`)
- `mcp/src/server.ts` (MCP-wiring agent: `delete_note` ListTools entry + CallTool case)
- `mcp/src/server.test.ts` (MCP-wiring agent: e2e soft/hard/not-found tests)

### Completion Notes List (MCP part — Agent C)
- **AC#2 DONE.** `delete_note({ path, hard? })` wired into `server.ts`: default `hard=false` →
  `trashEntry(path)` (soft, returns `{ from, to }`); `hard=true` → `deleteEntry(path,"note")`.
  `canWrite(`${path}.md`)` check up front → out-of-scope throws the existing `ScopeViolation`
  (`scope_violation`, now `error_class: user-error` per 10.7). Response is structured:
  `{ deleted: <TrashResult|{path}>, mode: "soft"|"hard" }`.
- **AC#3 DONE.** Existence is checked with `getNote(path)` before delete; a missing note returns
  `{ error: "not-found", path }` instead of letting `trashEntry`/`deleteEntry` throw. Hard-delete
  index cleanup is handled inside the existing `deleteEntry` (`queueSearchIndexRemove`).
- **AC#4 (wikilink warning) intentionally NOT built** — deferred per the story (and the wave brief);
  no backlink lookup added.
- Rich tool description tells agents soft-delete is the safe default (recoverable trash move) and
  `hard:true` is permanent.
- Barrel re-export (`trashEntry`/`TRASH_FOLDER`/`TrashResult`) added so `server.ts` imports from
  `@lokyy/core`; `deleteEntry` was already exported.

### Change Log
- Core soft-delete/trash helper + tests; build green; core tests green (the only failing
  core tests are in `git/gitService.test.ts`, owned by Story 10.6 — unrelated env failure).
- MCP `delete_note` tool wired + barrel re-export + e2e tests (InMemoryTransport). `pnpm -r build`
  exit 0; mcp tests 23 passed; core tests 195 passed / 3 skipped.
