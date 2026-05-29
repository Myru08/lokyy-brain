# Story: Voice STT — dedup cumulative finals WITHIN a turn

**Epic:** Mobile/Android UX — voice
**Origin:** Oliver — after the first dedup fix (28e9683) voice STILL stutters on Android ("hat nix gebracht").

## Problem

`pwa/src/VoiceReviewSheet.tsx` `buildCommitted()` folds the per-turn final segments with a plain `.join(" ")` (lines ~165-169) and only applies `mergeTranscript` between the prior prefix and the whole turn. But Android Chrome can deliver the GROWING phrase as cumulative FINAL results at INCREASING indices within one turn (`{0:"okay", 1:"okay ich", 2:"okay ich bin", …}`). Plain-joining those reproduces the stutter ("okay okay ich okay ich bin…") before the prefix-merge ever runs.

## Acceptance Criteria

1. In `buildCommitted()`, fold the per-turn final segments (sorted by index) through `mergeTranscript` via reduce — NOT `.join(" ")` — so cumulative/superset finals collapse to the longest coherent form. Then merge that turn-text with the committed prefix (as today).
2. Behaviour unchanged for the normal case where successive finals are DISTINCT non-overlapping segments (they just append with a single space — `mergeTranscript` with k=0).
3. Extend `pwa/src/lib/transcriptMerge.test.ts` (or add a VoiceReviewSheet-level pure test) with a case that simulates cumulative finals at increasing indices — feed `["okay","okay ich","okay ich bin", … full sentence]` as the per-turn segment list through the same reduce logic and assert it collapses to the clean single sentence. Keep all existing tests green.
4. Local Web Speech only — no Whisper/cloud, no audio upload.

## Constraints

- Own ONLY: `pwa/src/VoiceReviewSheet.tsx` and `pwa/src/lib/transcriptMerge.test.ts`. Do NOT touch App.tsx (another agent owns it now), transcriptMerge.ts is fine to read (don't need to change it).
- pnpm workspace; no npm/bun.

## Verification (paste exact output)

- `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; worktree may need node_modules symlink from main checkout, then removed).
- `pnpm --filter pwa test` → all pass; show the new cumulative-finals test passing.

## Definition of Done

Cumulative finals within a turn collapse to clean text (proven by test); existing tests green; typecheck green; still local Web Speech.
