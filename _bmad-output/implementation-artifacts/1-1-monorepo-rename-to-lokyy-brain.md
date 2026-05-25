# Story 1.1: Monorepo Rename to lokyy-brain

Status: done

## Story

As a developer,
I want the monorepo, package names, and identifying strings renamed from `sternwarte` / `@sternwarte/*` to `lokyy-brain` / `@lokyy/*`,
so that all future work happens under the project's actual identity and `pnpm -r build` stays green.

## Acceptance Criteria

1. Root `package.json` `name` field is `"lokyy-brain"`.
2. `packages/shared/package.json` `name` field is `"@lokyy/shared"`.
3. Every workspace `package.json` that depended on `@sternwarte/shared` now depends on `@lokyy/shared` (workspace protocol preserved).
4. Every `.ts` / `.tsx` import path that referenced `@sternwarte/shared` now references `@lokyy/shared`.
5. `pwa/vite.config.ts` PWA manifest `name` and `short_name` reference `lokyy-brain` (not `Sternwarte`).
6. `pwa/index.html` `<title>` reads `lokyy-brain`.
7. The CodeMirror theme exports `sternwarteTheme` / `sternwarteHighlight` are renamed to `lokyyTheme` / `lokyyHighlight`; every consumer is updated.
8. `server/src/index.ts` no longer contains the string `Sternwarte` (server banner + console.log → `lokyy-brain`).
9. `server/src/config.ts` `gitAuthorEmail` default is `"lokyy-brain@localhost"` (was `"sternwarte@localhost"`).
10. `CLAUDE_CODE_AUFTRAG.md` is moved to `Plans/CLAUDE_CODE_AUFTRAG_legacy.md` (legacy planning artifact preserved but out of active root).
11. `pnpm-lock.yaml` is regenerated from the renamed manifests (no stale `@sternwarte` keys).
12. `pnpm -r build` exits 0.
13. Both dev servers boot cleanly: `pnpm --filter server dev` reaches the "lokyy-brain Server laeuft auf :8787" log line; `pnpm --filter pwa dev` reaches Vite ready output.
14. `grep -ri "sternwarte" --include="*.{ts,tsx,json,html,yaml,yml,toml}" .` returns zero hits outside `_bmad-output/`, `Plans/`, and `node_modules/`.
15. `grep -ri "sternwarte" --include="*.md" .` returns hits ONLY in `_bmad-output/`, `Plans/`, and in the explicit rename-history paragraphs of `CLAUDE.md` and `README.md` (no active code-doc references to the old name).

## Tasks / Subtasks

