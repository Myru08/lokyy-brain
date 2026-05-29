# Story: Fix Tier-1 search performance (25s → fast, use pg_search BM25)

**Epic:** Search / performance
**Origin:** Diagnostics on the live deployment: "Tier 1 Probe (strukturell)" = 5 hits for "test" but **25670 ms**; "Combined" = 25808 ms. Target was p95 < 500ms. This 25s is why the app search feels dead ("Enter does nothing" — it's just 50× too slow).

## Root cause (confirmed)

`packages/core/src/memory/Tier1Provider.ts` builds an in-memory index lazily by calling `getNote(id)` for EVERY note (`rebuild()` loops `listNotes()` → per-note `getNote`). Cold (first search, or a fresh provider instance like the diagnostics `new Tier1Provider()`), that's ~25s for 91 notes (disk/git per note). Meanwhile `pg_search`/BM25 (v0.23.4) IS installed, a `note_search` table + `Tier1BM25.ts` exist, and `/api/search/hybrid` already uses the indexed BM25 + pgvector RRF path.

## Acceptance Criteria

1. The app's structural/Tier-1 search must be served by the **indexed pg_search BM25 path** (`Tier1BM25`), NOT the cold in-memory `Tier1Provider` rebuild. Investigate the cleanest wiring:
   - Either make `getMemoryProvider().search` / the `/api/search` route use `Tier1BM25` for the Tier-1 leg, OR point the PWA `api.search` at the already-fast `/api/search/hybrid` (BM25 + pgvector RRF, which degrades to BM25-only when embeddings are empty — `degraded: "no_embedding"`). Pick the one that's least invasive and keeps the response shape the CommandPalette consumes (`{ results }`) — if you switch the PWA to `/search/hybrid`, adapt the response mapping so CommandPalette still gets `results`.
2. Result quality must be **>=** today (the probe returns 5 hits for "test" — don't regress to 0).
3. Latency target: well under 1s for the probe on a ~100-note vault (no per-note cold rebuild in the hot path).
4. Graceful: if `note_search`/BM25 is unavailable, fall back to the existing path rather than erroring. If existing notes were never indexed into `note_search`, NOTE that an existing backfill route (`server/src/routes/backfill.ts`) populates it — do NOT build a new backfill; just reference it in your report so the Orchestrator/user can trigger it.
5. Keep the diagnostics "Tier 1 Probe" meaningful (it may still instantiate Tier1Provider directly — that's fine for the probe, but the APP path must be fast).

## Constraints

- Own: `packages/core/src/memory/*` (Tier1/MemoryProvider wiring), `server/src/routes/search.ts`, `pwa/src/api.ts`. Do NOT touch Settings.tsx, App.tsx, AiProviderSettings.tsx, main.tsx, diagnostics.ts (other agents own those now).
- pnpm workspace; no npm/bun. Provider-agnostic.

## Verification (paste exact output)

- If core changed: `pnpm --filter @lokyy/core build` → 0 first.
- `pnpm --filter server exec tsc --noEmit` → 0 AND `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; symlink node_modules if needed, then remove).
- `pnpm --filter pwa test` → existing tests green.

## Definition of Done

App search served by the indexed BM25 path (no cold per-note rebuild in the hot path); >=5 hits for "test"; sub-second; graceful fallback; typechecks + tests green. Report which wiring you chose and whether a note_search backfill is needed.
