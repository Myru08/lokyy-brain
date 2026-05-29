/**
 * Overlap-merge dedup for Web-Speech transcripts.
 *
 * ── Why this exists ────────────────────────────────────────────────────
 * On Android, Chrome ends a recognition turn after a short silence window
 * (even with `continuous: true`) and fires `onend`. When we auto-restart,
 * the next turn does NOT continue from where it left off — it re-delivers
 * the SAME phrase growing FROM THE START. A naive
 * `committedPrefix = committedPrefix + newTurn` therefore re-appends the
 * overlapping head of the phrase on every restart, producing the cumulative
 * stutter:
 *
 *   "okay okay okay okay ich okay ich bin okay ich bin unglaublich …"
 *
 * `mergeTranscript` folds a new turn into the committed prefix by finding the
 * LARGEST word-level overlap between the tail of the prefix and the head of
 * the addition, then appending only the non-overlapping tail of the addition.
 * Because the Android re-delivery always restates the full growing phrase,
 * the overlap is the entire previous phrase and only the genuinely new words
 * survive — the stutter collapses back to one clean sentence.
 *
 * The merge is pure (no DOM, no recognizer), so it is trivially unit-testable
 * and is exercised by `transcriptMerge.test.ts` against the real failing
 * Android sentence.
 *
 * ── Guarantees ─────────────────────────────────────────────────────────
 * - Word granularity: splits on whitespace; never merges mid-word.
 * - Case-insensitive overlap match, but the OUTPUT preserves `addition`'s
 *   casing for the surviving tail (so the recognizer's latest capitalization
 *   wins on the overlapping seam).
 * - Largest-overlap wins: picks the biggest k (0..min(len)) where the last k
 *   words of `prefix` equal the first k words of `addition`.
 * - Full-containment: if `addition` starts with the ENTIRE `prefix`, the
 *   result is `addition` (the new turn already contains everything).
 * - Zero-overlap (desktop / distinct turns): k = 0, plain single-space append
 *   — behaves exactly like the old code path UNLESS the addition is a full
 *   RESTATEMENT of the prefix (see below).
 * - Empty inputs: empty `addition` → `prefix`; empty `prefix` → `addition`.
 * - Output whitespace is collapsed to single spaces and trimmed.
 *
 * ── RESTATEMENT detection (Android full re-utterance) ─────────────────────
 * Android Chrome sometimes re-emits the ENTIRE utterance as a brand-new turn —
 * a near-duplicate that starts again FROM THE BEGINNING with minor word diffs
 * (e.g. "scheint das" → "scheint es") and possibly a few extra trailing words.
 * The seam overlap is then ZERO (prefix ends one way, addition starts with the
 * opening word again), so the naive path would plain-append and the WHOLE
 * sentence would appear twice.
 *
 * Only when the seam overlap is 0 do we additionally test whether `addition`
 * and `prefix` share a long common LEADING run (case-insensitive word compare).
 * If they share at least {@link RESTATEMENT_MIN_LEADING_WORDS} leading words
 * AND that run covers at least {@link RESTATEMENT_MIN_LEADING_RATIO} of the
 * SHORTER side's word count, we treat `addition` as a re-utterance of `prefix`
 * and return the LONGER / more-complete of the two (we do NOT concatenate).
 *
 * This is deliberately conservative: a single shared first word ("okay …")
 * can never trip it, because the absolute floor of 4 leading words is required.
 * Checking restatement only on the k === 0 branch also guarantees the existing
 * seam-overlap continuation and full-containment behaviour is untouched.
 */

/** Minimum common leading words before two turns can be judged a restatement. */
const RESTATEMENT_MIN_LEADING_WORDS = 4;
/** Common leading run must cover at least this fraction of the shorter side. */
const RESTATEMENT_MIN_LEADING_RATIO = 0.4;

/** Split on any run of whitespace, dropping empty leading/trailing tokens. */
function toWords(s: string): string[] {
  const trimmed = s.trim();
  if (trimmed === "") return [];
  return trimmed.split(/\s+/);
}

/**
 * Count the common LEADING run of two word arrays, compared case-insensitively.
 * Returns the number of words matching from index 0 onward, up to first diff.
 */
function commonLeadingWords(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  for (let i = 0; i < max; i++) {
    if (a[i]!.toLowerCase() !== b[i]!.toLowerCase()) break;
    n++;
  }
  return n;
}

/**
 * Merge `addition` into `prefix`, deduplicating the largest word-level overlap
 * between the tail of `prefix` and the head of `addition`.
 *
 * @param prefix   The already-committed transcript text.
 * @param addition The new turn's text (may restate part/all of `prefix`).
 * @returns        `prefix` + the non-overlapping tail of `addition`, with
 *                 collapsed whitespace.
 */
export function mergeTranscript(prefix: string, addition: string): string {
  const prefixWords = toWords(prefix);
  const additionWords = toWords(addition);

  // Empty-input fast paths (still normalize whitespace via re-join).
  if (additionWords.length === 0) return prefixWords.join(" ");
  if (prefixWords.length === 0) return additionWords.join(" ");

  // Find the LARGEST k such that the last k words of prefix equal the first k
  // words of addition (case-insensitive). Full-containment (addition begins
  // with the entire prefix) is just the case k === prefixWords.length, which
  // this loop reaches naturally — the surviving tail is addition[k:].
  const maxK = Math.min(prefixWords.length, additionWords.length);
  let overlap = 0;
  for (let k = maxK; k >= 1; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      const a = prefixWords[prefixWords.length - k + i];
      const b = additionWords[i];
      if (a === undefined || b === undefined) {
        match = false;
        break;
      }
      if (a.toLowerCase() !== b.toLowerCase()) {
        match = false;
        break;
      }
    }
    if (match) {
      overlap = k;
      break;
    }
  }

  // RESTATEMENT branch: only when there is NO seam overlap. Android sometimes
  // re-emits the whole utterance from the start (near-duplicate, minor word
  // diffs). If addition shares a substantial common LEADING run with prefix,
  // it is a re-utterance — return the longer/more-complete side, never both.
  if (overlap === 0) {
    const leading = commonLeadingWords(prefixWords, additionWords);
    const shorter = Math.min(prefixWords.length, additionWords.length);
    const isRestatement =
      leading >= RESTATEMENT_MIN_LEADING_WORDS &&
      leading >= shorter * RESTATEMENT_MIN_LEADING_RATIO;
    if (isRestatement) {
      const longer =
        additionWords.length >= prefixWords.length ? additionWords : prefixWords;
      return longer.join(" ");
    }
  }

  // Surviving tail of addition (its casing wins on the seam) appended to the
  // full prefix. k === 0 → plain append; k === additionWords.length → nothing
  // new, result is just prefix.
  const tail = additionWords.slice(overlap);
  if (tail.length === 0) return prefixWords.join(" ");
  return [...prefixWords, ...tail].join(" ");
}
