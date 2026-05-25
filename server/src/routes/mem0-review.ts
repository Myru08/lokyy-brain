import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, desc, eq } from "drizzle-orm";
import {
  database,
  mem0ReviewQueue,
  isMem0ReviewStatus,
  type Mem0ReviewQueueRow,
  type Mem0ReviewStatus,
  type Mem0Operation,
  deleteEntry,
  getNote,
  saveNote,
} from "@lokyy/core";

/**
 * Phase C Wave C1 / Story 1 — Mem0 review-queue HTTP surface.
 *
 *   GET    /api/mem0/review[?status=…&limit=N]   list rows, newest first
 *   GET    /api/mem0/review/:id                  fetch one row
 *   POST   /api/mem0/review/:id/accept           apply the operation
 *   POST   /api/mem0/review/:id/reject           drop the operation
 *
 * Accept semantics by operation:
 *   - ADD     → no vault mutation (the capture already exists); the row
 *               flips status `pending → applied` purely as audit log.
 *   - UPDATE  → rewrite `payload.proposedBody` into the target note. If
 *               `proposedBody` is missing or `targetNoteId` is unknown,
 *               we 422 instead of doing something destructive.
 *   - DELETE  → remove the target note from the vault (git commit + push).
 *   - NOOP    → delete the *source capture* (the classifier judged it noise).
 *
 * Reject always just flips the row status to `rejected` — vault is untouched.
 *
 * Idempotency: applying twice is a 409. We never overwrite a non-pending
 * row's `reviewedAt` / `reviewedBy`; that would corrupt the audit trail.
 */
export const mem0ReviewRoutes = new Hono();

interface ReviewRowJson {
  id: string;
  noteId: string;
  operation: Mem0Operation;
  targetNoteId: string | null;
  confidence: number;
  reasoning: string;
  payload: Record<string, unknown> | null;
  status: Mem0ReviewStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

function rowToJson(row: Mem0ReviewQueueRow): ReviewRowJson {
  const confidence = Number(row.confidence);
  return {
    id: row.id,
    noteId: row.noteId,
    operation: row.operation as Mem0Operation,
    targetNoteId: row.targetNoteId,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reasoning: row.reasoning,
    payload:
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : null,
    status: row.status as Mem0ReviewStatus,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewedBy: row.reviewedBy,
  };
}

mem0ReviewRoutes.get("/", async (c) => {
  const rawStatus = c.req.query("status");
  const rawLimit = c.req.query("limit") ?? "100";
  const parsedLimit = Number(rawLimit);
  const limit = Math.max(
    1,
    Math.min(500, Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 100),
  );

  const db = database();
  const rows = rawStatus && isMem0ReviewStatus(rawStatus)
    ? await db
        .select()
        .from(mem0ReviewQueue)
        .where(eq(mem0ReviewQueue.status, rawStatus))
        .orderBy(desc(mem0ReviewQueue.createdAt))
        .limit(limit)
    : await db
        .select()
        .from(mem0ReviewQueue)
        .orderBy(desc(mem0ReviewQueue.createdAt))
        .limit(limit);

  return c.json({ rows: rows.map(rowToJson) });
});

mem0ReviewRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const rows = await database()
    .select()
    .from(mem0ReviewQueue)
    .where(eq(mem0ReviewQueue.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(rowToJson(row));
});

mem0ReviewRoutes.post("/:id/accept", async (c) => {
  const id = c.req.param("id");
  const reviewer = getCookie(c, "lokyy_session") ?? "anonymous";
  const db = database();

  const rows = await db
    .select()
    .from(mem0ReviewQueue)
    .where(eq(mem0ReviewQueue.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "pending") {
    return c.json(
      { error: `cannot accept row with status=${row.status}` },
      409,
    );
  }

  const op = row.operation as Mem0Operation;
  try {
    if (op === "UPDATE") {
      const target = row.targetNoteId;
      const payload =
        row.payload && typeof row.payload === "object"
          ? (row.payload as Record<string, unknown>)
          : null;
      const proposed = payload?.proposedBody;
      if (!target || typeof proposed !== "string") {
        return c.json(
          { error: "UPDATE requires targetNoteId and payload.proposedBody" },
          422,
        );
      }
      // Ensure the target still exists before we try to rewrite it.
      const existing = await getNote(target);
      if (!existing) {
        return c.json({ error: `target note "${target}" not found` }, 404);
      }
      await saveNote(target, proposed);
    } else if (op === "DELETE") {
      const target = row.targetNoteId;
      if (!target) {
        return c.json({ error: "DELETE requires targetNoteId" }, 422);
      }
      const existing = await getNote(target);
      // If it's already gone, treat the accept as a no-op rather than 404 —
      // the user's intent ("yes, remove it") is satisfied either way.
      if (existing) {
        await deleteEntry(target, "note");
      }
    } else if (op === "NOOP") {
      // Mem0 NOOP = the capture itself is noise. Drop the source note.
      const source = await getNote(row.noteId);
      if (source) {
        await deleteEntry(row.noteId, "note");
      }
    }
    // ADD → no vault mutation; the row is just audit.

    await db
      .update(mem0ReviewQueue)
      .set({
        status: "applied",
        reviewedAt: new Date(),
        reviewedBy: reviewer,
      })
      .where(
        and(
          eq(mem0ReviewQueue.id, id),
          eq(mem0ReviewQueue.status, "pending"),
        ),
      );

    const updated = await db
      .select()
      .from(mem0ReviewQueue)
      .where(eq(mem0ReviewQueue.id, id))
      .limit(1);
    return c.json(rowToJson(updated[0]!));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

mem0ReviewRoutes.post("/:id/reject", async (c) => {
  const id = c.req.param("id");
  const reviewer = getCookie(c, "lokyy_session") ?? "anonymous";
  const db = database();

  const rows = await db
    .select()
    .from(mem0ReviewQueue)
    .where(eq(mem0ReviewQueue.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "pending") {
    return c.json(
      { error: `cannot reject row with status=${row.status}` },
      409,
    );
  }

  await db
    .update(mem0ReviewQueue)
    .set({
      status: "rejected",
      reviewedAt: new Date(),
      reviewedBy: reviewer,
    })
    .where(
      and(
        eq(mem0ReviewQueue.id, id),
        eq(mem0ReviewQueue.status, "pending"),
      ),
    );

  const updated = await db
    .select()
    .from(mem0ReviewQueue)
    .where(eq(mem0ReviewQueue.id, id))
    .limit(1);
  return c.json(rowToJson(updated[0]!));
});
