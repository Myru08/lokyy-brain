# Story 1.2: Bootstrap `packages/core` Workspace

Status: done

## Story

As a developer,
I want a new pnpm workspace `packages/core` named `@lokyy/core`,
so that service logic can be shared between `server` and the future `mcp` package without duplication.

## Acceptance Criteria

1. `packages/core/` directory exists with the four required files: `package.json`, `tsconfig.json`, `src/index.ts`, plus a `README.md` (small, ~10 lines, naming the package's purpose).
2. `packages/core/package.json` has `name: "@lokyy/core"`, `version: "0.0.1"`, `private: true`, `type: "module"`, `main: "src/index.ts"`, `types: "src/index.ts"`, `exports` map, and `scripts.build: "tsc -p tsconfig.json"`.
3. `packages/core/tsconfig.json` mirrors `packages/shared/tsconfig.json` (same compiler options, same module resolution).
4. `packages/core/src/index.ts` exists and exports at least one placeholder symbol (e.g. `export const CORE_VERSION = "0.0.1"`).
5. `pnpm-workspace.yaml` is unchanged (already uses `packages/*` glob — verified).
6. `pnpm install` exits 0 and creates `node_modules/@lokyy/core` symlinks.
7. `pnpm --filter @lokyy/core build` exits 0.
8. `pnpm -r build` exits 0 across all workspaces.
9. The package is importable from another workspace: a sanity check `import { CORE_VERSION } from "@lokyy/core"` resolves (verified by adding+removing a temporary import OR by `pnpm --filter server exec node -e "import('@lokyy/core').then(m => console.log(m.CORE_VERSION))"`).
10. **Anti:** no service code is migrated in this story — `packages/core/src/` contains only `index.ts` (and possibly a `version.ts` if extracted). Migration is Stories 1.3, 1.4.

## Tasks / Subtasks

- [x] **Task 1: Create `packages/core/` directory + manifest** (AC: #1, #2)
- [x] **Task 2: Create tsconfig + entry** (AC: #3, #4)
- [x] **Task 3: Verify workspace pickup** (AC: #5, #6) — `pnpm install` and confirm node_modules link.
- [x] **Task 4: Build verification** (AC: #7, #8) — filter build then full build.
- [x] **Task 5: Importability sanity** (AC: #9)
- [x] **Task 6: Scope discipline** (AC: #10) — no services migrated.
- [x] **Task 7: Playwright PWA regression verify** — `chrome-devtools` MCP navigated to `http://localhost:5173/`, console clean except pre-existing `/favicon.ico 404` and 3 pre-existing a11y issues; screenshot confirms `lokyy-brain` brand header + `forgejo · synchron` status indicator.

## Dev Notes

### What this story IS
A pure workspace bootstrap — adds the `packages/core` directory with the minimum-viable shape for a buildable, importable `@lokyy/core` package.

### What this story is NOT
- Not migrating any service (1.3, 1.4).
- Not adding any dependencies beyond what tsc needs.
- Not setting up tests.

### tsconfig template (mirror packages/shared/tsconfig.json)

The existing `packages/shared/tsconfig.json` is the canonical shape. Copy it.

### Sanity command for AC #9

```bash
pnpm --filter server exec node --experimental-vm-modules -e \
  "import('@lokyy/core').then(m => console.log('CORE:', m.CORE_VERSION))"
```

If that prints `CORE: 0.0.1`, AC #9 is satisfied.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.2: Bootstrap `packages/core` Workspace]
- [Source: _bmad-output/planning-artifacts/architecture.md — "New workspace: packages/core (@lokyy/core)"]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

- `pnpm install` after writing `packages/core/package.json` exited 0 (1.6s) but did NOT symlink `@lokyy/core` anywhere — expected, no consumer declared it as a dep yet.
- Added `@lokyy/core: workspace:*` to `server/package.json` dependencies (forward-compatible with Story 1.3 which requires it). Re-ran `pnpm install` → `+ @lokyy/core 0.0.1 <- ../packages/core` (18.6s).
- `server/node_modules/@lokyy/core` → `../../../packages/core` symlink verified via `readlink`.
- `pnpm --filter @lokyy/core build` exit 0; produced `packages/core/dist/index.{d.ts,js}`.
- `pnpm -r build` exit 0 across all 4 workspaces (shared, core, server, pwa).
- ESM import sanity: `node --input-type=module -e "import('@lokyy/core').then(m => console.log('CORE_VERSION:', m.CORE_VERSION))"` from `server/` printed `CORE_VERSION: 0.0.1`.
- Playwright check: `chrome-devtools` MCP — `navigate_page http://localhost:5173/` → page loaded; `list_console_messages` showed 1 [error] (pre-existing `/favicon.ico 404`) and 3 [issue] entries (pre-existing form-field a11y warnings); 36/37 network requests 200. Screenshot at `/tmp/lokyy-story-1-2-verify.png` shows `lokyy-brain` header + functional vault UI.

### Completion Notes List

- Workspace bootstrap clean. All 10 ACs verified inline; mechanical story did not warrant a separate Acceptance Auditor agent run.
- One in-scope addition beyond the bare AC list: `server/package.json` now declares `@lokyy/core: workspace:*`. Without this, `pnpm install` doesn't create the symlink (pnpm only links workspaces when consumed). This is forward-compatible with Story 1.3 and is a no-op functional change (the package is imported but only exports `CORE_VERSION` which nothing uses yet).
- No regression in the running PWA. The dev server (`tsx watch`) detected `server/package.json` change and restarted cleanly; Vite stayed up; PWA still renders `lokyy-brain` header with functional file tree and Forgejo status indicator.
- The `pwa/build` 667 kB chunk-size warning persists from Story 1.1 (not introduced by this story).

### File List

**New:**
- `packages/core/package.json`
- `packages/core/tsconfig.json`
- `packages/core/src/index.ts`
- `packages/core/README.md`

**Modified:**
- `server/package.json` (added `@lokyy/core: workspace:*` dependency)
- `pnpm-lock.yaml` (regenerated by `pnpm install`)

**Not touched:**
- `pnpm-workspace.yaml` — already covers `packages/*`.

### Change Log

| Date | Change | By |
|------|--------|-----|
| 2026-05-24 | `packages/core` workspace bootstrapped as `@lokyy/core`. Builds, links, imports. Server now depends on it (forward-compatible). Playwright PWA regression check passed. Status: in-progress → done. | Dev agent (claude-opus-4-7) |
