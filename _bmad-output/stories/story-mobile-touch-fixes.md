# Story: Mobile Touch Fixes — Search + File-Tree actions (Android)

**Epic:** Mobile/Android UX
**Origin:** Android testing — search does nothing; file/folder actions (rename/delete) only on hover.

## Acceptance Criteria

1. **CommandPalette tap/click works on touch.** Result rows currently react only to `onMouseEnter` (CommandPalette.tsx ~:197) to move the cursor; a tap never selects. Add a proper `onClick` (and `onPointerDown`/`onTouchStart` as needed) on each result row that sets the cursor AND activates that item — so tapping a search result on Android opens it. Keep keyboard nav working. Verify the Search icon → palette → tap-result → opens note path is sound.
2. **File-tree actions reachable on touch.** FileTree.tsx renders new-file/new-folder/rename/delete inside `{hover && …}` driven by `onMouseEnter`/`onMouseLeave` (FileTree.tsx ~:406,546-601), invisible on touch. On mobile (use the existing `isMobile` from responsive.ts) make these actions reachable without hover — either always-visible on mobile, or a tap-to-reveal affordance (e.g. a trailing "⋮" that toggles the action row). Desktop hover behavior stays unchanged.
3. No regressions to desktop hover/keyboard behavior.

## Constraints

- Own ONLY: `pwa/src/CommandPalette.tsx` and `pwa/src/FileTree.tsx`. Do NOT touch App.tsx, NoteHeader.tsx, TagPane.tsx, VoiceRecorder.tsx, Settings.tsx, or any test/new-component files — a parallel agent owns App.tsx + the shell.
- Use the existing `isMobile`/breakpoint from `responsive.ts`; don't invent a new breakpoint.
- pnpm workspace; no npm/bun.

## Verification (report exact output)

- `pnpm --filter pwa exec tsc --noEmit` → 0 (note: there is NO `tsc` npm script; use `exec tsc`. Worktrees ship without node_modules — if needed, symlink the main checkout's node_modules to run tsc, then remove the symlinks).
- Do NOT run `pnpm -r build` (Orchestrator runs the authoritative build).

## Definition of Done

Both behaviors work on a touch/mobile width; typecheck green; only the two owned files changed.
