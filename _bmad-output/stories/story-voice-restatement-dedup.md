# Story: Voice STT — collapse full-utterance RESTATEMENTS

**Epic:** Mobile/Android UX — voice
**Origin:** Oliver — "deutlich besser, aber noch Dopplung". Real recording duplicated the whole sentence (near-identical copy) — Android re-recognized the entire utterance on onend/restart.

## Problem

`mergeTranscript(prefix, addition)` only collapses a word-level SEAM overlap (suffix of prefix == prefix of addition). On Android, the recognizer sometimes re-emits the ENTIRE utterance again as a new turn — a near-duplicate of the prior text, starting from the beginning, with minor word differences. Example actual output:

```
okay dann bin ich jetzt mal gespannt ob das deutlich besser funktioniert aber so wie es aussieht scheint das recht gut zu funktionieren und ich glaube damit könnten wir auf jeden Fall vernünftig okay dann bin ich jetzt mal gespannt ob das deutlich besser funktioniert aber so wie es aussieht scheint es recht gut zu funktionieren und ich glaube damit könnten wir auf jeden Fall vernünftig arbeiten
```

Here the second half restates the first (note "scheint das" vs "scheint es", and trailing "arbeiten"). Seam-overlap is zero (prefix ends "vernünftig", addition starts "okay"), so it plain-appends → duplicate.

## Acceptance Criteria

1. Extend `mergeTranscript` with RESTATEMENT detection: when `addition` shares a long common LEADING run with `prefix` (case-insensitive word compare) — threshold e.g. ≥ 4 common leading words AND ≥ ~40% of the shorter side's word count — treat `addition` as a re-utterance of `prefix` and return the LONGER / more-complete of the two (do NOT concatenate). Keep the existing seam-overlap merge for the continuation case, and k=0 plain-append for genuinely distinct additions.
2. Be conservative: a mere shared first word ("okay …") must NOT trigger collapse — require the substantial leading-run threshold so distinct sentences aren't eaten.
3. Add tests in `pwa/src/lib/transcriptMerge.test.ts`:
   - The EXACT real case: `mergeTranscript(v1, v2)` where
     v1 = "okay dann bin ich jetzt mal gespannt ob das deutlich besser funktioniert aber so wie es aussieht scheint das recht gut zu funktionieren und ich glaube damit könnten wir auf jeden Fall vernünftig"
     v2 = "okay dann bin ich jetzt mal gespannt ob das deutlich besser funktioniert aber so wie es aussieht scheint es recht gut zu funktionieren und ich glaube damit könnten wir auf jeden Fall vernünftig arbeiten"
     → result is a SINGLE coherent copy (assert it equals v2 / the longer, and that "okay dann bin ich" appears exactly once).
   - A negative test: two DISTINCT sentences that share only the first word are NOT collapsed (still appended).
   - Keep all existing tests green.
4. Local Web Speech only.

## Constraints

- Own ONLY: `pwa/src/lib/transcriptMerge.ts` and `pwa/src/lib/transcriptMerge.test.ts`. VoiceReviewSheet already reduces through `mergeTranscript`, so no change needed there (confirm by reading it; do NOT edit it). Do NOT touch App.tsx or other files.
- pnpm workspace; no npm/bun.

## Verification (paste exact output)

- `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; symlink main checkout node_modules if needed, then remove).
- `pnpm --filter pwa test` → all pass; show the real-case + negative test passing.

## Definition of Done

Full-utterance restatements collapse to one copy (proven by the real-recording test); distinct sentences are preserved; existing tests green; typecheck green.
