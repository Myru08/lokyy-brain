import { and, desc, eq } from "drizzle-orm";

import { database } from "../db/index.js";
import { edgeWeights, type EdgeWeight } from "../db/schema/edgeWeights.js";

/**
 * Phase C Wave C1 / Story 4 — Edge-Weights read/write surface.
 *
 * Used by:
 *   - Retrieval (PPR / graph traversal): consult `getActiveEdgeWeight` to
 *     either weight an edge down or skip pruned ones entirely.
 *   - HTTP `/api/edges/*`: graveyard inspection + manual resurrection.
 *   - Tests: round-trip the table without going through the sleep pass.
 *
 * The synaptic-pruning sleep pass is the only writer that *grows* this
 * table on its own (one row per active wikilink edge). `resurrectEdge` is
 * a targeted user-intervention writer — flips `pruned=0` + `demotionCount=0`
 * + clears `lastDemotedAt`. It does not delete rows.
 */

/** One graveyard row as returned to the HTTP layer. */
export interface PrunedEdge {
  fromNoteId: string;
  toNoteId: string;
  weight: number;
  coRetrievalCount: number;
  demotionCount: number;
  lastDemotedAt: Date | null;
  lastUpdated: Date;
}

/** One row (any state) — used by `/api/edges/weights?noteId=`. */
export interface EdgeWeightRow extends PrunedEdge {
  pruned: number;
}

/**
 * Active weight for a directed edge, or `null` if no row exists yet
 * (treat as "not yet tracked — fall back to default 1.0 at the call site").
 *
 * If the edge is pruned (graveyard), returns `0` — explicit zero so callers
 * can safely multiply / sum without a separate is-pruned branch.
 */
export async function getActiveEdgeWeight(
  from: string,
  to: string,
): Promise<number | null> {
  const rows = await database()
    .select()
    .from(edgeWeights)
    .where(and(eq(edgeWeights.fromNoteId, from), eq(edgeWeights.toNoteId, to)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.pruned === 1) return 0;
  return row.weight;
}

/** Newest-graveyard-first listing — for the admin / inspection UI. */
export async function listPrunedEdges(limit = 100): Promise<PrunedEdge[]> {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const rows = await database()
    .select()
    .from(edgeWeights)
    .where(eq(edgeWeights.pruned, 1))
    .orderBy(desc(edgeWeights.lastDemotedAt))
    .limit(safeLimit);
  return rows.map(rowToPruned);
}

/** All tracked outbound edges for one note (any state). */
export async function listEdgesForNote(
  noteId: string,
): Promise<EdgeWeightRow[]> {
  const rows = await database()
    .select()
    .from(edgeWeights)
    .where(eq(edgeWeights.fromNoteId, noteId))
    .orderBy(desc(edgeWeights.weight));
  return rows.map((r) => ({ ...rowToPruned(r), pruned: r.pruned }));
}

/**
 * User-intervention: revive a graveyard edge. Resets `demotionCount = 0`,
 * `pruned = 0`, clears `lastDemotedAt`. The next NREM run recomputes the
 * weight from current signals.
 *
 * Returns `true` if a row existed and was updated, `false` if no such edge
 * is tracked (callers should treat that as a no-op rather than an error).
 */
export async function resurrectEdge(
  from: string,
  to: string,
): Promise<boolean> {
  const db = database();
  const existing = await db
    .select()
    .from(edgeWeights)
    .where(and(eq(edgeWeights.fromNoteId, from), eq(edgeWeights.toNoteId, to)))
    .limit(1);
  if (existing.length === 0) return false;
  await db
    .update(edgeWeights)
    .set({
      demotionCount: 0,
      pruned: 0,
      lastDemotedAt: null,
      lastUpdated: new Date(),
    })
    .where(and(eq(edgeWeights.fromNoteId, from), eq(edgeWeights.toNoteId, to)));
  return true;
}

function rowToPruned(row: EdgeWeight): PrunedEdge {
  return {
    fromNoteId: row.fromNoteId,
    toNoteId: row.toNoteId,
    weight: row.weight,
    coRetrievalCount: row.coRetrievalCount,
    demotionCount: row.demotionCount,
    lastDemotedAt: row.lastDemotedAt ?? null,
    lastUpdated: row.lastUpdated,
  };
}
