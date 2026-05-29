# Story 10.17: History/Diff + `validate_note` über MCP (Watch deferred)

Status: ready-for-dev

> Welle 4. Core = **Agent H** (`packages/core/src/git/gitService.ts` — Read-only History/Diff-Helfer).
> MCP-Tools = **Agent W** (`mcp/src/server.ts`). `validateFrontmatter` existiert bereits.

## Story

Als Nutzer/Agent möchte ich die Versions-Historie/Diffs einer Note und eine Frontmatter-Validierung
über MCP abrufen können, damit ich Änderungen nachvollziehen und Notes vor dem Commit prüfen kann.

## Acceptance Criteria

1. **Core (Agent H):** READ-ONLY Git-Helfer in `gitService` — `noteHistory(path, limit?)` (git log
   für die Datei: SHA, Datum, Message) und `noteDiff(path, sha?)` (git show/diff für die Datei).
   Nutzt den vorhandenen seriellen `git()`-Pfad; **keine** Schreiboperation, KEINE Änderung an der
   Write-Queue/Lock-Logik aus 10.12/10.6 (nur additive Read-Funktionen).
2. **MCP (Agent W):** `get_history({ path, limit? })`, `get_note_diff({ path, sha? })`,
   `validate_note({ path | body })` (nutzt `validateFrontmatter` aus `@lokyy/core`; liefert
   `{ valid, errors[] }`). Read-Scope-Check.
3. **Watch/Subscribe bewusst DEFERRED:** Push-Benachrichtigung bei Note-Änderung wird NICHT gebaut —
   Begründung dokumentieren (MCP-stdio hat kein einfaches Server-Push-Modell; bräuchte
   notifications/resource-subscriptions + Client-Support). Als Follow-up-Item festhalten (kein
   stilles Weglassen).
4. **Tests:** history liefert Commits einer Datei; diff zeigt Änderung; validate_note akzeptiert
   gültige + meldet ungültige Frontmatter strukturiert. `pnpm -r build` + core/mcp-Tests grün.
5. **Anti:** keine Write-Path-Änderung; `git()`-Serialisierung nicht umgehen; Watch nicht
   halbfertig einbauen.

## Dev Notes
- `git()`-Runner `gitService.ts:41-54`, Lock `:31-38` (READ-only Helfer müssen die Lock teilen, um
  nicht mit Writes zu kollidieren). `validateFrontmatter` `frontmatter/index.ts`. History/Diff via
  `git log --format`/`git show` auf den Datei-Pfad.
- gitService wurde in 10.6 + 10.12 geändert — aktuellen Stand lesen, nur additive Read-Funktionen.

### References
- [Source: 90_ideas/lokyy-mcp-gaps — 7 (History/Diff, Validation, Watch)]

## Dev Agent Record
### Agent Model Used
### Completion Notes List
### File List
### Change Log

---

#### Core part (Agent H) — completed 2026-05-29

**Agent Model Used:** Claude Opus 4.8 (Engineer)

**Completion Notes (Core / AC#1):**
- Added two purely-additive **READ-ONLY** helpers to `packages/core/src/git/gitService.ts`, appended after `lastModified`. Both go through the existing `serialize()` FIFO lock and the internal `git()` runner, exactly like every existing op — so a history/diff read is serialized with in-flight writes and never races the working copy.
- `noteHistory(relPath, limit?)`: `git log -<limit> --format=%H%x1f%cI%x1f%s%x1e -- <path>`. Clamps `limit` (finite & >0 → floored, else `DEFAULT_HISTORY_LIMIT = 50`). Uses ASCII unit/record separators (`\x1f`/`\x1e`) so subjects with spaces/tabs/newlines parse cleanly. Empty output → `[]` (no-history is not an error).
- `noteDiff(relPath, sha?)`: with `sha` → `git show <sha> -- <path>` → `{ sha, diff }`; bad sha is caught and re-thrown via the existing `classifyGitError(err, relPath)` (Story 10.6) for typed-error consistency. Without `sha` → `git diff -- <path>` → `{ sha: null, diff }`. Missing/unchanged path yields an empty diff (graceful).
- **Confirmed NOT altered:** write path (`runSave`/`save`/`saveBinary`/`remove`/`move`), lock semantics (`serialize`/`lockTail`), same-note coalescing (`pendingSaves`), and the typed-error machinery (`classifyGitError`/`GitError`). Changes are additive read-only functions only. No add/commit/push, no working-tree mutation.

**Exact signatures (for the MCP-wiring agent — Agent W):**
```ts
export interface NoteHistoryEntry { sha: string; date: string; message: string }
export function noteHistory(relPath: string, limit?: number): Promise<NoteHistoryEntry[]>; // default limit 50

export interface NoteDiff { sha: string | null; diff: string }
export function noteDiff(relPath: string, sha?: string): Promise<NoteDiff>;
```
Both exported from `packages/core/src/git/gitService.ts`. (Barrel re-export in `packages/core/src/index.ts` is the MCP-wiring agent's job — NOT touched here.)

**Tests added** (`packages/core/src/git/gitService.test.ts`, suite `gitService — read-only history/diff (Story 10.17)`, using the existing temp-git-repo harness `setupVaultWithRemote`/`useVault`):
- `noteHistory` returns commits newest-first for a file with history (3 versions).
- `noteHistory` honors `limit` and clamps bogus limits (0/-3/NaN) to default.
- `noteHistory` returns `[]` for a missing/untracked file.
- `noteDiff(sha)` shows the change a commit introduced (asserts `-original` / `+changed`).
- `noteDiff()` (no sha) returns the working-tree diff with `sha: null`.
- `noteDiff()` for a missing file returns `{ sha: null, diff: "" }` (graceful).
- `noteDiff(badSha)` rejects with a typed `GitBackendError` (no tree mutation).

**Verification:**
- `pnpm -r build`: FAILS only in `packages/core/src/conventions/index.ts` — an **untracked, in-progress file from a parallel agent** (missing doc-type entries `tool`/`resource`/`reference`). Unrelated to git/; my `gitService.ts` type-checks cleanly in isolation (`tsc --noEmit` on the file → no errors).
- Git tests `(cd packages/core && node_modules/.bin/vitest run src/git)` → **19 passed / 0 failed** (12 baseline 10.6/10.12 + 7 new 10.17). No regression.
- Full core `(cd packages/core && node_modules/.bin/vitest run)` → **222 passed / 1 failed / 3 skipped**. The 1 failure is `src/conventions/conventions.test.ts` (the same untracked parallel `conventions` work — passes in isolation; an ordering artifact). Imports nothing from gitService. No git/10.6/10.12 regression.

**File List (core part):**
- `packages/core/src/git/gitService.ts` (added `noteHistory`, `noteDiff`, `NoteHistoryEntry`, `NoteDiff`, `DEFAULT_HISTORY_LIMIT`)
- `packages/core/src/git/gitService.test.ts` (added Story 10.17 read-only suite + import of `noteHistory`/`noteDiff`)

**Change Log:** 2026-05-29 — Story 10.17 core: read-only `noteHistory`/`noteDiff` git helpers (additive, serialized, no write-path/lock/coalescing/typed-error changes).
