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
 *   — behaves exactly like the old code path.
 * - Empty inputs: empty `addition` → `prefix`; empty `prefix` → `addition`.
 * - Output whitespace is collapsed to single spaces and trimmed.
 */

/** Split on any run of whitespace, dropping empty leading/trailing tokens. */
function toWords(s: string): string[] {
  const trimmed = s.trim();
  if (trimmed === "") return [];
  return trimmed.split(/\s+/);
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

  // Surviving tail of addition (its casing wins on the seam) appended to the
  // full prefix. k === 0 → plain append; k === additionWords.length → nothing
  // new, result is just prefix.
  const tail = additionWords.slice(overlap);
  if (tail.length === 0) return prefixWords.join(" ");
  return [...prefixWords, ...tail].join(" ");
}
