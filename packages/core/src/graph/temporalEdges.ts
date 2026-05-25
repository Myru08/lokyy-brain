import { ulid } from "ulid";
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import { database } from "../db/index.js";
import {
  temporalEdges,
  type TemporalEdgeRow,
  type TemporalEdgeKind,
} from "../db/schema/temporalEdges.js";

/**
 * Phase C Wave C2 / Story 1 — Bi-Temporal-Edge read/write surface.
 *
 * Sits parallel to `edgeWeights.ts`. While edge_weights tracks the synaptic
 * strength of a wikilink edge (one row per directed pair, recomputed every
 * NREM run), temporal_edges tracks every asserted-fact claim with FULL
 * bi-temporal provenance.
 *
 * Two axes of time:
 *   - system-time (`t_created` / `t_expired`): when the row existed in this DB
 *   - real-world-time (`t_valid` / `t_invalid`): when the claim held in reality
 *
 * Invalidation NEVER deletes. The caller calls `invalidateEdge` to set
 * `t_invalid` + `invalidated_by` on the old row, then inserts a new row for
 * the replacement claim. Both stay in the table; point-in-time queries at
 * any past timestamp T return the edges that were valid at T.
 *
 * Consumer contract:
 *   - `activeEdgesFrom`             — hot retrieval path
 *   - `edgesFromAsOf`               — point-in-time / time-travel queries
 *   - `findInvalidationCandidates`  — used by callers deciding whether to
 *                                     invalidate before inserting
 *   - `syncWikilinksToTemporalEdges`— bulk hook for notesService.save/create
 */

export type EdgeKind = TemporalEdgeKind;

/** Input for `createTemporalEdge`. */
export interface TemporalEdgeInput {
  fromNoteId: string;
  toNoteId: string;
  edgeKind: EdgeKind;
  /** When the asserted fact began holding in reality. Defaults to `now`. */
  tValid?: Date;
  sourceNoteId?: string;
  factText?: string;
  /** 0..1 — stored as text so callers can pick their precision. */
  confidence?: number;
  metadata?: Record<string, unknown>;
}

