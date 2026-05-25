# Story 1.3: Migrate `gitService` to `@lokyy/core`

Status: done

## Story

As a developer,
I want `gitService` moved from `server/src/git/` into `packages/core/src/git/`,
so that the future MCP package can call git operations directly without HTTP.

## Acceptance Criteria

1. `packages/core/src/git/gitService.ts` exists with the migrated implementation including the promise-lock.
2. `packages/core/src/index.ts` re-exports the public surface of `gitService` (`ensureRepo`, `pull`, `save`, `remove`, `move`, `lastModified`).
3. `server/` imports `gitService` symbols from `@lokyy/core` (no relative path to the old location).
4. The old `server/src/git/` directory is deleted (no dead duplicate files).
5. `pnpm -r build` exits 0.
6. The four server modules that import gitService (`server/src/{index.ts,graph/graphService.ts,notes/notesService.ts,pipes/pipeQueue.ts}`) all import from `@lokyy/core` and the build is type-clean.
7. Behavior is unchanged: server boot still reaches `lokyy-brain Server laeuft auf :8787`, `/health` returns `{"ok":true}`.
8. **Anti:** `gitService` is NOT modified during the move (pure migration, no logic change). The pre-move and post-move file bodies are identical except for the `import { config }` path (now resolves to `@lokyy/core` consumer-relative — actually unchanged if config stays in server; see Dev Notes).
9. **Anti:** `config.ts` is NOT migrated in this story (it stays in `server/src/config.ts`; gitService needs to receive config differently — see Dev Notes).
10. Playwright check: PWA at `http://localhost:5173/` still loads with `lokyy-brain` header, console clean except pre-existing `/favicon.ico 404`.

## Tasks / Subtasks

- [x] **Task 1: Decide config injection pattern** — Option C (initGitService(config) at server startup, GitConfig type in core).
- [x] **Task 2: Move file** — new file at packages/core/src/git/gitService.ts; old server/src/git/ folder deleted.
- [x] **Task 3: Re-export from core** — packages/core/src/index.ts re-exports the 6 functions + initGitService + GitConfig type.
- [x] **Task 4: Update server imports** — 4 server files updated (index.ts adds initGitService call + import; graph/graphService.ts, pipes/pipeQueue.ts, notes/notesService.ts swap relative path for @lokyy/core).
- [x] **Task 5: Build verification** — `pnpm -r build` exit 0 across all 4 workspaces after adding `@types/node` + `typescript` as devDeps to `packages/core`.
- [x] **Task 6: Server runtime smoke** — tsx watch auto-reloaded, boot log `lokyy-brain Server laeuft auf :8787`, `/health` → `{"ok":true}`.
- [x] **Task 7: Playwright PWA regression** — `chrome-devtools` reload of `http://localhost:5173/`, same baseline console state as Story 1.2 (1 pre-existing favicon 404, 3 pre-existing a11y warnings, no new errors). Screenshot identical: lokyy-brain header, vault tree fetched, forgejo synchron status.

## Dev Agent Record

### Debug Log References

- Initial build after move failed with `TS2307: Cannot find module 'node:child_process'` — `packages/core` lacked `@types/node`. Added `@types/node@^22.0.0` and `typescript@^5.5.0` as devDependencies. `pnpm install` re-resolved; second build exit 0.
- Stale `server/dist/` referenced old `./git/gitService.js` paths. Deleted `server/dist/` before rebuild to avoid confusion. Fresh dist contains only `@lokyy/core` references.
- Config injection works: `initGitService(config)` called once in `main()` before `ensureRepo()`. The module-level `injectedConfig` reference + `config()` accessor throws a clear error if called before init (defensive).
- No behavior change in any gitService function: same args, same return shapes, same error paths. Diff is purely structural (extracted config to GitConfig interface + indirection via `c = config()` at the top of each function).
- Playwright: `/api/vault/tree` returned 200 on first PWA load post-migration; full request stream is identical to pre-migration baseline.

