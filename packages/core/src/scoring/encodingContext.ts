/**
 * Phase B Wave B3 / Story 1 — Encoding-Context-Match-Boost.
 *
 * Tulving 1973 (Encoding Specificity Principle): Recall is better when the
 * retrieval-cue matches the context that was present during encoding. We
 * snapshot the context at note-creation time (device, time-of-day, weekday,
 * preceding-notes, session-duration, …) and store it in the frontmatter's
 * `encoded:` block. At retrieve-time we compare the current session-context
 * against each candidate's `encoded` block and multiply the retrieval score
 * by a small boost when fields match.
 *
 * This module is pure (no I/O, no Date.now() except via the optional `now`
 * arg) — easy to unit-test, safe to call from any layer.
 */

import type {
  DeviceType,
  EncodedContext,
  TimeOfDay,
  Weekday,
} from "../frontmatter/types.js";

// ─── Capture ────────────────────────────────────────────────────────────

/**
 * Inputs the caller controls at capture-time. Time-of-day and weekday are
 * derived from `now` — the caller only provides device + session-shape +
 * preceding-notes.
 */
export interface CaptureContextInput {
  device?: DeviceType;
  app_state?: string;
  preceding_notes?: string[];
  session_duration_min?: number;
  word_count_session?: number;
  source?: Record<string, unknown>;
}

/**
 * Bucket a `Date` into a coarse time-of-day label.
 *
 *   05:00 – 10:59  → morning
 *   11:00 – 16:59  → midday
 *   17:00 – 21:59  → evening
 *   22:00 – 04:59  → night
 *
 * Boundaries chosen to keep "evening" matching everyday usage in the
 * principal's timezone — the retrieval-side asks "was that an evening
 * thought?", so the bucket has to be wide enough to absorb ±2h drift
 * across days.
 */
export function timeOfDayFrom(date: Date): TimeOfDay {
  const h = date.getHours();
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 17) return "midday";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

/**
 * Map a `Date` to its weekday in lowercase English (`"monday"` … `"sunday"`).
 * `Date.prototype.getDay` returns Sunday = 0, so we index into the array
 * with that offset directly.
 */
export function weekdayFrom(date: Date): Weekday {
  const days: Weekday[] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  // getDay() ∈ [0,6] — array length is 7, so the indexed access is total
  // and the non-null assertion is a TS-only formality.
  return days[date.getDay()]!;
}

/**
 * Build an `EncodedContext` snapshot from the inputs + current time. Used
 * by `notesService.createNote` and by server routes that need to capture
 * context before reaching core (e.g. the pipe handlers).
 *
 * Returns a fresh object — never mutates `input`. Fields the caller did
 * not provide stay `undefined`; the JSON-Schema validator (additionalProperties)
 * accepts the partial block.
 */
export function captureEncodingContext(
  input: CaptureContextInput = {},
  now: Date = new Date(),
): EncodedContext {
  return {
    device: input.device,
    app_state: input.app_state,
    time_of_day: timeOfDayFrom(now),
    weekday: weekdayFrom(now),
    preceding_notes: input.preceding_notes,
    session_duration_min: input.session_duration_min,
    word_count_session: input.word_count_session,
    source: input.source,
  };
}

// ─── Match-Scoring ──────────────────────────────────────────────────────

/**
 * Current session context at retrieve-time. Caller assembles it from the
 * incoming HTTP request (device via User-Agent), the wall clock
 * (time_of_day, weekday) and the working-memory state (preceding_notes,
 * active_project).
 */
export interface QueryContext {
  device?: DeviceType;
  time_of_day?: TimeOfDay;
  weekday?: Weekday;
  /** Notes currently open / recently active in the requesting session. */
  preceding_notes?: string[];
  /** Top-level folder of the currently-active note (e.g. `"20_projects/lokyy"`). */
  active_project?: string;
}

export interface ContextMatchResult {
  /** Multiplier applied to the retrieval score. Range [1.0, MAX_BOOST]. */
  totalBoost: number;
  /** Per-field breakdown — useful for debugging + UI explanations. */
  matches: Array<{ field: string; weight: number }>;
}

/**
 * Per-field weight contributions. Values calibrated so an all-match
 * candidate lands near `MAX_BOOST` (1.65), well-separated from the no-match
 * baseline of 1.0.
 *
 * `preceding_notes_overlap` and `active_project` carry the most weight —
 * they are strong signals of topical continuity ("I am still in the same
 * project"), whereas `device`/`time_of_day`/`weekday` are weak background
 * cues. We deliberately keep the weak cues weak so they cannot drown out
 * a textual mismatch.
 */
const MATCH_WEIGHTS = {
  device: 0.05,
  time_of_day: 0.1,
  weekday: 0.05,
  preceding_notes_overlap: 0.25,
  active_project: 0.2,
} as const;

