import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import { database } from "../db/index.js";
import { retrievalTraces } from "../db/schema/retrievalTraces.js";
import { generateUlid } from "../frontmatter/index.js";
import { touchView } from "./store.js";

/**
 * Phase A Wave A1 / Story 3 — Retrieval-Trace-Log helpers.
 *
 * Multiple-Trace-Theory (Nadel & Moscovitch 1997): every retrieval is a
 * write-event. The functions here append one row per access to the
 * `retrieval_traces` sidecar and offer the read-side aggregations the
 * future sleep-agent + recency-reset loop will consume.
 *
 * Contract:
 *   - `logRetrieval` is fire-and-forget — errors are swallowed and logged,
 *     never re-thrown. Callers MAY use `void logRetrieval(...)` without a
 *     try/catch.
 *   - Side-effect: `logRetrieval` also bumps `note_scoring.view_count` +
 *     `last_accessed` via `touchView` so the importance score loop sees the
 *     event. That call is independently error-isolated — a touchView failure
 *     does not prevent the trace row from being inserted, and vice versa.
 */

/** Closed list of where a retrieval came from. */
export type RetrievalSource =
  | "search"
  | "wikilink"
  | "cmd-k"
  | "cmd-o"
  | "hover"
  | "embed"
  | "api"
  | "mcp";

export const RETRIEVAL_SOURCES: ReadonlyArray<RetrievalSource> = [
  "search",
  "wikilink",
  "cmd-k",
  "cmd-o",
  "hover",
  "embed",
  "api",
  "mcp",
];

export function isRetrievalSource(value: unknown): value is RetrievalSource {
  return (
    typeof value === "string" &&
    (RETRIEVAL_SOURCES as ReadonlyArray<string>).includes(value)
  );
}

/** One retrieval event — the input to `logRetrieval`. */
export interface RetrievalEvent {
  noteId: string;
  source: RetrievalSource;
  sessionId?: string;
  userId?: string;
  query?: string;
  /** Prior notes opened in the same session (cap ~5; callers truncate). */
  preceding?: string[];
  /** Free-form extensible bag, persisted as jsonb. */
  context?: Record<string, unknown>;
}

/** One row read back from `retrieval_traces`. */
export interface RetrievalTraceRow {
  id: string;
  noteId: string;
  accessedAt: Date;
  sessionId: string | null;
  userId: string | null;
  source: RetrievalSource;
  query: string | null;
  preceding: string[] | null;
  context: Record<string, unknown> | null;
}

/** Hard cap on the `preceding` array — defensive, callers also truncate. */
const PRECEDING_CAP = 5;

/**
 * Append one retrieval-trace row. Fire-and-forget — errors do NOT propagate.
 *
 * Side effect: bumps `note_scoring.view_count` + `last_accessed` via
 * `touchView`. That call is independently error-isolated so a touchView
 * failure does not lose the trace, and vice versa.
 */