### Completion Notes List

- Pattern set for Story 1.4: same migration approach (move file, re-export from core, update consumers, delete originals).
- The `GitConfig` interface is intentionally structurally-compatible with the existing server `config` object (which has additional fields like `port`, `supadataApiKey` that core ignores). No server-side change to `config.ts` required.
- Server is now the sole owner of `config.ts` — this is the right shape; `packages/core` shouldn't know about env loading or supadata or port. Each consumer (server, future mcp) builds its own config and injects the relevant slice.
- The "duplicate task notifications" hook fired but the dev server is healthy; ignoring per CLAUDE.md rule.

### File List

**New:**
- `packages/core/src/git/gitService.ts` (with config injection — 211 lines including the new init scaffold)

**Modified:**
- `packages/core/package.json` (added `@types/node` + `typescript` devDeps)
- `packages/core/src/index.ts` (re-exports gitService surface)
- `server/src/index.ts` (import from @lokyy/core, call initGitService at boot)
- `server/src/graph/graphService.ts` (import path swap)
- `server/src/notes/notesService.ts` (import path swap)
- `server/src/pipes/pipeQueue.ts` (import path swap)
- `pnpm-lock.yaml` (regenerated for new devDeps)

**Deleted:**
- `server/src/git/gitService.ts`
- `server/src/git/` (empty directory after file removal)

### Change Log

| Date | Change | By |
|------|--------|-----|
| 2026-05-24 | gitService migrated from `server/src/git/` to `packages/core/src/git/` with config injection. All 4 server consumers updated to import from `@lokyy/core`. Build green, server boot clean, PWA regression-free per Playwright. Status: in-progress → done. | Dev agent (claude-opus-4-7) |

## Dev Notes

### Config injection challenge

Current `gitService.ts` imports `config` from `../config.js` (relative to its current location in `server/`). After migration to `packages/core/src/git/`, that relative path is wrong. Options:

- **A. Move `config.ts` too.** Out of scope (this story is gitService-only).
- **B. Inject config at call site.** Refactor `gitService` to take config as parameter or via an init function. Cleanest long-term but is a behavior change beyond pure migration.
- **C. Keep `config.ts` in `server`, pass it via `init`.** A small `initGitService(config)` function in core that sets a module-level reference, called once from `server/src/index.ts`. Minimal-change.

**Decision: Option C.** Add `initGitService(config)` to core, server calls it before `ensureRepo`. The 186-line gitService body stays identical; only the import is removed in favor of a lazy `getConfig()` accessor.

### Config shape

`gitService` uses these fields: `vaultDir`, `gitRemote`, `gitBranch`, `gitAuthorName`, `gitAuthorEmail`. Define a `GitConfig` interface in core with exactly those fields. Server passes `config` (which structurally matches).

### Files to touch

- **Move:** `server/src/git/gitService.ts` → `packages/core/src/git/gitService.ts` (with the config-injection refactor described above).
- **Edit:** `packages/core/src/index.ts` re-exports `{ ensureRepo, pull, save, remove, move, lastModified, initGitService, type GitConfig }`.
- **Edit:** `server/src/index.ts` — `import { initGitService, ensureRepo } from "@lokyy/core"`; call `initGitService(config)` once in `main()` before `ensureRepo()`.
- **Edit:** `server/src/graph/graphService.ts`, `notes/notesService.ts`, `pipes/pipeQueue.ts` — change `import ... from "../git/gitService.js"` → `from "@lokyy/core"`.
- **Delete:** `server/src/git/` directory entirely.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.3: Migrate `gitService` to `@lokyy/core`]
- [Source: _bmad-output/planning-artifacts/architecture.md — "Brownfield migration: gitService, notesService, ... exist in server/src/ — must be migrated to packages/core/"]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

### Completion Notes List

### File List

### Change Log
