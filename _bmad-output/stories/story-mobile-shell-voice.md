# Story: Mobile Shell Redesign + Voice Review-Sheet (Android)

**Epic:** Mobile/Android UX
**Origin:** Android testing — top-bar action buttons unreachable, no bottom nav, Tags panel huge, voice dictation shows each sentence ~3× and writing voice live into a note causes a black screen.
**Confirmed directions (Oliver):** (a) **Bottom-Tab-Bar** for mobile navigation; (b) **Voice = Record → editable Review-Sheet → Insert** (no live-into-editor).

## Acceptance Criteria

### A. Bottom navigation (mobile only)
1. NEW `pwa/src/BottomNav.tsx`: a persistent bottom bar shown only on mobile (use `isMobile` from responsive.ts). Five large (≥44px) touch targets: **Baum/Drawer**, **Suche**, **Neu (+)**, **Voice**, **Sync**. Each takes a callback prop; show the active/disabled state for Sync (reuse the SaveStatus/sync state already in App.tsx). Safe-area-inset-bottom aware (`env(safe-area-inset-bottom)`).
2. Wire BottomNav in App.tsx: Drawer→toggles the file-tree drawer; Suche→opens CommandPalette; Neu→create-note; Voice→opens the Voice Review-Sheet (see C); Sync→calls `api.sync()` (reuse existing handler). Content area gets bottom padding so the bar never overlaps the editor.

### B. Slim mobile top bar + note-actions sheet
3. On mobile, the top bar keeps only: ☰ (drawer), logo, and a single "⋮" (more) button. All note-action buttons currently crammed in NoteHeader (Save, Sync, TTS/read-aloud, Polish, Properties, Backlinks, Outline, ID/forget, etc.) move into a NEW `pwa/src/NoteActionsSheet.tsx` (a bottom sheet / menu) opened by "⋮". Desktop NoteHeader layout is UNCHANGED (still inline).
4. The note-actions sheet lists the actions with labels + icons, touch-sized rows, and triggers the same handlers the inline buttons use.

### C. Voice Review-Sheet (replaces live-into-editor)
5. NEW `pwa/src/VoiceReviewSheet.tsx`: open from the BottomNav Voice button. Records via Web Speech API, shows a LIVE, EDITABLE transcript textarea, with [Verwerfen] and [In Notiz einfügen] actions. On "Einfügen" it inserts the (possibly edited) transcript into the currently open note via the existing save/insert path; if no note is open, it can create/append per existing create-note conventions.
6. **Fix STT triple-render:** Android Chrome re-emits `resultIndex=0`; track committed final segments yourself (e.g. by result index / a committed-length cursor) so finalized sentences are appended exactly once. Interim text shown separately and not duplicated.
7. **Remove the black-screen crash path:** delete/neutralize the old "live voice writes directly into the CM6 editor" flow (App.tsx `onLiveEditorRequested` / `handleLiveVoiceAppend` race at ~:1655-1672,914 that calls `setActive({...null})`). The review-sheet flow replaces it. Ensure any insert into a note is null-guarded (never spread a null `active`).
8. Update VoiceRecorder.tsx as needed (or route its mic/live entry points to the new sheet). The top-bar/bottom-bar Mic/Voice entry must open the review-sheet, not the old live path.

### D. Tags panel size (mobile)
9. The drawer gives TagPane `maxHeight: 40%` (App.tsx ~:1982) and TagPane has `maxHeight:320` — too tall on a phone. On mobile, cap the Tags section much smaller (e.g. collapsible, or `maxHeight ~25%`/≤180px) so the file tree dominates the drawer. Desktop unchanged.

## Constraints

- Own ONLY: `pwa/src/App.tsx`, `pwa/src/NoteHeader.tsx`, `pwa/src/TagPane.tsx`, `pwa/src/VoiceRecorder.tsx`, and NEW files `pwa/src/BottomNav.tsx`, `pwa/src/NoteActionsSheet.tsx`, `pwa/src/VoiceReviewSheet.tsx`. Do NOT touch CommandPalette.tsx or FileTree.tsx — a parallel agent owns those (BottomNav opens the palette via the same prop/handler App.tsx already uses; don't edit the palette itself).
- Use existing `isMobile`/breakpoints from responsive.ts. Match existing theme.ts styling.
- Desktop layout must remain visually unchanged — all new chrome is mobile-gated.
- pnpm workspace; no npm/bun. Update `.env.example` only if new env (none expected).

## Verification (report exact output)

- `pnpm --filter pwa exec tsc --noEmit` → 0 (NOTE: no `tsc` npm script exists — use `exec tsc`. Worktrees ship without node_modules — symlink the main checkout's node_modules to run tsc, then remove symlinks).
- Do NOT run `pnpm -r build` (Orchestrator runs the authoritative build + mobile-viewport screenshot).

## Definition of Done

Mobile shows a bottom tab bar + slim top bar; note-actions reachable via "⋮" sheet; Tags compact; voice opens an editable review-sheet that inserts on confirm; no live-into-editor crash path; STT no longer triples. Desktop unchanged. Typecheck green. Report files changed + how STT dedup + crash removal were done.
