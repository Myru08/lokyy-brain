import {
  pgTable,
  text,
  doublePrecision,
  integer,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Phase C Wave C1 / Story 4 — Synaptic-Pruning sidecar table.
 *
 * Tononi & Cirelli's Synaptic Homeostasis Hypothesis (2003, 2014, 2020): NREM
 * sleep down-selects synaptic strength — strong/useful connections persist,
 * weak/noisy ones are pruned. Translated to lokyy-brain: each row tracks the
 * "synaptic strength" of one wikilink edge over time. The sleep-agent NREM
 * `synaptic-pruning` pass recomputes `weight`, demotes weak edges
 * (`demotion_count++`), and after `PRUNE_AFTER_DEMOTIONS` consecutive
 * demotions flips `pruned = 1` (graveyard).
 *
 * Why a sidecar instead of editing the .md bodies?
 *   - The vault is the source of truth — pruning is a *retrieval-time*
 *     concern (weight the edge down or filter it from active traversal),
 *     not a *content* concern. We never rewrite user notes.
 *   - Resurrection: a graveyard'd edge can be revived (`pruned = 0`,
 *     `demotion_count = 0`) without touching git.
 *
 * Keyed by `(from_note_id, to_note_id)` — directed, matches `graphService.buildGraph()`.
 * IDs are the path-style note ids that `GraphEdge.source` / `target` produce.
 *
 * Indexes:
 *   - `pruned` partial → fast graveyard listings (most rows will have pruned=0)
 *   - `from_note_id`   → "all edges out of X" (retrieval-time weight lookup)
 */
export const edgeWeights = pgTable(
  "edge_weights",
  {
    fromNoteId: text("from_note_id").notNull(),
    toNoteId: text("to_note_id").notNull(),
    /** Current composite strength [0..1] — recomputed every NREM run. */
    weight: doublePrecision("weight").notNull().default(1.0),
    /** Times this pair was co-retrieved in the trailing window (last recompute). */
    coRetrievalCount: integer("co_retrieval_count").notNull().default(0),
    /** Consecutive demotions — reset to 0 once the edge strengthens above threshold. */
    demotionCount: integer("demotion_count").notNull().default(0),
    /** Wall-clock of the most recent demotion — used by the cooldown guard. */
    lastDemotedAt: timestamp("last_demoted_at", { withTimezone: true }),
    /** 1 = graveyard (filtered from active graph), 0 = active. */
    pruned: integer("pruned").notNull().default(0),
    lastUpdated: timestamp("last_updated", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fromNoteId, t.toNoteId] }),
    fromIdx: index("idx_edge_weights_from").on(t.fromNoteId),
    prunedIdx: index("idx_edge_weights_pruned").on(t.pruned),
  }),
);

export type EdgeWeight = typeof edgeWeights.$inferSelect;
export type NewEdgeWeight = typeof edgeWeights.$inferInsert;
