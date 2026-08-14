import { eq, sql } from "drizzle-orm";

import { database } from "../db/index.js";
import { noteScoring } from "../db/schema/noteScoring.js";
import type { DocType } from "../frontmatter/index.js";
import {
  MAX_ERROR_SAMPLES,
  MAX_REASON_CHARS,
} from "../sleep-agent/errorSamples.js";
import type { PassErrorSample } from "../sleep-agent/types.js";
import {
  computeImportance,
  recencyDecay,
  type ImportanceSignals,
} from "./importance.js";

/**
 * Phase A Wave A1 / Story 1 — DB adapter for `note_scoring`.
 *
 * Pure helpers around the Drizzle table. The sleep-agent NREM phase calls
 * `recomputeAll`; HTTP routes call `touchView` / `touchEdit` to bump
 * counters + reset `lastAccessed`. All writes are upserts so callers never
 * need to pre-seed rows.
 *
 * ── THE KEY IS THE VAULT PATH ID — issue #61 ────────────────────────────
 *
 * `note_scoring.note_id` holds the PATH id (`50_decisions/foo`, the thing
 * `listNotes()` returns and the HTTP layer speaks), NOT the frontmatter ULID.
 * This module does not translate between the two: `getScoring` is a bare
 * equality lookup, so every writer must agree with every reader or the lookup
 * silently misses.
 *
 * It did miss. `recomputeAll` used to be fed ULIDs by the sleep pass while
 * `touchView`/`touchEdit` wrote path ids, and `importanceScore` is written by
 * NOTHING BUT `recomputeAll` — so the only reader (`llm/reranker.ts`, which
 * looks up by search-hit id = path id) never found a row and fell back to its
 * `?? 0.5` default for every note in every query. Two rows accumulated per
 * note, one holding importance without usage, one usage without importance.
 *
 * Why the path id won over the move-stable ULID: the reader cannot produce
 * anything else (search hits and routes carry paths, and a per-lookup ULID
 * translation would walk the vault inside a hot path), every other derived
 * store keys the same way, and the loss on a move is self-healing — the
 * nightly pass recomputes `importanceScore`/`recencyScore` from scratch, and
 * `viewCount`/`editCount`/`lastAccessed` were already path-keyed, so nothing
 * regressed. Move-stability belongs in the `onNoteMoved` sink (#55), which
 * rewrites this column like it rewrites every other derived store.
 */

export interface NoteScoringRow {
  noteId: string;
  importanceScore: number;
  recencyScore: number;
  lastAccessed?: Date;
  incomingBacklinks: number;
  viewCount: number;
  editCount: number;
  coCitationMax: number;
}

export interface RecomputeAllResult {
  /** Notes successfully processed. */
  processed: number;
  /** Notes that threw during processing (logged, not re-thrown). */
  errors: number;
  /**
   * Which notes failed and why — issue #60.
   *
   * `recomputeAll` swallows per-note failures on purpose (one bad note must
   * not abort a nightly run), and used to return counts only. That made
   * `importance-recompute` the one sleep pass that could not fill the
   * `errorSamples` channel #58 introduced: an operator saw `errors: 7` and had
   * to go grep the container log for the ids. Returning them closes that.
   *
   * Capped at `MAX_ERROR_SAMPLES` — the SAME constant the passes cap with, so
   * the two limits cannot drift apart. `errors` stays the exact total, which
   * is what makes `errorSamplesTruncated()` work on the pass result.
   */
  errorSamples: PassErrorSample[];
}