/** Hard cap on the boost multiplier. See `contextMatchBoost` docstring. */
const MAX_BOOST = 1.8;

/**
 * Compute a context-match boost for `noteEncoded` against the
 * `queryCtx`. Returns a multiplier in `[1.0, MAX_BOOST]`. Pure function:
 * given the same inputs it always returns the same output.
 *
 * Semantics per field:
 *   - device, time_of_day, weekday — strict equality match.
 *   - preceding_notes_overlap — proportional to overlap size; saturates
 *     at 3 shared notes (further overlap adds nothing). The bucketed
 *     curve is `min(1, overlap/3) * weight`.
 *   - active_project — prefix match on `noteFolder`. Caller passes the
 *     note's parent folder; we test whether it starts with the query's
 *     active project path. This lets `"20_projects/lokyy/notes"` match
 *     an active project of `"20_projects/lokyy"`.
 *
 * The cap at `MAX_BOOST = 1.8x` is intentional: even when every signal
 * matches we never let context dominate textual relevance — a high-BM25
 * hit with no context match must still beat a low-BM25 hit with full
 * context match. With the current weights, an all-match candidate scores
 * 1.65; with all signals at full overlap we'd hit 1.65, leaving headroom
 * before the cap. The cap exists only to prevent future weight-tweaks
 * from accidentally producing a runaway multiplier.
 */
export function contextMatchBoost(
  noteEncoded: EncodedContext | undefined,
  queryCtx: QueryContext,
  noteFolder?: string,
): ContextMatchResult {
  if (!noteEncoded) return { totalBoost: 1.0, matches: [] };

  const matches: Array<{ field: string; weight: number }> = [];
  let boost = 1.0;

  if (queryCtx.device && noteEncoded.device === queryCtx.device) {
    matches.push({ field: "device", weight: MATCH_WEIGHTS.device });
    boost += MATCH_WEIGHTS.device;
  }
  if (queryCtx.time_of_day && noteEncoded.time_of_day === queryCtx.time_of_day) {
    matches.push({ field: "time_of_day", weight: MATCH_WEIGHTS.time_of_day });
    boost += MATCH_WEIGHTS.time_of_day;
  }
  if (queryCtx.weekday && noteEncoded.weekday === queryCtx.weekday) {
    matches.push({ field: "weekday", weight: MATCH_WEIGHTS.weekday });
    boost += MATCH_WEIGHTS.weekday;
  }

  // Preceding-notes overlap — bucketed at 3 shared notes for saturation.
  if (
    queryCtx.preceding_notes?.length &&
    noteEncoded.preceding_notes?.length
  ) {
    const noteSet = new Set(noteEncoded.preceding_notes);
    const overlapCount = queryCtx.preceding_notes.filter((n) =>
      noteSet.has(n),
    ).length;
    if (overlapCount > 0) {
      const overlapBoost =
        Math.min(1, overlapCount / 3) * MATCH_WEIGHTS.preceding_notes_overlap;
      matches.push({
        field: "preceding_notes_overlap",
        weight: overlapBoost,
      });
      boost += overlapBoost;
    }
  }

  // Active-project — prefix match on the note's folder. Caller supplies
  // both sides; we keep the comparison case-sensitive to match the
  // filesystem-canonical vault paths.
  if (
    queryCtx.active_project &&
    noteFolder &&
    noteFolder.startsWith(queryCtx.active_project)
  ) {
    matches.push({
      field: "active_project",
      weight: MATCH_WEIGHTS.active_project,
    });
    boost += MATCH_WEIGHTS.active_project;
  }

  return { totalBoost: Math.min(MAX_BOOST, boost), matches };
}

/**
 * Search-hit shape consumed by `applyContextBoost`. Mirrors the minimal
 * fields the retrieval pipeline already carries — extensible because the
 * pipeline owns the canonical hit shape.
 */
export interface ScoredHit {
  noteId: string;
  score: number;
  encoded?: EncodedContext;
  /** Parent folder used for `active_project` prefix match. */
  folder?: string;
}

/**
 * Batch-apply `contextMatchBoost` to a list of hits and re-sort by the
 * boosted score (descending). The original `score` is preserved on each
 * hit; the boosted value lands in `boostedScore`, and the per-field
 * breakdown is attached for explainability.
 */
export function applyContextBoost(
  hits: ScoredHit[],
  queryCtx: QueryContext,
): Array<ScoredHit & { boostedScore: number; contextMatch: ContextMatchResult }> {
  return hits
    .map((h) => {
      const result = contextMatchBoost(h.encoded, queryCtx, h.folder);
      return {
        ...h,
        boostedScore: h.score * result.totalBoost,
        contextMatch: result,
      };
    })
    .sort((a, b) => b.boostedScore - a.boostedScore);
}
