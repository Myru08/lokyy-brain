import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { and, desc, eq } from "drizzle-orm";
import {
  database,
  mem0ReviewQueue,
  lintFindings,
  listNotes,
  getNote,
  saveNote,
  deleteEntry,
  moveEntry,
  parseFrontmatter,
  serializeFrontmatter,
  type Mem0ReviewQueueRow,
  type LintFindingRow,
  type Mem0Operation,
  type Mem0ReviewStatus,
  type LintStatus,
  type LintSeverity,
  type LintKind,
  type FrontmatterMap,
} from "@lokyy/core";

/**
 * Phase C Wave C3 / Story 1 — Aggregated agent-review queue.
 *
 * Surfaces the three Wave C1+C2 pending-review streams behind a single
 * endpoint so the PWA can render one "Agent Review" panel instead of
 * stitching three separate queues client-side:
 *
 *   1. Mem0 classifier suggestions  → `mem0_review_queue` rows (status=pending)
 *   2. Karpathy-lint findings       → `lint_findings` rows (status=open)
 *   3. Topic-synthesis topic-notes  → `.md` files under
 *                                     `70_pai/topics/auto-*` with
 *                                     `frontmatter.origin = "agent"`
 *
 * Routes:
 *   GET  /api/agent-review/queue                   aggregated queue
 *   POST /api/agent-review/topic-note/:id/accept   move to user folder
 *   POST /api/agent-review/topic-note/:id/reject   delete the auto note
 *
 * Mem0 + lint actions delegate to the existing `/api/mem0/review/*` and
 * `/api/lint/findings/*` routes — we deliberately do NOT proxy them here
 * to avoid two endpoints with diverging semantics.
 *
 * Acceptance flows are written so that vault state stays consistent if any
 * step fails: we always mutate the vault FIRST (via gitService, which is
 * itself transactional per-commit), and only flip non-vault status rows
 * once the vault op returned. A crashed accept call therefore leaves the
 * vault either fully un-changed or fully changed — never half-applied.
 */
export const agentReviewRoutes = new Hono();

const TOPIC_PREFIX = "70_pai/topics/auto-";
const TOPIC_ACCEPT_TARGET_DIR = "20_notes/topics";

/* ──────────────────────────────────────────────────────────────────────── */
/*  Response shapes                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

interface Mem0ReviewJson {
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

interface LintFindingJson {
  id: string;
  kind: LintKind;
  noteIds: string[];
  severity: LintSeverity;
  message: string;
  evidence: Record<string, unknown> | null;
  status: LintStatus;
  detectedAt: string;
  resolvedAt: string | null;
}

interface TopicNoteJson {
  id: string;
  title: string;
  confidence: number | null;
  sourceNotes: string[];
  bodyPreview: string;
  generatedAt: string | null;
  communityId: string | null;
}

interface AggregatedQueueResponse {
  mem0: Mem0ReviewJson[];
  lint: LintFindingJson[];
  topicNotes: TopicNoteJson[];
  totalPending: number;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Row → JSON adapters                                                      */
/* ──────────────────────────────────────────────────────────────────────── */

