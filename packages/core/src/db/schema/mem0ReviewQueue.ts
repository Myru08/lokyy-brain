import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Phase C Wave C1 / Story 1 — Mem0 ADD/UPDATE/DELETE/NOOP classifier
 * (arXiv:2504.19413, ECAI 2025) adapted as a REM-sleep review queue.
 *
 * Each row represents one classifier decision for a freshly-captured note.
 * The classifier never auto-applies — every row starts as `pending` and
 * requires explicit user acceptance (`status = "accepted" | "rejected"`).
 * Once accepted, the operation is applied and the row flips to `applied`.
 *
 * Operation semantics (mirroring the Mem0 paper):
 *   - ADD    → candidate is genuinely new; on accept, no-op on existing
 *              notes (the capture stays as-is).
 *   - UPDATE → candidate refines an existing memory; on accept, the
 *              target note's body is replaced with `payload.proposedBody`.
 *   - DELETE → candidate makes an existing memory obsolete; on accept,
 *              `targetNoteId` is removed from the vault.
 *   - NOOP   → candidate is redundant noise; on accept, the capture
 *              itself is deleted (skip recorded but no further action).
 *
 * Indexes:
 *   - `idx_mem0_review_status` — listing the pending review queue is the
 *     dominant access pattern; the index keeps that path O(log n).
 */
export const mem0ReviewQueue = pgTable(
  "mem0_review_queue",
  {
    /** ULID, generated before insert. */
    id: text("id").primaryKey(),
    /** path-id of the source-capture note that produced this decision. */
    noteId: text("note_id").notNull(),
    /** "ADD" | "UPDATE" | "DELETE" | "NOOP" — enforced in TS. */
    operation: text("operation").notNull(),
    /** path-id of the affected note for UPDATE / DELETE. Null otherwise. */
    targetNoteId: text("target_note_id"),
    /** "0".."1" — stringified to avoid Postgres numeric coercion issues. */
    confidence: text("confidence").notNull(),
    /** Human-readable rationale emitted by the classifier. */
    reasoning: text("reasoning").notNull(),
    /** Proposed body for UPDATE / ADD-refinement, or arbitrary extras. */
    payload: jsonb("payload"),
    /** "pending" | "accepted" | "rejected" | "applied". */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when the user accepts/rejects. */
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** Identifier of the human who reviewed (session id, email, …). */
    reviewedBy: text("reviewed_by"),
  },
  (table) => ({
    statusIdx: index("idx_mem0_review_status").on(table.status),
  }),
);

export type Mem0ReviewQueueRow = typeof mem0ReviewQueue.$inferSelect;
export type NewMem0ReviewQueueRow = typeof mem0ReviewQueue.$inferInsert;

/** Operations the classifier may return. */
export const MEM0_OPERATIONS = ["ADD", "UPDATE", "DELETE", "NOOP"] as const;
export type Mem0Operation = (typeof MEM0_OPERATIONS)[number];

/** Lifecycle statuses for a review-queue row. */
export const MEM0_REVIEW_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "applied",
] as const;
export type Mem0ReviewStatus = (typeof MEM0_REVIEW_STATUSES)[number];

export function isMem0Operation(value: string): value is Mem0Operation {
  return (MEM0_OPERATIONS as readonly string[]).includes(value);
}

export function isMem0ReviewStatus(value: string): value is Mem0ReviewStatus {
  return (MEM0_REVIEW_STATUSES as readonly string[]).includes(value);
}