/** Fetch a scoring row, or null if the note has not been scored yet. */
export async function getScoring(noteId: string): Promise<NoteScoringRow | null> {
  const db = database();
  const rows = await db
    .select()
    .from(noteScoring)
    .where(eq(noteScoring.noteId, noteId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    noteId: row.noteId,
    importanceScore: row.importanceScore,
    recencyScore: row.recencyScore,
    lastAccessed: row.lastAccessed ?? undefined,
    incomingBacklinks: row.incomingBacklinks,
    viewCount: row.viewCount,
    editCount: row.editCount,
    coCitationMax: row.coCitationMax,
  };
}

/**
 * Insert or update a scoring row. `lastRecomputed` is bumped automatically
 * (caller doesn't supply it; it's a side-channel for the sleep-agent).
 */
export async function upsertScoring(row: NoteScoringRow): Promise<void> {
  const db = database();
  await db
    .insert(noteScoring)
    .values({
      noteId: row.noteId,
      importanceScore: row.importanceScore,
      recencyScore: row.recencyScore,
      lastAccessed: row.lastAccessed ?? null,
      incomingBacklinks: row.incomingBacklinks,
      viewCount: row.viewCount,
      editCount: row.editCount,
      coCitationMax: row.coCitationMax,
      lastRecomputed: new Date(),
    })
    .onConflictDoUpdate({
      target: noteScoring.noteId,
      set: {
        importanceScore: row.importanceScore,
        recencyScore: row.recencyScore,
        lastAccessed: row.lastAccessed ?? null,
        incomingBacklinks: row.incomingBacklinks,
        viewCount: row.viewCount,
        editCount: row.editCount,
        coCitationMax: row.coCitationMax,
        lastRecomputed: new Date(),
      },
    });
}

/**
 * Touch — note was opened. Resets `last_accessed` to `now`, increments
 * `view_count`. Upserts a row at default values if missing so a brand-new
 * note tracked only by opens still gets a row.
 *
 * Does NOT recompute the importance score on its own — the sleep-agent
 * (or an explicit `recomputeOne` call after touch with type+updated in
 * hand) does that. We don't recompute here because we don't know the
 * note's DocType/`updated` without an extra read.
 */
export async function touchView(noteId: string): Promise<void> {
  const db = database();
  const now = new Date();
  await db
    .insert(noteScoring)
    .values({
      noteId,
      lastAccessed: now,
      viewCount: 1,
    })
    .onConflictDoUpdate({
      target: noteScoring.noteId,
      set: {
        lastAccessed: now,
        viewCount: sql`${noteScoring.viewCount} + 1`,
      },
    });
}

/** Touch — note was edited. Resets `last_accessed`, increments `edit_count`. */
export async function touchEdit(noteId: string): Promise<void> {
  const db = database();
  const now = new Date();
  await db
    .insert(noteScoring)
    .values({
      noteId,
      lastAccessed: now,
      editCount: 1,
    })
    .onConflictDoUpdate({
      target: noteScoring.noteId,
      set: {
        lastAccessed: now,
        editCount: sql`${noteScoring.editCount} + 1`,
      },
    });
}

/**
 * Recompute importance + recency for one note using its current signals
 * (counters are read from the existing row, structural inputs are passed
 * in by the caller — they live in `graphService`, not here).
 *
 * If no row exists yet, creates one with zeroed counters and the given
 * `type` / `updated` to seed the recency calculation.
 */
export async function recomputeOne(
  noteId: string,
  type: DocType,
  updated: Date,
  structuralOverrides: {
    incomingBacklinks?: number;
    coCitationMax?: number;
  } = {},
  now: Date = new Date(),
): Promise<NoteScoringRow> {
  const existing = await getScoring(noteId);
  const incomingBacklinks =
    structuralOverrides.incomingBacklinks ?? existing?.incomingBacklinks ?? 0;
  const coCitationMax =
    structuralOverrides.coCitationMax ?? existing?.coCitationMax ?? 0;
  const viewCount = existing?.viewCount ?? 0;
  const editCount = existing?.editCount ?? 0;
  const lastAccessed = existing?.lastAccessed;

  const signals: ImportanceSignals = {
    type,
    updated,
    lastAccessed,
    incomingBacklinks,
    viewCount,
    editCount,
    coCitationMax,
  };

  const recencyScore = recencyDecay(updated, lastAccessed, type, now);
  const importanceScore = computeImportance(signals, now);

  const row: NoteScoringRow = {
    noteId,
    importanceScore,
    recencyScore,
    lastAccessed,
    incomingBacklinks,
    viewCount,
    editCount,
    coCitationMax,
  };
  await upsertScoring(row);
  return row;
}

/**
 * Recompute all notes — sleep-agent NREM phase entry point. Streamed via
 * async iterable so the caller can fan in from disk walk + graph build
 * without loading everything into memory.
 *
 * `noteId` must be the vault PATH id — see the module header.
 *
 * Errors per note are logged, counted, AND returned (capped) so the calling
 * pass can report them per note instead of as a bare number — issue #60.
 */
export async function recomputeAll(
  iter: AsyncIterable<{
    noteId: string;
    type: DocType;
    updated: Date;
    incomingBacklinks?: number;
    coCitationMax?: number;
  }>,
  now: Date = new Date(),
): Promise<RecomputeAllResult> {
  let processed = 0;
  let errors = 0;
  const errorSamples: PassErrorSample[] = [];
  for await (const entry of iter) {
    try {
      await recomputeOne(
        entry.noteId,
        entry.type,
        entry.updated,
        {
          incomingBacklinks: entry.incomingBacklinks,
          coCitationMax: entry.coCitationMax,
        },
        now,
      );
      processed += 1;
    } catch (err) {
      errors += 1;
      const reason = err instanceof Error ? err.message : String(err);
      // Log line kept: it carries the FULL reason, the sample carries a
      // truncated one. Log and structured return are not alternatives.
      console.warn(`[scoring] recomputeOne failed for ${entry.noteId}: ${reason}`);
      // Cap the sample only — `errors` above stays exact, which is the
      // invariant `errorSamplesTruncated()` reads.
      if (errorSamples.length < MAX_ERROR_SAMPLES) {
        errorSamples.push({ noteId: entry.noteId, reason: toReason(reason) });
      }
    }
  }
  return { processed, errors, errorSamples };
}

/**
 * Trim a failure reason to sample size.
 *
 * Mirrors `toReason()` in `sleep-agent/errorSamples.ts` — that one is module-
 * private, and exporting it to save four lines would widen the sleep-agent's
 * surface for a caller that only ever has a string in hand. The two constants
 * that actually matter (`MAX_REASON_CHARS`, `MAX_ERROR_SAMPLES`) ARE shared,
 * so the limits cannot drift; only the trivial trimming is repeated.
 */
function toReason(raw: string): string {
  const trimmed = raw.trim();
  // An empty reason is the silent failure wearing a new coat — name it.
  if (trimmed.length === 0) return "unspecified error";
  return trimmed.slice(0, MAX_REASON_CHARS);
}
