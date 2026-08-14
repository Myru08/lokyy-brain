import type { PassErrorSample, SleepPassResult } from "./types.js";

/**
 * issue #58 — the diagnostic channel for sleep passes.
 *
 * THE PROBLEM THIS SOLVES: `SleepPassResult` used to be `{ processed, errors,
 * notes? }`. A bare `errors++` satisfied that contract completely, so writing
 * a log line with the note id and the reason was an extra act of discipline
 * that nothing required. Counted across all passes: 23 counting sites, 6 log
 * lines. An operator saw `errors: 7` and had no way to tell which note or why
 * — that was the visible shape of #53 (entity-extraction hit the token ceiling
 * and lost entities on 6 notes without emitting a single line).
 *
 * THE FIX IS THE SHAPE, NOT THE FIELD. A required `errorSamples` field alone
 * is satisfiable with `errorSamples: []` next to `errors++` — the incentive
 * would have moved, not changed. So the counter stops being a number: passes
 * hold a `PassErrorLog` whose only counting method is `record(noteId, reason)`.
 * Incrementing without a reason is no longer expressible. `result()` then
 * assembles counter and sample from the SAME object, so the two cannot drift
 * apart the way two hand-maintained variables would.
 *
 * WHAT DOES NOT CHANGE: the `errors` number itself. It still counts exactly
 * what it counted before (one per failed unit of work), so run-over-run
 * comparisons with pre-#58 rows stay valid. A channel was added, none removed.
 */

/**
 * Maximum samples kept per pass.
 *
 * `pass_stats` is a single `jsonb` value holding EVERY pass of a run, so the
 * budget is per-run, not per-pass: 11 passes × 20 samples × ~300 bytes (vault
 * path plus a `MAX_REASON_CHARS` reason) ≈ 66 KB worst case — a size Postgres
 * and the protocol UI both shrug at, and only reachable on a night where
 * everything fails at once.
 *
 * 20 is chosen against what the passes can actually produce, not as a round
 * number: the per-run work caps are 20 notes (entity-extraction), 25
 * (embedding-backfill) and 50 (ulid-backfill), so for the pass that motivated
 * this issue the sample is COMPLETE — every failure is in there, none inferred.
 * The unbounded passes (synaptic-pruning walks every graph edge,
 * bi-temporal-validation up to 500 rows) are the ones that get truncated, and
 * for those 20 is already past the point of diminishing returns: what an
 * operator needs from a mass failure is the shape (one note or all of them,
 * one reason or several), and the shape is visible long before the twentieth
 * entry. The exact total is never lost — it stays in `errors`.
 */
export const MAX_ERROR_SAMPLES = 20;

/**
 * Per-reason character cap. Long enough for a driver error message plus
 * context, short enough that a stack trace or a dumped LLM response can't
 * inflate the row. Reasons are diagnostics, not evidence: the full text still
 * goes to the log line the call site writes.
 */
export const MAX_REASON_CHARS = 200;

/**
 * Sentinel `noteId` for failures that belong to the pass, not to one note —
 * "no ner provider configured", "DB unavailable", the outer `catch` of a pass.
 *
 * The convention exists because the alternatives are worse: an empty string is
 * a note id that looks real and resolves to nothing, and making `noteId`
 * optional re-opens the same "omit it and the contract is still satisfied"
 * hole the whole issue is about. The angle brackets are the point — they
 * appear in neither a vault path nor a ULID, so no consumer can mistake the
 * sentinel for something it could open. Use `isPassScoped()` to test for it
 * rather than comparing the literal.
 */
export const PASS_SCOPE_NOTE_ID = "<pass>";

/** True when this sample describes a pass-wide failure, not a per-note one. */
export function isPassScoped(sample: PassErrorSample): boolean {
  return sample.noteId === PASS_SCOPE_NOTE_ID;
}

/**
 * True when the pass produced more failures than the sample can hold. Derived
 * from the two numbers already present — a separate `totalErrors` field would
 * duplicate `errors` and invite the two to disagree.
 */
export function errorSamplesTruncated(result: SleepPassResult): boolean {
  return result.errors > result.errorSamples.length;
}

/** Normalize anything a `catch` can hand us into a short, readable reason. */
function toReason(reason: unknown): string {
  const raw =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : (() => {
            try {
              return JSON.stringify(reason) ?? String(reason);
            } catch {
              return String(reason);
            }
          })();
  const trimmed = raw.trim();
  // An empty reason is the silent failure wearing a new coat — name it.
  if (trimmed.length === 0) return "unspecified error";
  return trimmed.slice(0, MAX_REASON_CHARS);
}

/** Error counter + capped sample for one pass execution. See module jsdoc. */
export interface PassErrorLog {
  /** Number of recorded failures — becomes `SleepPassResult.errors`. */
  readonly count: number;
  /** The kept sample (copy), capped at `MAX_ERROR_SAMPLES`. */
  readonly samples: PassErrorSample[];
  /**
   * Record one failed unit of work. This is the ONLY way to increment the
   * counter, which is the whole point: no count without a reason.
   *
   * `reason` takes whatever the call site has — an `Error`, a string, or an
   * arbitrary throw value.
   *
   * An empty `noteId` is treated as pass-scoped rather than stored as `""`.
   */
  record(noteId: string, reason: unknown): void;
  /** Record a failure that isn't attributable to a single note. */
  recordPassScoped(reason: unknown): void;
  /** Assemble the pass result. `notes` is omitted when not supplied. */
  result(processed: number, notes?: string): SleepPassResult;
}

/** Create a fresh error log. One per pass execution, never shared. */
export function createPassErrorLog(): PassErrorLog {
  let count = 0;
  const samples: PassErrorSample[] = [];

  function push(noteId: string, reason: unknown): void {
    count++;
    // Cap on the SAMPLE only — the count above is always exact.
    if (samples.length >= MAX_ERROR_SAMPLES) return;
    const id = noteId.trim();
    samples.push({
      noteId: id.length > 0 ? id : PASS_SCOPE_NOTE_ID,
      reason: toReason(reason),
    });
  }

  return {
    get count() {
      return count;
    },
    get samples() {
      return samples.map((s) => ({ ...s }));
    },
    record(noteId: string, reason: unknown): void {
      push(noteId, reason);
    },
    recordPassScoped(reason: unknown): void {
      push(PASS_SCOPE_NOTE_ID, reason);
    },
    result(processed: number, notes?: string): SleepPassResult {
      const base: SleepPassResult = {
        processed,
        errors: count,
        errorSamples: samples.map((s) => ({ ...s })),
      };
      return notes === undefined ? base : { ...base, notes };
    },
  };
}