/** Hydrated, TS-friendly view of one row. */
export interface TemporalEdge {
  id: string;
  fromNoteId: string;
  toNoteId: string;
  edgeKind: EdgeKind;
  tCreated: Date;
  tExpired: Date | null;
  tValid: Date;
  tInvalid: Date | null;
  sourceNoteId: string | null;
  invalidatedBy: string | null;
  factText: string | null;
  confidence: number | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Insert a new edge. Does NOT auto-invalidate existing matches — the caller
 * is the one with the domain knowledge ("does Note B contradict Note A's
 * claim?"). Use `findInvalidationCandidates` + `invalidateEdge` for that.
 */
export async function createTemporalEdge(
  input: TemporalEdgeInput,
): Promise<TemporalEdge> {
  const id = ulid();
  const tValid = input.tValid ?? new Date();
  const confidence =
    typeof input.confidence === "number"
      ? clamp01(input.confidence).toString()
      : null;
  await database()
    .insert(temporalEdges)
    .values({
      id,
      fromNoteId: input.fromNoteId,
      toNoteId: input.toNoteId,
      edgeKind: input.edgeKind,
      tValid,
      sourceNoteId: input.sourceNoteId ?? null,
      factText: input.factText ?? null,
      confidence,
      metadata:
        input.metadata === undefined
          ? null
          : (input.metadata as Record<string, unknown>),
    });
  const row = await getRow(id);
  if (!row) {
    throw new Error(`temporal-edge insert vanished id=${id}`);
  }
  return rowToEdge(row);
}

/**
 * Mark an edge as invalidated. Sets `t_invalid` (real-world) and the
 * `invalidated_by` pointer. The row stays in the table — historical
 * queries still see it.
 *
 * Idempotent: re-invalidating an already-invalid edge no-ops (we don't
 * overwrite the original invalidation timestamp).
 */
export async function invalidateEdge(
  edgeId: string,
  invalidatedBy: string,
  invalidAt: Date = new Date(),
): Promise<void> {
  await database()
    .update(temporalEdges)
    .set({
      tInvalid: invalidAt,
      invalidatedBy,
    })
    .where(
      and(eq(temporalEdges.id, edgeId), isNull(temporalEdges.tInvalid)),
    );
}

/**
 * All currently-active outbound edges from `noteId` (where `t_invalid IS
 * NULL`). Uses the partial active-index for O(active-edge-count) lookup.
 */
export async function activeEdgesFrom(noteId: string): Promise<TemporalEdge[]> {
  const rows = await database()
    .select()
    .from(temporalEdges)
    .where(
      and(
        eq(temporalEdges.fromNoteId, noteId),
        isNull(temporalEdges.tInvalid),
      ),
    )
    .orderBy(desc(temporalEdges.tValid));
  return rows.map(rowToEdge);
}

/**
 * Point-in-time query: edges that were valid as-of `asOf`.
 *
 * Predicate:
 *   `t_valid <= asOf AND (t_invalid IS NULL OR t_invalid > asOf)`
 *
 * The right-hand `OR` is what makes this bi-temporal — an edge that's been
 * invalidated SINCE `asOf` is still returned, because at `asOf` it was
 * still believed to be true.
 */
export async function edgesFromAsOf(
  noteId: string,
  asOf: Date,
): Promise<TemporalEdge[]> {
  const rows = await database()
    .select()
    .from(temporalEdges)
    .where(
      and(
        eq(temporalEdges.fromNoteId, noteId),
        lte(temporalEdges.tValid, asOf),
        or(
          isNull(temporalEdges.tInvalid),
          gt(temporalEdges.tInvalid, asOf),
        ),
      ),
    )
    .orderBy(desc(temporalEdges.tValid));
  return rows.map(rowToEdge);
}

/**
 * Find active edges that match `(from, to, edgeKind)` — i.e. candidates
 * the caller may want to invalidate before inserting a new claim. Sorted
 * oldest-first because the most-likely candidate is the original claim
 * the new note is overriding.
 */
export async function findInvalidationCandidates(
  fromNoteId: string,
  toNoteId: string,
  edgeKind: EdgeKind,
): Promise<TemporalEdge[]> {
  const rows = await database()
    .select()
    .from(temporalEdges)
    .where(
      and(
        eq(temporalEdges.fromNoteId, fromNoteId),
        eq(temporalEdges.toNoteId, toNoteId),
        eq(temporalEdges.edgeKind, edgeKind),
        isNull(temporalEdges.tInvalid),
      ),
    )
    .orderBy(asc(temporalEdges.tValid));
  return rows.map(rowToEdge);
}

/**
 * Full history of one edge's lineage. Returns the row itself, then any
 * rows that share `(from, to, edgeKind)` ordered by `t_valid` ASC — the
 * chronological story of "what did this note claim about this target?".
 *
 * If `edgeId` is unknown the result is empty.
 */
export async function edgeHistory(edgeId: string): Promise<TemporalEdge[]> {
  const seed = await getRow(edgeId);
  if (!seed) return [];
  const rows = await database()
    .select()
    .from(temporalEdges)
    .where(
      and(
        eq(temporalEdges.fromNoteId, seed.fromNoteId),
        eq(temporalEdges.toNoteId, seed.toNoteId),
        eq(temporalEdges.edgeKind, seed.edgeKind),
      ),
    )
    .orderBy(asc(temporalEdges.tValid));
  return rows.map(rowToEdge);
}

/**
 * Bulk wikilink → temporal-edge synchroniser. Called fire-and-forget after a
 * successful note-save / create. For each `(noteId → target)` pair:
 *   - skip if an ACTIVE edge of kind="wikilink" already exists (dedupe);
 *   - else insert a new edge with `t_valid = noteUpdatedAt`.
 *
 * We deliberately do NOT auto-invalidate dropped wikilinks here: a wikilink
 * disappearing from a note body is not the same as the real-world fact
 * becoming false. The validation sleep-pass + explicit user action handle
 * invalidation. This keeps writes idempotent and safe to retry.
 */
export async function syncWikilinksToTemporalEdges(
  noteId: string,
  wikilinkTargets: string[],
  noteUpdatedAt: Date,
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  // Dedupe target list — `parseLinks` already returns unique values but
  // the contract here is "best-effort sync", so we double-check.
  const targets = [...new Set(wikilinkTargets.map((t) => t.trim()).filter(Boolean))];
  for (const target of targets) {
    if (target === noteId) continue; // self-link is not an edge
    const existing = await findInvalidationCandidates(
      noteId,
      target,
      "wikilink",
    );
    if (existing.length > 0) {
      skipped++;
      continue;
    }
    try {
      await createTemporalEdge({
        fromNoteId: noteId,
        toNoteId: target,
        edgeKind: "wikilink",
        tValid: noteUpdatedAt,
        sourceNoteId: noteId,
      });
      created++;
    } catch {
      // Best-effort — never throw out of the bulk path.
    }
  }
  return { created, skipped };
}

/**
 * Mark an active edge as `stale` in its metadata blob. Used by the
 * bi-temporal-validation sleep-pass to flag edges for review without
 * invalidating them (the user / a follow-up pass makes the final call).
 *
 * Implementation note: we merge into the existing JSONB rather than
 * overwriting, so other metadata keys survive. Postgres `||` does that on
 * jsonb objects.
 */
export async function markEdgeStale(
  edgeId: string,
  reason: string,
): Promise<void> {
  const payload = JSON.stringify({
    stale: true,
    staleReason: reason,
    staleAt: new Date().toISOString(),
  });
  await database()
    .update(temporalEdges)
    .set({
      metadata: sql`COALESCE(${temporalEdges.metadata}, '{}'::jsonb) || ${payload}::jsonb`,
    })
    .where(eq(temporalEdges.id, edgeId));
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

async function getRow(id: string): Promise<TemporalEdgeRow | null> {
  const rows = await database()
    .select()
    .from(temporalEdges)
    .where(eq(temporalEdges.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function rowToEdge(row: TemporalEdgeRow): TemporalEdge {
  const conf =
    row.confidence === null || row.confidence === ""
      ? null
      : Number.parseFloat(row.confidence);
  return {
    id: row.id,
    fromNoteId: row.fromNoteId,
    toNoteId: row.toNoteId,
    edgeKind: row.edgeKind as EdgeKind,
    tCreated: row.tCreated,
    tExpired: row.tExpired ?? null,
    tValid: row.tValid,
    tInvalid: row.tInvalid ?? null,
    sourceNoteId: row.sourceNoteId ?? null,
    invalidatedBy: row.invalidatedBy ?? null,
    factText: row.factText ?? null,
    confidence: conf !== null && Number.isFinite(conf) ? conf : null,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : null,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
