# Story: Auto-unique title for quick "Neue Notiz" (+ voice-created notes)

**Epic:** Mobile/Android UX + usability
**Origin:** Oliver — creating a second new note errors "Neue Notiz existiert schon"; you can't make another quick/voice note.

## Problem

The BottomNav "Neu" button calls `handleCreate("", "Neue Notiz", "note")` (App.tsx ~:2294) and the voice-insert path also creates a note (App.tsx ~:1586). Both derive the SAME path from the fixed title, so the second attempt collides and fails. The user is blocked from creating consecutive quick/voice notes.

## Acceptance Criteria

1. Quick-create ("Neue Notiz") auto-increments on collision: "Neue Notiz", "Neue Notiz 2", "Neue Notiz 3", … — both the TITLE and the derived path get the suffix so they stay consistent. Never error out on a plain quick-create collision.
2. The voice-insert "create new note" path (when no note is open) is collision-safe the same way (don't fail if the generated title already exists).
3. Implementation: prefer catching the create collision and retrying with an incrementing suffix (cap ~50 to avoid infinite loops), OR proactively pick a free name from the known tree. Keep user-named creates (where the user typed a specific name in the FileTree) behaving as before — this auto-suffix is for the quick/voice "Neue Notiz" default, not a silent rename of an explicit user choice (for explicit names, the existing collision error is acceptable, or apply the same suffix — your judgement, but quick/voice MUST not block).
4. Detect the collision robustly (inspect the error returned by `api.createNote` / the server's note-exists response).

## Constraints

- Own ONLY: `pwa/src/App.tsx`. Do NOT touch VoiceReviewSheet.tsx (another agent owns it now), NoteHeader/NoteActionsSheet, server, or core.
- pnpm workspace; no npm/bun.

## Verification (paste exact output)

- `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; worktree may need node_modules symlink from main checkout, then removed).
- Do NOT run `pnpm -r build` (Orchestrator runs authoritative build).
- Show the suffix/retry logic you added (grep or hunk).

## Definition of Done

Tapping "Neu" (or voice-creating) repeatedly yields "Neue Notiz", "Neue Notiz 2", … without error. Typecheck green; only App.tsx changed.