- [x] **Task 1: Rename root manifest** (AC: #1)
  - [x] Edit `package.json`: `"name": "sternwarte"` → `"name": "lokyy-brain"`.
  - [x] Verify `pnpm-workspace.yaml` is unchanged.

- [x] **Task 2: Rename `@sternwarte/shared` package** (AC: #2, #3)
  - [x] `packages/shared/package.json` → `@lokyy/shared`.
  - [x] `server/package.json` dep updated.
  - [x] `pwa/package.json` dep updated.

- [x] **Task 3: Update every `@sternwarte/shared` import in TypeScript** (AC: #4)
  - [x] `pwa/src/api.ts`
  - [x] `pwa/src/App.tsx`
  - [x] `pwa/src/FileTree.tsx`
  - [x] `pwa/src/ImportPanel.tsx`
  - [x] `server/src/graph/graphService.ts`
  - [x] `server/src/notes/notesService.ts`
  - [x] `server/src/pipes/pipeQueue.ts`
  - [x] `server/src/pipes/handlers/scrape.ts`
  - [x] `server/src/pipes/handlers/youtube.ts`
  - [x] `server/src/routes/pipes.ts`
  - [x] `rg "@sternwarte" -g '!node_modules' -g '!_bmad-output' -g '!Plans' -g '!pnpm-lock.yaml' -g '!CLAUDE.md'` → zero hits in code.

- [x] **Task 4: Rename PWA branding** (AC: #5, #6)
  - [x] `pwa/vite.config.ts`: manifest `name` + `short_name` + JSDoc comment.
  - [x] `pwa/index.html`: `<title>lokyy-brain</title>`.

- [x] **Task 5: Rename CodeMirror theme exports** (AC: #7)
  - [x] `pwa/src/editor/theme.ts`: `lokyyTheme`, `lokyyHighlight`.
  - [x] `pwa/src/editor/Editor.tsx`: import + array refs updated.

- [x] **Task 6: Update server identity strings** (AC: #8, #9)
  - [x] `server/src/index.ts`: JSDoc + boot console.log.
  - [x] `server/src/config.ts`: `gitAuthorName` and `gitAuthorEmail` defaults.
  - [x] In-scope UI string in `pwa/src/App.tsx` line 261 also renamed (header brand label).

- [x] **Task 7: Archive the legacy briefing doc** (AC: #10)
  - [x] `mv CLAUDE_CODE_AUFTRAG.md → Plans/CLAUDE_CODE_AUFTRAG_legacy.md`. (No git repo present, so plain `mv`.)

- [x] **Task 8: Regenerate lockfile** (AC: #11)
  - [x] `pnpm install` ran clean (52.3s, 386 packages). Lockfile contains `@lokyy/shared` (×2), zero `@sternwarte` references.

- [x] **Task 9: Build verification** (AC: #12)
  - [x] `pnpm -r build` → all 3 workspaces (shared, server, pwa) built. Exit 0. Vite output 667 kB chunk-size warning is pre-existing (not introduced by this story).

- [x] **Task 10: Dev-server smoke test** (AC: #13)
  - [x] `pnpm --filter server dev` (with `VAULT_DIR=/tmp/lokyy-vault-server GIT_REMOTE=/tmp/lokyy-test-remote GIT_BRANCH=main`) → boot log `lokyy-brain Server laeuft auf :8787`.
  - [x] `pnpm --filter pwa dev` → `VITE v5.4.21 ready in 185 ms`.
  - [x] `curl http://localhost:8787/health` → `{"ok":true}`.
  - [x] `curl http://localhost:5173/` → `<title>lokyy-brain</title>` confirmed.
  - [x] Both dev servers cleanly stopped after smoke.

- [x] **Task 11: Final grep guard** (AC: #14, #15)
  - [x] Code grep: zero hits.
  - [x] Markdown grep: 4 hits — all in `CLAUDE.md` and `README.md` rename-history paragraphs (allowed by AC #15).

## Dev Notes

### What this story IS
A pure mechanical rename + brand cleanup. No functional change. No new dependencies. No new packages. The same code paths execute before and after; only identifiers and strings differ.

### What this story is NOT
- Not the `packages/core` bootstrap — that's Story 1.2.
- Not the migration of any service — that's Stories 1.3, 1.4.
- Not the vault compliance utility — that's Story 1.5.
- Not adding any `lokyy-brain` features. If a file doesn't reference `sternwarte`, do not touch it.

### Exact "sternwarte" inventory (audited 2026-05-23)

**Code (must rename):**
- `package.json` — root manifest `name` field.
- `packages/shared/package.json` — package `name` field.
- `pwa/package.json`, `server/package.json` — `@sternwarte/shared` dependency entry.
- TS imports in: `pwa/src/{api,App,FileTree,ImportPanel}.tsx?`, `pwa/src/editor/Editor.tsx`, `server/src/{graph/graphService,notes/notesService,pipes/pipeQueue,pipes/handlers/scrape,pipes/handlers/youtube,routes/pipes}.ts`.
- `pwa/src/editor/theme.ts` — exported identifiers `sternwarteTheme`, `sternwarteHighlight`.
- `pwa/src/editor/Editor.tsx` — consumer of those identifiers (line 6 import, lines 54-55 usage).
- `pwa/index.html` — `<title>`.
- `pwa/vite.config.ts` — PWA manifest `name`, `short_name`, and the JSDoc comment about "Sternwarte" (rename the comment too — change "Sternwarte" → "lokyy-brain" but keep the technical content).
- `server/src/index.ts` — JSDoc + console.log.
- `server/src/config.ts` — `gitAuthorEmail` default.

**Active docs (must clean):**
- `CLAUDE_CODE_AUFTRAG.md` — move to `Plans/CLAUDE_CODE_AUFTRAG_legacy.md`.

**Docs with intentional rename-history references (LEAVE):**
- `CLAUDE.md` first paragraph and "Project Identity" section explicitly explain the rename. These references are intentional documentation and must stay.
- `README.md` if it has a similar history paragraph (verify; if not, no action).
- `_bmad-output/**`, `Plans/**` — planning artifacts, exempted by AC.

**Auto-generated, regenerate not edit:**
- `pnpm-lock.yaml` — never hand-edit; regenerate via `pnpm install`.

### Approach: `git mv` over plain `mv`

This repo's `git` status was `false` per the session bootstrap, so check before assuming. If `git status` works, prefer `git mv` for the `CLAUDE_CODE_AUFTRAG.md` move so history follows. If not a git repo, `mv` is fine.

### Forbidden cleanup adjacencies

- Do NOT rename CSS class `.sw-spin` in `pwa/index.html`. It's a CSS class name, not a brand identifier, and the AC doesn't require it. Scope discipline.
- Do NOT rename `sw-` prefixed identifiers anywhere unless they break grep (AC #14). Same reason.
- Do NOT touch `_bmad/` (the BMAD installation itself).
- Do NOT modify `architecture.md`, `prd.md`, `epics.md`, or any other planning artifact.

### Build & verify commands

```bash
# from /media/oliver/Volume3/eigene_projekte_neu/lokyy-brain
pnpm install
pnpm -r build
pnpm --filter server tsc --noEmit
pnpm --filter pwa tsc --noEmit
# smoke
pnpm --filter server dev   # in one terminal
pnpm --filter pwa dev      # in another
curl http://localhost:8787/health
```

### Final grep guards

```bash
# zero hits expected
rg -i "sternwarte" --type ts --type tsx --type json --type html --type yaml --type toml \
  -g '!node_modules' -g '!_bmad-output' -g '!Plans'

# limited expected hits (rename-history paragraphs only)
rg -i "sternwarte" --type md -g '!_bmad-output' -g '!Plans'
```

### Project Structure Notes

- Workspace shape stays exactly as it is today: `packages/shared`, `server`, `pwa`. The package *name* changes to `@lokyy/shared` but the directory `packages/shared` is unchanged — this is intentional. Future Stories 1.2–1.4 introduce `packages/core` and migrate code; that's not part of this story.
- `pnpm-workspace.yaml` keeps glob `packages/*`; no edit needed.
- TS path mapping in each `tsconfig.json` should continue to resolve via the workspace `name` field — no per-tsconfig change should be necessary, but if a build fails because of path resolution, inspect (do not rebuild from scratch).

### Testing Standards

- No new tests required for a rename. The two acceptance gates are: `pnpm -r build` exits 0, and the two dev servers boot. Both already exist in the repo as the implicit smoke-tests for this kind of change.
- If existing tests reference `@sternwarte/shared` or the renamed theme exports, update them as part of Task 3 or Task 5 respectively. (Audit found none currently.)

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.1: Monorepo Rename to lokyy-brain]
- [Source: _bmad-output/planning-artifacts/architecture.md — "Monorepo rename: sternwarte → lokyy-brain..." additional requirement]
- [Source: CLAUDE.md "Project Identity" section — names the rename target identity]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

- `pnpm install` exit 0 (52.3s, 386 packages, 2 deprecated subdeps from glob/source-map — pre-existing).
- `pnpm -r build` exit 0 across all 3 workspaces (`@lokyy/shared`, `server`, `pwa`).
- Server smoke: `lokyy-brain Server laeuft auf :8787`; `/health` returned `{"ok":true}`.
- Vite smoke: `ready in 185 ms`; served `<title>lokyy-brain</title>`.
- Test remote at `/tmp/lokyy-test-remote` (bare repo, single empty commit on `main`) created for the smoke run — temporary, can be deleted.
- `rg -i "sternwarte"` final code grep returned 0 hits; markdown grep returned 4 hits, all in rename-history paragraphs (CLAUDE.md, README.md).

### Completion Notes List

- Story implemented as a pure mechanical rename. No functional change. Build green, both dev servers boot.
- One in-scope UI string in `pwa/src/App.tsx` (line 261, header brand label `<strong>Sternwarte</strong>`) was found during code-grep and renamed to `lokyy-brain`. The story spec listed the inventory but did not call out this UI string explicitly; it falls under AC #14 ("zero hits in code") and was therefore required.
- `docs/mockup/lokyy-brain-mockup.jsx` retains 4 internal `Sternwarte` strings as legacy mockup seed-data. AC #14's grep type list does not include `.jsx`, and `docs/mockup/README.md` documents the mockup as a frozen design-history artifact — not active code. Leaving the mockup untouched is a deliberate scope decision; the active PWA UI no longer reflects the old name.
- `CLAUDE.md` retains rename-history references in the "Project Identity" section and the "Epic Sequence" list. These are documentation paragraphs explicitly exempted by AC #15. They could be revised to past tense in a future housekeeping pass; out of scope for this story.
- No code-level changes to functionality, dependencies, or build configuration. The only material change beyond rename strings was the regenerated `pnpm-lock.yaml` (auto-produced by `pnpm install`).
- Story file Status moved to `review`. Sprint-status update pending (next workflow step).

### File List

**Modified:**
- `package.json` (root `name`)
- `packages/shared/package.json` (package `name`)
- `pwa/package.json` (dependency key)
- `server/package.json` (dependency key)
- `pwa/index.html` (`<title>`)
- `pwa/vite.config.ts` (manifest name/short_name + JSDoc comment)
- `pwa/src/api.ts` (import path)
- `pwa/src/App.tsx` (import path + header brand string)
- `pwa/src/FileTree.tsx` (import path)
- `pwa/src/ImportPanel.tsx` (import path)
- `pwa/src/editor/Editor.tsx` (import + array refs of theme exports)
- `pwa/src/editor/theme.ts` (renamed two exports)
- `server/src/index.ts` (JSDoc + boot console.log)
- `server/src/config.ts` (default gitAuthorName + gitAuthorEmail)
- `server/src/graph/graphService.ts` (import path)
- `server/src/notes/notesService.ts` (import path)
- `server/src/pipes/pipeQueue.ts` (import path)
- `server/src/pipes/handlers/scrape.ts` (import path)
- `server/src/pipes/handlers/youtube.ts` (import path)
- `server/src/routes/pipes.ts` (import path)
- `README.md` (heading + arbeitstitel paragraph → rename-history paragraph)
- `pnpm-lock.yaml` (regenerated)

**Moved:**
- `CLAUDE_CODE_AUFTRAG.md` → `Plans/CLAUDE_CODE_AUFTRAG_legacy.md`

**Not touched (deliberate, in-scope):**
- `pnpm-workspace.yaml` — globs unchanged.
- `docs/mockup/lokyy-brain-mockup.jsx` — frozen design artifact, `.jsx` outside AC #14 grep types.
- `CLAUDE.md` — rename-history paragraphs allowed by AC #15.
- `_bmad-output/**`, `_bmad/**`, `Plans/**` — planning/BMAD artifacts.

### Change Log

| Date | Change | By |
|------|--------|-----|
| 2026-05-23 | Story 1.1 implemented end-to-end: monorepo + package + branding rename `sternwarte → lokyy-brain` / `@sternwarte/* → @lokyy/*`. Build green, both dev servers smoke-clean. Status: ready-for-dev → review. | Dev agent (claude-opus-4-7) |
| 2026-05-23 | Code review passed after 3 review follow-ups. Status: review → done. | Code-review (Blind Hunter + Edge Case Hunter + Acceptance Auditor) |

## Senior Developer Review (AI)

**Reviewed:** 2026-05-23
**Outcome:** APPROVE (after 3 follow-ups addressed)
**Layers:** Blind Hunter, Edge Case Hunter, Acceptance Auditor — all 3 ran in parallel.

### Findings

- **[HIGH] `server/.env.example` had Sternwarte defaults** (lines 8-9): the inventory grep in Story 1.1 OBSERVE used `--include="*.{ts,tsx,json,md,html,yaml,yml,toml}"` and missed `.env.example`. Defaults flow into git commits made by the server. **Fixed.**
- **[HIGH] `docs/mockup/lokyy-brain-mockup.jsx` retained 4 Sternwarte literals** (lines 19, 158, 160, 780): file was renamed but content not updated. Mockup is the binding UX reference for Epic 2 per `docs/mockup/README.md`. Leaving "Sternwarte" inside would propagate the old name into future PWA stories. **Fixed.**
- **[LOW] CLAUDE.md "Project Identity" was stale** (line 7): said "the old name still appears in package.json, ...", which after Story 1.1 was no longer true. Self-contradictory doctrine. **Fixed** (rewritten to past tense, lists the legitimate rename-history references).
- **[MED, deferred] `pwa/dist/` checked-in but gitignored**: project is not currently a git repo (verified via `git status`). Becomes relevant when the lokyy-vault and main repo are initialized in a later Epic 1 story. Not introduced by this rename. **Deferred — track under Epic 1 cleanup.**
- **[MED, deferred] PWA manifest `lang=en` vs HTML `lang=de` mismatch**: pre-existing, not introduced by this story. Not in scope. **Deferred to a polish story.**
- **[LOW, no action] `sw-spin` CSS class**: investigated. Used by ImportPanel status icons (a spinner animation) — `sw-` most plausibly denotes "service worker" (PWA terminology), not "sternwarte". Comment in `pwa/index.html:31` (`/* von ImportPanel-Statusicons genutzt */`) supports the service-worker reading. No rename required.

### Action Items

- [x] Update `server/.env.example` GIT_AUTHOR defaults (HIGH).
- [x] Replace 4 Sternwarte literals in `docs/mockup/lokyy-brain-mockup.jsx` (HIGH).
- [x] Rewrite CLAUDE.md "Project Identity" paragraph (LOW).

### Final Verification

- `pnpm -r build` exit 0 (re-ran after fixes).
- `rg -i "sternwarte" -g '!node_modules' -g '!_bmad-output' -g '!Plans' -g '!pnpm-lock.yaml'`: 4 hits, all in legitimate rename-history paragraphs (README.md ×1, CLAUDE.md ×3).
- All 15 original Acceptance Criteria remain PASS.

**Verdict: APPROVED — story marked done.**
