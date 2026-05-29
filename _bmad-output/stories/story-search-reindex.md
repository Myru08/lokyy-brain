# Story: note_search reindex (make BM25 fast path effective for existing notes)

**Epic:** Search / performance
**Origin:** The Tier-1 BM25 fix (commit 6b01360) only helps when `note_search` is populated. `note_search` is filled only by `queueSearchIndexRefresh` on save/create/move — pre-existing notes (the user's ~91) were likely never indexed, so BM25 returns 0 → falls back to the 25s in-memory rebuild. Need a one-time reindex + visibility.

## Acceptance Criteria

1. **Reindex endpoint**: `POST /api/search/reindex` (in server/src/routes/search.ts) iterates `listNotes()` and upserts each into `note_search` via the existing `Tier1BM25` upsert path (reuse it — do NOT hand-roll SQL). Returns `{ indexed: number, ms: number }`. Defensive (per-note errors collected, never 500 the whole run). Behind the existing auth/setup gate.
2. **Diagnostics visibility**: add a check to server/src/routes/diagnostics.ts `search` group: "note_search befüllt" → row count vs total notes; if 0 / far below note count → `severity:"warn"` with detail "Suchindex leer/veraltet → 'Suchindex neu aufbauen' drücken".
3. **UI trigger**: in Settings.tsx (Wartung tab, alongside other maintenance actions) a "Suchindex neu aufbauen" button → `api.reindexSearch()` → shows running/done + the indexed count. Touch-sized, themed.
4. **api.ts**: `reindexSearch() => Promise<{indexed:number,ms:number}>`.

## Constraints

- Own: `server/src/routes/search.ts`, `server/src/routes/diagnostics.ts`, `pwa/src/api.ts`, `pwa/src/Settings.tsx`. Reuse Tier1BM25's upsert (read packages/core/src/memory/Tier1BM25.ts; do not modify core). Do NOT touch CombinedProvider/memory, App.tsx, main.tsx.
- pnpm workspace; no npm/bun.

## Verification (paste exact output)

- `pnpm --filter server exec tsc --noEmit` → 0 AND `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; symlink node_modules if needed, then remove).
- `pnpm --filter pwa test` → existing tests green.

## Definition of Done

A reindex endpoint + Wartung button populate note_search for all notes; diagnostics shows note_search fill level; after running, the BM25 fast path serves existing notes sub-second. Typechecks + tests green.
