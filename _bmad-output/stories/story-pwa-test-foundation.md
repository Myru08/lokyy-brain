# Story: PWA Test Foundation (backlog item #11)

**Epic:** Hardening / lokyy-ideen backlog
**Origin:** 90_ideas/lokyy-ideen item 11 — "zusätzliche tests für alle systeme um das checken zu können"

## Context

`/pwa/src` currently has **zero** test files. Tests exist only in `packages/core` and `mcp`. This story establishes a PWA test foundation and covers the logic that historically broke (save/sync state, create-in-folder path building, api wrapper).

## Acceptance Criteria

1. Vitest + React Testing Library + jsdom configured in the `pwa` workspace via the repo's **pnpm** convention (`pnpm --filter pwa add -D ...`). No bun, no npm.
2. `pwa/vitest.config.ts` (jsdom env) and a `"test": "vitest run"` script in `pwa/package.json`.
3. Unit tests for `pwa/src/api.ts`: correct URL/method/body construction and error-path handling, with `fetch` mocked.
4. Unit test for the create-in-folder path construction (the `parentPath ? "${parentPath}/${clean}" : clean` logic used by `handleCreate`); extract a tiny pure helper if needed rather than testing through React.
5. At least one render smoke test (e.g. `Spinner` or `SaveBadge`) using RTL to prove the jsdom + RTL pipeline works.
6. `pnpm --filter pwa test` exits 0.
7. `pnpm -r build` remains green.

## Constraints

- Own ONLY these files: `pwa/package.json`, `pwa/vitest.config.ts`, `pwa/tsconfig.json` (only if test types need adding), new `pwa/src/**/*.test.ts(x)`, optional `pwa/src/test-setup.ts`. Do NOT touch App.tsx/NoteHeader.tsx/server logic (another agent owns those).
- Prefer extracting a small pure helper over refactoring components to make them testable.
- Update `.env.example` only if you introduce new env (you should not).

## Definition of Done

`pnpm --filter pwa test` green, `pnpm -r build` green, tests are meaningful (not trivial `expect(true)`).
