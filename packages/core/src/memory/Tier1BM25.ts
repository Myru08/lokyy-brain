import { sql } from "drizzle-orm";
import { database } from "../db/index.js";

/**
 * Tier1BM25 — ParadeDB `pg_search` BM25 retrieval over the `note_search`
 * table (Phase A Wave A1 / Story 2).
 *
 * Runs ALONGSIDE the in-memory `Tier1Provider`, which stays in place for
 * compatibility. `Tier1BM25` is the DB-indexed path used by the hybrid
 * retrieval CTE (`./hybrid.ts`) and the new `/api/search/hybrid` route.
 *
 * Graceful degradation: every public method probes `pg_extension` for
 * `pg_search` and, if missing, returns an empty result set (search) or
 * a no-op write (upsert/remove → the table is still maintained, only the
 * BM25 index is unavailable; search degrades to a LIKE-based scoring
 * fallback). The migration 0004 logs a NOTICE when the extension is
 * absent.
 */

export interface BM25Hit {
  noteId: string;
  title: string;
  /** BM25 score from `paradedb.score(note_id)`. Higher is better. */
  score: number;
  /** Up to ~160 chars of body context around the matched term. */
  snippet?: string;
}

/** Cache the pg_search-availability probe — checked once per process. */
let pgSearchAvailable: boolean | null = null;

async function isPgSearchAvailable(): Promise<boolean> {
  if (pgSearchAvailable !== null) return pgSearchAvailable;
  try {
    const rows = (await database().execute(
      sql`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_search') AS has_ext`,
    )) as unknown as { has_ext: boolean }[];
    pgSearchAvailable = rows[0]?.has_ext === true;
  } catch {
    pgSearchAvailable = false;
  }
  return pgSearchAvailable;
}

