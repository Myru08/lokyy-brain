# Story 10.10: Bulk-Ops `create_notes` / `update_notes` (atomar)

Status: ready-for-dev

> Welle 3. Core = **Agent C1** (`packages/core/src/notes/notesService.ts` + Barrel
> `packages/core/src/index.ts`); MCP-Tools = **Agent M** (`mcp/src/server.ts`).

## Story

Als KI-Agent, der ein Projekt mit vielen Notes aufsetzt, möchte ich `create_notes`/`update_notes` in
einem Call (atomar: alle oder keine), damit große Umstrukturierungen nicht zu N Einzel-Calls mit
N× Latenz und Teilzuständen werden.

## Acceptance Criteria

1. **Core (Agent C1):** `createNotes(items)` und `updateNotes(items)` in `notesService` —
   verarbeiten eine Liste, **atomar**: schlägt ein Item bei der Validierung fehl, wird nichts
   committed (Pre-Flight-Validierung aller Items, dann ein gebündelter Commit über `gitService`).
   Wiederverwenden: `createNote`/`saveNote`-Logik inkl. der Type→Ordner-Ableitung aus Story 10.2.
2. **Atomarität:** entweder alle Items landen (ein Commit) oder keines; Teil-Erfolg ist nicht
   erlaubt. Bei Fehler → strukturiertes Ergebnis mit dem fehlerhaften Item + Grund.
3. **Barrel (Agent C1):** `createNotes`/`updateNotes` + die in Welle 3 von MCP benötigten
   bestehenden Funktionen (`moveEntry`, `createFolder`, `queryNotes` aus `dataview`) aus dem
   `@lokyy/core`-Barrel re-exportieren (für Agent M). Bestehende Barrel-Exporte erhalten.
4. **MCP (Agent M):** `create_notes({ notes:[{path|slug, title, type, body}] })` /
   `update_notes({ updates:[{path, body}] })` Tools; Scope-Check pro Item; Antwort listet
   Erfolge/den Fehler. BM25-Index pro Item via vorhandener Hooks.
5. **Tests:** Bulk-Create legt alle an (ein Commit); ein invalides Item → nichts angelegt;
   Bulk-Update analog. `pnpm -r build` grün; core+mcp-Tests grün.
6. **Anti:** keine partiellen Commits; keine Umgehung der Frontmatter-Validierung/Type→Ordner-Regeln.

## Dev Notes

- `createNote` `notesService.ts:304`, `saveNote` `:137`, `gitService.save` committet einzeln —
  für Atomarität ggf. einen Pfad bauen, der mehrere Files staged und EINEN Commit macht
  (gitService bietet evtl. nur Einzel-Commit; dann im Bulk-Helper die Files schreiben und über einen
  einzelnen gitService-Commit-Pfad bündeln, ohne die Lock zu umgehen). Lock-/Commit-Semantik aus
  `git/gitService.ts` respektieren (NICHT gitService editieren — das ist Agent G/10.12; hier nur die
  vorhandene öffentliche API nutzen).
- Type→Ordner-Ableitung: `notes/folderMap.ts` (Story 10.2).
- `queryNotes` liegt in `packages/core/src/dataview/index.ts:146` — nur re-exportieren, nicht ändern.

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 3 (Bulk-Ops); Story 10.2 (folderMap)]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.7 (1M) — Dev agent "C1" (Core + Barrel slice of Story 10.10).

### Completion Notes List
- **AC#1 (createNotes/updateNotes in notesService):** Added `createNotes(items)`
  and `updateNotes(items)`. Both pre-flight-validate ALL items first (existence,
  synthesized/merged frontmatter via `validateFrontmatter`, and the Story-10.2
  `checkPathMatchesType` placement guard when `validatePlacement` is opted in),
  then replay each item through the existing `createNote` / `saveNote` so the
  create/save logic (and the Story-10.2 type→folder derivation) is reused, not
  duplicated. Pre-flight is kept in lock-step with the real write paths.
- **AC#2 (atomic on validation):** On any pre-flight failure the functions write
  NOTHING and return `{ ok:false, error:{ id, reason, message }, committed:[] }`
  naming the offending item + reason (`already-exists`, `not-found`,
  `frontmatter-invalid`, `type-folder-mismatch`, `duplicate-id`). An in-batch
  duplicate-id guard runs first so two items targeting the same path can't
  partially commit.
- **AC#3 (Barrel):** Re-exported `createNotes`, `updateNotes` and their types
  (`BulkCreateItem`, `BulkUpdateItem`, `BulkItemError`, `BulkResult`) from
  `@lokyy/core`. Verified `moveEntry`, `createFolder` (notesService) and
  `queryNotes` (dataview) were ALREADY exported — left as-is to avoid a
  duplicate-export compile error; added a comment flagging move/createFolder as
  the wave-3 MCP surface. All pre-existing barrel exports preserved.
