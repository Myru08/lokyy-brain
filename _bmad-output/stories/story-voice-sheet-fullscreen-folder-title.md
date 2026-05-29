# Story: Voice Review-Sheet — fullscreen, auto-scroll, folder pick, manual title

**Epic:** Mobile/Android UX — voice
**Origin:** Oliver — voice now works great; wants the sheet fullscreen, the transcript to auto-scroll as text streams in, a FOLDER picker for the new note, and an optional manual TITLE field.

## Acceptance Criteria

1. **Fullscreen layout:** `VoiceReviewSheet` covers the whole screen (not a ~40% bottom sheet). Header (Spracheingabe + language) at top, the editable transcript area FLEX-GROWS to fill, the action buttons (Verwerfen / In Notiz einfügen) pinned at the bottom. Respect `env(safe-area-inset-top/bottom)`. Use `100dvh` (dynamic viewport) so mobile browser chrome doesn't clip it.
2. **Auto-scroll transcript:** while recording (`listening`), as new text streams into the textarea, keep the latest text visible by scrolling the textarea to the bottom on each update. Do NOT fight the user: if the user has manually scrolled up (caret/scroll not near bottom) to edit, don't yank them back — only auto-scroll when the view is already at/near the bottom. After Stop, leave scroll where it is.
3. **Folder picker:** add a folder `<select>` (or compact picker) letting the user choose the target folder for the NEW note. Populate it from the vault folders (App passes a `folders: string[]` prop derived from its `tree` state — collect folder paths recursively). Default selection = `30_captures/voice` (current behaviour). Only relevant when no note is open (creating new) — when a note IS open, inserting still goes into the open note (folder picker can be hidden/disabled in that case).
4. **Manual title field:** add an optional "Titel (optional)" text input. If filled, the new note uses it as the title (drives filename + `# heading`). If empty, fall back to the current timestamped voice basename.
5. **Wire-through:** change `onInsert` from `(transcript) => Promise<void>` to `(transcript, opts?: { folderPath?: string; title?: string }) => Promise<void>`. In `App.tsx` `handleVoiceInsert`, when no note is open, create the note in `opts.folderPath` (default `30_captures/voice`) with `opts.title` (or the timestamped fallback) via the existing `createNoteUnique` (keep collision-suffixing). When a note IS open, behaviour unchanged (insert into it).
6. Desktop behaviour: fullscreen sheet is fine on desktop too (centered modal-like is acceptable, but fullscreen is OK). Don't break the existing open-note insert path.

## Constraints

- Own ONLY: `pwa/src/VoiceReviewSheet.tsx` and `pwa/src/App.tsx`. Do NOT touch Settings.tsx, server, or transcriptMerge (read-only).
- Keep the local Web Speech engine + the existing mergeTranscript dedup intact.
- pnpm workspace; no npm/bun.

## Verification (paste exact output)

- `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; symlink main checkout node_modules if the worktree lacks them, then remove).
- `pnpm --filter pwa test` → existing tests still green.
- Do NOT run `pnpm -r build` (Orchestrator runs authoritative build + visual check).

## Definition of Done

Sheet is fullscreen with a growing transcript area + pinned actions; transcript auto-scrolls while recording (without fighting manual edits); user can pick the target folder and optionally type a title for the new note; open-note insert unchanged; typecheck + tests green.