function trimSnippet(body: string, query: string, span = 160): string | undefined {
  if (!query) return undefined;
  const tokens = query
    .toLowerCase()
    .split(/[\s,;:!?]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return undefined;
  const lower = body.toLowerCase();
  let hit = -1;
  for (const tok of tokens) {
    const i = lower.indexOf(tok);
    if (i >= 0) {
      hit = i;
      break;
    }
  }
  if (hit < 0) return undefined;
  const start = Math.max(0, hit - span / 2);
  const end = Math.min(body.length, hit + span / 2);
  return (start > 0 ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
}

export class Tier1BM25 {
  /** Upsert a note into `note_search`. Always writes (table is the source
   *  of truth for the BM25 index); the BM25 index itself is only updated
   *  if the extension is installed.
   *
   *  `forgotten` (Phase C Wave C3 / Story 2) maps the frontmatter
   *  `forgotten:` field into the column the search-layer WHERE-clauses
   *  filter against. Default `false` — caller derives the value via
   *  `isForgotten(frontmatter)` so the boolean | ISO-string variants both
   *  resolve to the same boolean here. */
  async upsert(
    noteId: string,
    vaultId: string,
    title: string,
    body: string,
    tags: string[],
    forgotten = false,
  ): Promise<void> {
    await database().execute(sql`
      INSERT INTO note_search (note_id, vault_id, title, body, tags, forgotten, updated_at)
      VALUES (${noteId}, ${vaultId}, ${title}, ${body}, ${tags as unknown as string}::text[], ${forgotten}, NOW())
      ON CONFLICT (note_id) DO UPDATE
        SET vault_id   = EXCLUDED.vault_id,
            title      = EXCLUDED.title,
            body       = EXCLUDED.body,
            tags       = EXCLUDED.tags,
            forgotten  = EXCLUDED.forgotten,
            updated_at = NOW()
    `);
  }

  /** Remove a note from `note_search`. */
  async remove(noteId: string): Promise<void> {
    await database().execute(sql`DELETE FROM note_search WHERE note_id = ${noteId}`);
  }

  /**
   * Toggle the `forgotten` flag for an existing note_search row
   * (Phase C Wave C3 / Story 2). Returns `true` if a row was actually
   * updated, `false` if the row is missing — the caller can then decide
   * whether to fall back to a full `upsert` (e.g. a forget() arriving
   * before the first BM25 index refresh completed).
   */
  async setForgotten(noteId: string, forgotten: boolean): Promise<boolean> {
    const rows = (await database().execute(sql`
      UPDATE note_search
         SET forgotten = ${forgotten},
             updated_at = NOW()
       WHERE note_id = ${noteId}
       RETURNING note_id
    `)) as unknown as { note_id: string }[];
    return rows.length > 0;
  }

  /**
   * BM25 search. Returns up to `topK` hits ordered by score DESC.
   *
   * When `pg_search` is available, uses ParadeDB's `@@@` match operator and
   * `paradedb.score(note_id)` for ranking. Otherwise degrades to a LIKE-based
   * scan (case-insensitive substring match with a primitive score) so the
   * route still returns sensible structural hits.
   */
  async search(
    query: string,
    topK = 50,
    vaultId?: string,
  ): Promise<BM25Hit[]> {
    if (!query.trim()) return [];

    const hasExt = await isPgSearchAvailable();
    const db = database();

    if (hasExt) {
      // ParadeDB pg_search path. `note_id @@@ $query` runs the query against
      // every BM25-indexed field on the row (title + body + tags) and
      // `paradedb.score(note_id)` returns the BM25 rank score.
      //
      // Phase C Wave C3 / Story 2 — Cognee `forget()` primitive: exclude
      // rows with `forgotten = true` so the user-marked notes never reach
      // active retrieval. The note stays on disk; only the index hides it.
      const vaultClause = vaultId ? sql`AND vault_id = ${vaultId}` : sql``;
      const rows = (await db.execute(sql`
        SELECT note_id, title, body, paradedb.score(note_id) AS score
        FROM note_search
        WHERE note_id @@@ ${query}
          AND forgotten = FALSE
          ${vaultClause}
        ORDER BY score DESC
        LIMIT ${topK}
      `)) as unknown as { note_id: string; title: string; body: string; score: number }[];
      return rows.map((r) => ({
        noteId: r.note_id,
        title: r.title,
        score: Number(r.score),
        snippet: trimSnippet(r.body, query),
      }));
    }

    // Fallback — pg_search not installed. Naive scoring: title-hit +5,
    // body-hit +1 per token. Good enough for staging environments still
    // running on plain pgvector/pgvector:pg16. Same forgotten-filter as
    // the pg_search path so search semantics stay consistent.
    const tokens = [
      ...new Set(
        query
          .toLowerCase()
          .split(/[\s,;:!?]+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2),
      ),
    ].slice(0, 10);
    if (tokens.length === 0) return [];
    const ilikePattern = `%${tokens[0]}%`;
    const vaultClause = vaultId ? sql`AND vault_id = ${vaultId}` : sql``;
    const rows = (await db.execute(sql`
      SELECT note_id, title, body
      FROM note_search
      WHERE (LOWER(title) LIKE ${ilikePattern} OR LOWER(body) LIKE ${ilikePattern})
        AND forgotten = FALSE
        ${vaultClause}
      LIMIT ${topK * 4}
    `)) as unknown as { note_id: string; title: string; body: string }[];

    const hits: BM25Hit[] = [];
    for (const r of rows) {
      const titleLc = r.title.toLowerCase();
      const bodyLc = r.body.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (titleLc.includes(tok)) score += 5;
        if (bodyLc.includes(tok)) score += 1;
      }
      if (score > 0) {
        hits.push({
          noteId: r.note_id,
          title: r.title,
          score,
          snippet: trimSnippet(r.body, query),
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** Test hook — reset the cached extension-availability probe. */
  static resetAvailabilityCache(): void {
    pgSearchAvailable = null;
  }
}