- **AC#5 (Tests):** Added 8 vitest cases — bulk-create lands all atomically;
  one invalid item → nothing created (and valid neighbours confirmed absent);
  placement violation, already-exists, and in-batch duplicate all gate cleanly;
  bulk-update analogous (all updated; one missing target → nothing updated,
  existing note byte-unchanged).
- **AC#4/#6 (MCP tools, anti-partial-commit):** MCP wiring is Agent M's slice
  (`mcp/src/server.ts`) — not touched here per file ownership.

#### Atomicity gap (documented, intentional)
True single-commit atomicity (stage all files → one commit) is NOT achievable
in this slice: `gitService` exposes only a per-file `save()` (each is its own
add→commit→pull→push) and its serialization `lock`/`serialize` is module-private
— there is no public batch-commit entry point. `gitService.ts` is owned by
Agent G (Story 10.12) this wave, so it was read-only here. Implemented the
best-available approach: **validate-all-then-write-all**. This makes the common
failure mode (validation) fully atomic (writes nothing). Residual gap: a
*git-level* failure on item k>0 (e.g. a mid-batch merge conflict — not a
validation error) leaves items 0..k-1 committed; that partial state is reported
honestly via the result's `committed[]` array rather than swallowed. Closing
the gap fully needs a batch-commit API on gitService (Story 10.12).

#### Symbols now available in the `@lokyy/core` barrel for the MCP-wiring agent
- `createNotes(items: BulkCreateItem[]): Promise<BulkResult<Note>>` — from `@lokyy/core`
- `updateNotes(items: BulkUpdateItem[]): Promise<BulkResult<Note>>` — from `@lokyy/core`
- `moveEntry(from, to, kind: "note"|"folder")` — from `@lokyy/core` (pre-existing)
- `createFolder(path: string)` — from `@lokyy/core` (pre-existing)
- `queryNotes(q: DataviewQuery): Promise<DataviewRow[]>` — from `@lokyy/core` (pre-existing)
- Types: `BulkCreateItem`, `BulkUpdateItem`, `BulkItemError`, `BulkResult<T>`,
  plus pre-existing `CreateNoteOpts`, `DataviewQuery`, `DataviewRow`.

### File List
- `packages/core/src/notes/notesService.ts` — added `createNotes`/`updateNotes`
  + `preflightCreate`/`preflightUpdate`/`firstDuplicateId` helpers + bulk
  item/result types.
- `packages/core/src/index.ts` — barrel: added `createNotes`/`updateNotes` +
  bulk types; confirmed `moveEntry`/`createFolder`/`queryNotes` already exported.
- `packages/core/src/notes/notesService.test.ts` — +8 bulk-op tests.

### Change Log
- Verify: `pnpm -r build` → exit 0 (core, server, mcp, pwa all built).
- Verify: `(cd packages/core && node_modules/.bin/vitest run)` → 203 passed,
  3 skipped (pre-existing), exit 0 (baseline ~195 + 8 new bulk-op tests). The
  `[memory] … DB not initialized` stderr lines are pre-existing non-blocking
  warnings in the test env, not failures.

### Completion Notes List (MCP part — Agent M)
- **AC#4 DONE — MCP tools.** `create_notes({notes:[{id,body?,type?,title?}]})` and
  `update_notes({updates:[{id,body}]})` wired on the core `createNotes`/`updateNotes`. Args are
  normalized (`normalizeBulkCreate`/`normalizeBulkUpdate`); create items carry per-item
  `opts:{type,title,validatePlacement:true}` so bulk obeys the same Story-10.2 type→folder
  coupling as single `create_note`.
- **Per-item write-scope:** `firstWriteScopeViolation(ids)` checks `canWrite(\`${id}.md\`)` for
  every item BEFORE calling core; the first out-of-scope id rejects the whole batch (consistent
  with the op's all-or-nothing intent — nothing is written).
- **AC#6 anti / honest reporting:** the tool returns the core `BulkResult` verbatim —
  `{ok:true,notes}` or `{ok:false,error:{id,reason,message},committed:[]}`. No partial commit is
  introduced at the MCP layer beyond what core already guarantees; `committed[]` is surfaced
  honestly (it stays `[]` for the pure validation-failure path).
- Tests: bulk-create lands all (validatePlacement+type asserted on the items passed to core);
  one bad item → `ok:false` + offending id/reason + empty `committed`; bulk-update analogous
  (all updated; one missing target → nothing updated).

### File List (MCP part — Agent M)
- `mcp/src/server.ts` — `create_notes`/`update_notes` ListTools entries + CallTool cases;
  helpers `normalizeBulkCreate`/`normalizeBulkUpdate`/`firstWriteScopeViolation`; `createNotes`/
  `updateNotes` + `BulkCreateItem`/`BulkUpdateItem` types imported from the barrel.
- `mcp/src/server.test.ts` — e2e bulk tests (create all / one-bad-item; update all / one-missing).

### Change Log (MCP part)
- 2026-05-29 — Story 10.10 MCP wiring (Agent M). `pnpm -r build` exit 0; mcp tests green
  (53 passed). No core edits in this slice.
