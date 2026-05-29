# Story: Separate Save & Sync Buttons (backlog item #2)

**Epic:** Hardening / lokyy-ideen backlog
**Origin:** 90_ideas/lokyy-ideen item 2 — "Button für eine seperate speicherung und seperate synchronisierung. Beides Disabled wenn schon erfolgt."
**Scope decision (confirmed by Oliver):** Save = flush pending edits now (commit + push). Sync = reconcile with remote (pull --rebase + push unpushed). NO decoupling of local commit from push. Forgejo stays source of truth.

## Context

Today saving is atomic (`write → add → commit → pull --rebase → push`) inside the git promise-lock; sync happens implicitly inside save. There is a manual Save button but no distinct Sync control. NoteHeader.tsx renders the SaveBadge + Save button; App.tsx owns the save flow (debounce, manualSave/flushNow); api.ts wraps server calls; server does git ops via `gitService` (serialized lock).

## Acceptance Criteria

1. **Server**: `gitService` gains a `sync()` (a.k.a. reconcile) operation that, **inside the existing promise-lock**, runs `git pull --rebase` then pushes any unpushed commits, and returns whether anything changed. It must NOT write note content. Reuse existing pull/push helpers.
2. **Server**: a new endpoint (e.g. `POST /api/vault/sync` in the appropriate existing route file) calls `gitService.sync()` and returns `{ ok: boolean, changed: boolean, error?: string }`. Surface a failed pre-commit/push as a distinct error, consistent with existing error handling.
3. **PWA api.ts**: add a `sync()` method hitting the new endpoint. (api.ts is YOURS — the test agent and #12 agent will not touch it.)
4. **NoteHeader.tsx**: render TWO distinct controls — a **Save** button and a **Sync** button — visually separate, next to the existing SaveBadge.
5. **Disabled logic**: Save disabled when the note is not dirty (nothing to flush). Sync disabled while any save/sync is in flight and when state is already "synced" with no pending local changes. Each button shows a clear in-flight state.
6. **App.tsx**: wire the Sync button to `api.sync()`, update the SaveBadge state (synct ✓) on success, surface errors via the existing non-modal banner pattern. Save button continues to flush via the existing manualSave/flushNow.
7. Invariant: the sync path goes through the git lock; no concurrent unguarded git access; truth model unchanged.

## Constraints

- Own ONLY: `server/src/git/gitService.ts`, the one server route file you add the endpoint to (notes.ts or vault.ts — pick the consistent one), `pwa/src/api.ts`, `pwa/src/NoteHeader.tsx`, `pwa/src/App.tsx`. Do NOT touch Settings.tsx, server settings route, package.json, or test files (other agents own those).
- pnpm workspace — if you ever install, use pnpm (you should not need to).
- Update `.env.example` only if you add new env (you should not).

## Verification (report exact output)

- `pnpm --filter server tsc --noEmit` → 0
- `pnpm --filter pwa tsc --noEmit` → 0
- Do NOT run `pnpm -r build` (the Orchestrator runs the authoritative full build + Interceptor screenshot to avoid concurrent-build clashes). Paste both typecheck results.

## Definition of Done

Both typechecks green; two buttons with correct disabled states; sync routes through gitService lock. Report files changed + the design of the disabled-state logic.
