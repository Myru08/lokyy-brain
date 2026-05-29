# Story: Real "Delete Note" with double confirmation

**Epic:** Mobile/Android UX + safety
**Origin:** Oliver — "beim den Notizen müssen wir noch einen Löschen Button mit doppelter Absicherung. Wenn man was versaut kann man nicht löschen."

## Problem

The note view has only a **"Forget"** action (hides from search, keeps the file). There is NO way to actually delete the currently-open note from the note UI — real delete only exists in the FileTree (single `window.confirm`). Users who botch a note can't remove it from where they're working.

## Acceptance Criteria

1. Add a real **"Notiz löschen"** action (distinct from "Forget") to the note view:
   - In `NoteActionsSheet.tsx` (mobile "⋮" sheet) — a `danger` row separate from "Forget".
   - On desktop, reachable from `NoteHeader.tsx` (a delete control, consistent with existing inline actions).
2. **Double confirmation** (not a single dialog). Use a clear two-step AFFIRMATIVE confirm that works on touch — e.g. tapping "Notiz löschen" swaps the row/control into an explicit "Wirklich löschen? [Endgültig löschen] [Abbrechen]" state (second deliberate tap required). Do NOT rely on a single `window.confirm`; double-stacked `window.confirm` is acceptable only as a fallback but the two-step in-UI affirmative is preferred.
3. On confirm: delete the OPEN note via the existing delete path (`api.remove(path, "note")` / App's `handleDelete`), then close the note in the editor + any open tab and clear `active` (reuse the tab/active cleanup that FileTree-delete already triggers).
4. Surface failures (e.g. git/pre-commit error) inline, not silently.
5. Desktop layout otherwise unchanged; mobile uses touch-sized targets.

## Constraints

- Own ONLY: `pwa/src/NoteActionsSheet.tsx`, `pwa/src/NoteHeader.tsx`, `pwa/src/App.tsx`. Do NOT touch VoiceReviewSheet/FileTree/CommandPalette/server.
- Reuse the existing `handleDelete`/`api.remove` and the active-note/tab-cleanup logic in App.tsx; pass a new `onDeleteNote` (deletes the open note) down to NoteHeader/NoteActionsSheet.
- pnpm workspace; no npm/bun.

## Verification (paste exact output)

- `pnpm --filter pwa exec tsc --noEmit` → 0 (no `tsc` npm script — use `exec tsc`; worktree may lack node_modules → symlink main checkout's node_modules root+pwa, run, then remove).
- Do NOT run `pnpm -r build` (Orchestrator runs authoritative build).
- Self-check greps: show the new delete row in NoteActionsSheet + the two-step confirm state + the onDeleteNote wiring in App.tsx.

## Definition of Done

A real delete-note action exists in the note view (mobile + desktop), requires a deliberate two-step confirmation, deletes the open note and cleans up the editor/tab, distinct from Forget. Typecheck green.