export async function logRetrieval(event: RetrievalEvent): Promise<void> {
  // Defensive: callers may forget to truncate preceding.
  const preceding =
    event.preceding && event.preceding.length > PRECEDING_CAP
      ? event.preceding.slice(-PRECEDING_CAP)
      : event.preceding;

  try {
    const db = database();
    await db.insert(retrievalTraces).values({
      id: generateUlid(),
      noteId: event.noteId,
      sessionId: event.sessionId ?? null,
      userId: event.userId ?? null,
      source: event.source,
      query: event.query ?? null,
      preceding: preceding ?? null,
      context: event.context ?? null,
    });
  } catch (err) {
    console.warn(
      `[retrievalLog] insert failed for note ${event.noteId} (source=${event.source}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Recency / view-count side effect. Isolated try/catch — touchView depends
  // on `note_scoring`, which may not exist yet for brand-new notes (it does
  // an upsert), but DB-level failures must still not surface to the caller.
  try {
    await touchView(event.noteId);
  } catch (err) {
    console.warn(
      `[retrievalLog] touchView failed for note ${event.noteId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Query options for `queryTraces`. */
export interface TraceQueryOpts {
  noteId?: string;
  sessionId?: string;
  since?: Date;
  /** Default 100, hard cap 1000. */
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Read raw trace rows, newest first. All filters are AND-combined; an
 * `opts` with no filters returns the most recent `limit` rows.
 */
export async function queryTraces(
  opts: TraceQueryOpts = {},
): Promise<RetrievalTraceRow[]> {
  const db = database();
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const filters = [];
  if (opts.noteId) filters.push(eq(retrievalTraces.noteId, opts.noteId));
  if (opts.sessionId)
    filters.push(eq(retrievalTraces.sessionId, opts.sessionId));
  if (opts.since) filters.push(gte(retrievalTraces.accessedAt, opts.since));

  const rows = await db
    .select()
    .from(retrievalTraces)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(retrievalTraces.accessedAt))
    .limit(limit);

  return rows.map(rowToTrace);
}

/**
 * Aggregate: how often was each note retrieved within the last N days?
 * Returns rows sorted by count desc. Caller decides what to do with the
 * tail.
 */
export async function retrievalCounts(
  sinceDays: number,
): Promise<Array<{ noteId: string; count: number }>> {
  const db = database();
  const since = daysAgo(sinceDays);

  const rows = await db
    .select({
      noteId: retrievalTraces.noteId,
      count: count(retrievalTraces.id),
    })
    .from(retrievalTraces)
    .where(gte(retrievalTraces.accessedAt, since))
    .groupBy(retrievalTraces.noteId)
    .orderBy(desc(count(retrievalTraces.id)));

  return rows.map((r) => ({ noteId: r.noteId, count: Number(r.count) }));
}

/**
 * Aggregate: which unordered note-pairs were retrieved in the same session
 * within the last N days?
 *
 * Implementation: self-join `retrieval_traces` on `session_id`, where
 * `note_id_a < note_id_b` (canonical ordering keeps each pair once).
 * Filters out rows without a session (they can't co-occur by definition).
 */
export async function coRetrievalPairs(
  sinceDays: number,
  minCount = 2,
): Promise<Array<{ noteIdA: string; noteIdB: string; count: number }>> {
  const db = database();
  // ISO string, NOT a Date: raw `db.execute(sql`…`)` goes out through
  // `postgres.unsafe(query, params)`, which writes bind parameters without
  // the Date→timestamp serialization that typed columns get from Drizzle's
  // `mapToDriverValue()`. A Date here reaches `Buffer.byteLength()` raw and
  // throws `The "string" argument must be of type string or an instance of
  // Buffer or ArrayBuffer. Received an instance of Date` — which killed the
  // whole synaptic-pruning pass on every run. Postgres casts the string.
  const since = daysAgo(sinceDays).toISOString();

  // Raw SQL — the canonical-order self-join is awkward to express in
  // Drizzle's relational builder. We still rely on the index on
  // `(session_id) WHERE session_id IS NOT NULL` to keep it tractable.
  const result = await db.execute<{
    note_id_a: string;
    note_id_b: string;
    count: string | number;
  }>(sql`
    SELECT
      a.note_id AS note_id_a,
      b.note_id AS note_id_b,
      COUNT(*)::int AS count
    FROM ${retrievalTraces} a
    INNER JOIN ${retrievalTraces} b
      ON a.session_id = b.session_id
     AND a.note_id < b.note_id
    WHERE a.session_id IS NOT NULL
      AND a.accessed_at >= ${since}
      AND b.accessed_at >= ${since}
    GROUP BY a.note_id, b.note_id
    HAVING COUNT(*) >= ${minCount}
    ORDER BY count DESC
  `);

  // postgres-js returns rows on the result itself (array-like).
  const rows = result as unknown as Array<{
    note_id_a: string;
    note_id_b: string;
    count: string | number;
  }>;
  return rows.map((r) => ({
    noteIdA: r.note_id_a,
    noteIdB: r.note_id_b,
    count: Number(r.count),
  }));
}

// ─── internals ───────────────────────────────────────────────────────────

function daysAgo(days: number): Date {
  return new Date(Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000);
}

function rowToTrace(row: {
  id: string;
  noteId: string;
  accessedAt: Date;
  sessionId: string | null;
  userId: string | null;
  source: string;
  query: string | null;
  preceding: string[] | null;
  context: unknown;
}): RetrievalTraceRow {
  return {
    id: row.id,
    noteId: row.noteId,
    accessedAt: row.accessedAt,
    sessionId: row.sessionId,
    userId: row.userId,
    // SOURCES are not enforced at the DB layer — narrow defensively. Unknown
    // values are passed through as-is via the cast; downstream code should
    // treat the field as opaque if it doesn't match the closed list.
    source: row.source as RetrievalSource,
    query: row.query,
    preceding: row.preceding,
    context:
      row.context && typeof row.context === "object"
        ? (row.context as Record<string, unknown>)
        : null,
  };
}