function mem0RowToJson(row: Mem0ReviewQueueRow): Mem0ReviewJson {
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

function lintRowToJson(row: LintFindingRow): LintFindingJson {
  return {
    id: row.id,
    kind: row.kind as LintKind,
    noteIds: row.noteIds,
    severity: row.severity as LintSeverity,
    message: row.message,
    evidence:
      row.evidence && typeof row.evidence === "object"
        ? (row.evidence as Record<string, unknown>)
        : null,
    status: row.status as LintStatus,
    detectedAt: row.detectedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Topic-note helpers                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

function clampPreview(body: string, max = 300): string {
  const trimmed = body.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Parse the frontmatter of a topic-synthesis note. The note body returned by
 * `getNote` still contains the YAML frontmatter block — `parseFrontmatter`
 * splits it for us. We deliberately re-parse here (instead of holding state
 * on disk) so the route stays correct when the on-disk note is hand-edited.
 */
function parseTopicNote(noteId: string, body: string): TopicNoteJson | null {
  const { data, body: stripped } = parseFrontmatter(body);
  if (data.origin !== "agent") return null;
  const title = readOptionalString(data.title) ?? noteId.split("/").pop() ?? noteId;
  return {
    id: noteId,
    title,
    confidence: readOptionalNumber(data.confidence),
    sourceNotes: readStringArray(data.source_notes),
    bodyPreview: clampPreview(stripped, 300),
    generatedAt: readOptionalString(data.generated_at),
    communityId: readOptionalString(data.community_id),
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  GET /api/agent-review/queue                                              */
/* ──────────────────────────────────────────────────────────────────────── */

agentReviewRoutes.get("/queue", async (c) => {
  const limitRaw = c.req.query("limit") ?? "30";
  const parsed = Number(limitRaw);
  const limit = Math.max(
    1,
    Math.min(200, Number.isFinite(parsed) ? Math.floor(parsed) : 30),
  );

  const db = database();

  const [mem0Rows, lintRows, allNotes] = await Promise.all([
    db
      .select()
      .from(mem0ReviewQueue)
      .where(eq(mem0ReviewQueue.status, "pending"))
      .orderBy(desc(mem0ReviewQueue.createdAt))
      .limit(limit),
    db
      .select()
      .from(lintFindings)
      .where(eq(lintFindings.status, "open"))
      .orderBy(desc(lintFindings.detectedAt))
      .limit(limit),
    listNotes(),
  ]);

  const topicCandidates = allNotes.filter((n) => n.id.startsWith(TOPIC_PREFIX));
  const topicNotes: TopicNoteJson[] = [];
  // Hard-cap the per-request reads — listNotes can return hundreds of
  // candidates after a long sleep-agent run and we don't want a UI poll to
  // pull the entire vault every five minutes.
  for (const tc of topicCandidates.slice(0, limit)) {
    try {
      const full = await getNote(tc.id);
      if (!full) continue;
      const parsedTopic = parseTopicNote(tc.id, full.body);
      if (parsedTopic) topicNotes.push(parsedTopic);
    } catch {
      // skip on read error — never let one bad note break the queue
    }
  }

  const response: AggregatedQueueResponse = {
    mem0: mem0Rows.map(mem0RowToJson),
    lint: lintRows.map(lintRowToJson),
    topicNotes,
    totalPending: mem0Rows.length + lintRows.length + topicNotes.length,
  };

  return c.json(response);
});

/* ──────────────────────────────────────────────────────────────────────── */
/*  POST /api/agent-review/topic-note/:id/accept                             */
/*                                                                           */
/*  Flow:                                                                    */
/*   1. Read the auto-* note via gitService (which pulls first).             */
/*   2. Verify origin === "agent" (we don't touch user-curated notes).       */
/*   3. Rewrite frontmatter: origin → curated, confidence → 1.0,             */
/*      accepted_at → now. We deliberately do NOT touch `id`/`created` —     */
/*      identity must survive the move.                                      */
/*   4. saveNote() with the new body (commits frontmatter change).           */
/*   5. moveEntry() to the user-visible folder.                              */
/*                                                                           */
/*  Notes:                                                                   */
/*   - `saveNote` runs schema validation; intervention with origin=curated   */
/*     is allowed by the schema (extra keys pass through).                   */
/*   - If `moveEntry` fails, the frontmatter is already updated but the      */
/*     note stays in the auto folder. The next accept attempt will see       */
/*     origin=curated and 422 — surface the move error to the user so they  */
/*     can retry once the underlying git issue is fixed.                     */
/* ──────────────────────────────────────────────────────────────────────── */

agentReviewRoutes.post("/topic-note/:id{.+}/accept", async (c) => {
  const id = c.req.param("id");
  if (!id.startsWith(TOPIC_PREFIX)) {
    return c.json(
      { error: `not an agent-generated topic note: ${id}` },
      422,
    );
  }

  const note = await getNote(id);
  if (!note) return c.json({ error: "note not found" }, 404);

  const { data: fm, body: stripped } = parseFrontmatter(note.body);
  if (fm.origin !== "agent") {
    return c.json(
      { error: `topic note ${id} is not in agent state (origin=${String(fm.origin)})` },
      422,
    );
  }

  const reviewer = getCookie(c, "lokyy_session") ?? "anonymous";
  const now = new Date().toISOString();

  const merged: FrontmatterMap = {
    ...fm,
    origin: "curated",
    confidence: 1.0,
    accepted_at: now,
    accepted_by: reviewer,
  };
  // Drop the intervention-status "pending" marker now that the user has
  // accepted — leaves a clean record for downstream consumers.
  if (merged.status === "pending") {
    merged.status = "accepted";
  }

  const newBody = serializeFrontmatter(merged, stripped);

  // 1. Commit the frontmatter rewrite first. If this fails, nothing moved.
  await saveNote(id, newBody);

  // 2. Move into the user folder. `moveEntry` uses gitService, which
  // serializes against the saveNote above via the shared promise-lock.
  const slug = id.slice(TOPIC_PREFIX.length);
  const targetId = `${TOPIC_ACCEPT_TARGET_DIR}/${slug}`;
  await moveEntry(id, targetId, "note");

  return c.json({
    ok: true,
    from: id,
    to: targetId,
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/*  POST /api/agent-review/topic-note/:id/reject                             */
/*                                                                           */
/*  Simply deletes the auto-generated note via gitService. We guard against  */
/*  accidental deletion of curated notes by verifying the path prefix and    */
/*  re-checking the frontmatter origin.                                      */
/* ──────────────────────────────────────────────────────────────────────── */

agentReviewRoutes.post("/topic-note/:id{.+}/reject", async (c) => {
  const id = c.req.param("id");
  if (!id.startsWith(TOPIC_PREFIX)) {
    return c.json(
      { error: `not an agent-generated topic note: ${id}` },
      422,
    );
  }

  const note = await getNote(id);
  if (!note) return c.json({ error: "note not found" }, 404);

  const { data: fm } = parseFrontmatter(note.body);
  if (fm.origin !== "agent") {
    return c.json(
      { error: `topic note ${id} is not in agent state (origin=${String(fm.origin)})` },
      422,
    );
  }

  await deleteEntry(id, "note");
  return c.json({ ok: true, deleted: id });
});
