import { eq, sql } from "drizzle-orm";

import { database } from "../db/index.js";
import { noteScoring } from "../db/schema/noteScoring.js";
import type { DocType } from "../frontmatter/index.js";
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
 * Errors per note are logged and counted but do NOT abort the run.
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
      console.warn(
        `[scoring] recomputeOne failed for ${entry.noteId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { processed, errors };
}
