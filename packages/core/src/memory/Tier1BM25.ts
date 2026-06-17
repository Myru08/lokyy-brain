import { sql } from "drizzle-orm";
import { database, indexDatabase } from "../db/index.js";

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

/**
 * Sanitize a raw user query for the ParadeDB `@@@` operator (Story 10.1, AC#1).
 *
 * WHY this is required: even though `${query}` is a bound parameter (safe from
 * SQL-text injection), ParadeDB interprets the *value* as its own BM25 query
 * DSL. Characters like `(`, `)`, `'`, `:`, `[`, `]`, `{`, `}`, `+`, `-`, `^`,
 * `~`, `*`, `?`, `\`, `/`, `"` and boolean operators (`AND`/`OR`/`NOT`) are
 * meaningful in that grammar; an unbalanced or stray one makes ParadeDB throw
 * `PostgresError 42601 scanner_yyerror`, which (pre-fix) cascaded into a pool
 * exhaustion outage. We strip the DSL-significant punctuation down to plain
 * whitespace-separated terms so a query like `"foo) bar"` or `"o'brien"`
 * becomes a harmless term list ParadeDB can always parse.
 *
 * Returns the cleaned term string, or an empty string when nothing usable
 * remains (caller then short-circuits to an empty result).
 */
export function sanitizeBm25Query(query: string): string {
  return query
    // Replace every ParadeDB/Tantivy DSL-significant character with a space.
    // Kept intentionally broad: we only need term tokens here, not operators.
    .replace(/[()[\]{}:^~*?\\/"'+\-!&|<>=#@]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    // Drop bare boolean keywords so they aren't parsed as BM25 operators.
    .filter((t) => t.length > 0 && !/^(AND|OR|NOT|TO|IN)$/i.test(t))
    .join(" ")
    .trim();
}

/**
 * Detect a ParadeDB/Postgres query-parse failure (Story 10.1, AC#1).
 *
 * 42601 is Postgres `syntax_error`; ParadeDB raises it (with `scanner_yyerror`)
 * when the BM25 query value is unparseable. We match on the SQLSTATE code when
 * present and fall back to the message text so the LIKE fallback still triggers
 * on driver variants that don't surface `.code`.
 */
function isQueryParseError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "42601") return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /scanner_yyerror|syntax error|42601/i.test(message);
}

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
    // Story 10.1, AC#2/AC#4: index writes run on the isolated index pool so a
    // slow/failing ParadeDB index-maintenance write can never starve the main
    // read/search pool. The statement remains idempotent via ON CONFLICT.
    //
    // Gate-0 fix: bind `tags` as a SINGLE array parameter via `sql.param(tags)`
    // rather than interpolating the JS array directly. In drizzle-orm 0.36.4 a
    // bare `${tags}` in an sql-template is *expanded* into a comma-separated
    // placeholder list — `($1, $2)` for `['a','b']` and, fatally, `()` for the
    // empty array, which Postgres rejects with `syntax error at or near ")"`
    // (SQLSTATE 42601). That 42601 made every tag-less note fail its index
    // write, trip the per-note circuit breaker after 3 attempts, and fall out
    // of the BM25 index entirely. `sql.param(tags)` compiles to a single bound
    // placeholder (`$N::text[]`) so postgres.js serialises the array to a
    // proper `text[]` literal — `'{}'` for `[]`, `'{"a","b"}'` for `['a','b']`
    // — for BOTH the empty and non-empty cases.
    await indexDatabase().execute(sql`
      INSERT INTO note_search (note_id, vault_id, title, body, tags, forgotten, updated_at)
      VALUES (${noteId}, ${vaultId}, ${title}, ${body}, ${sql.param(tags)}::text[], ${forgotten}, NOW())
      ON CONFLICT (note_id) DO UPDATE
        SET vault_id   = EXCLUDED.vault_id,
            title      = EXCLUDED.title,
            body       = EXCLUDED.body,
            tags       = EXCLUDED.tags,
            forgotten  = EXCLUDED.forgotten,
            updated_at = NOW()
    `);
  }

  /** Remove a note from `note_search`. Runs on the isolated index pool. */
  async remove(noteId: string): Promise<void> {
    await indexDatabase().execute(sql`DELETE FROM note_search WHERE note_id = ${noteId}`);
  }

  /**
   * Toggle the `forgotten` flag for an existing note_search row
   * (Phase C Wave C3 / Story 2). Returns `true` if a row was actually
   * updated, `false` if the row is missing — the caller can then decide
   * whether to fall back to a full `upsert` (e.g. a forget() arriving
   * before the first BM25 index refresh completed).
   */
  async setForgotten(noteId: string, forgotten: boolean): Promise<boolean> {
    // Write path → isolated index pool (Story 10.1, AC#4).
    const rows = (await indexDatabase().execute(sql`
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

    if (hasExt) {
      // Story 10.1, AC#1: sanitize the raw user string before it ever reaches
      // the ParadeDB `@@@` BM25 DSL. If sanitization leaves nothing usable,
      // fall through to LIKE (which tokenizes its own way) rather than running
      // an empty BM25 query.
      const safeQuery = sanitizeBm25Query(query);
      if (safeQuery.length > 0) {
        // ParadeDB pg_search path. `note_id @@@ $query` runs the query against
        // every BM25-indexed field on the row (title + body + tags) and
        // `paradedb.score(note_id)` returns the BM25 rank score.
        //
        // Phase C Wave C3 / Story 2 — Cognee `forget()` primitive: exclude
        // rows with `forgotten = true` so the user-marked notes never reach
        // active retrieval. The note stays on disk; only the index hides it.
        const vaultClause = vaultId ? sql`AND vault_id = ${vaultId}` : sql``;
        try {
          const rows = (await database().execute(sql`
            SELECT note_id, title, body, paradedb.score(note_id) AS score
            FROM note_search
            WHERE note_id @@@ ${safeQuery}
              AND forgotten = FALSE
              ${vaultClause}
            ORDER BY score DESC
            LIMIT ${topK}
          `)) as unknown as {
            note_id: string;
            title: string;
            body: string;
            score: number;
          }[];
          return rows.map((r) => ({
            noteId: r.note_id,
            title: r.title,
            score: Number(r.score),
            snippet: trimSnippet(r.body, query),
          }));
        } catch (err) {
          // Story 10.1, AC#1: defense-in-depth. Sanitization should already
          // prevent parse errors, but any residual ParadeDB DSL failure must
          // degrade to the LIKE path instead of throwing (and never re-fire
          // into a pool-exhausting loop). Non-parse errors (connection, etc.)
          // are real and must propagate.
          if (!isQueryParseError(err)) throw err;
          console.warn(
            "[Tier1BM25] @@@ query parse failed; falling back to LIKE",
            { query, safeQuery, err: err instanceof Error ? err.message : err },
          );
          // fall through to LIKE fallback below
        }
      }
    }

    return this.likeFallbackSearch(query, topK, vaultId);
  }

  /**
   * LIKE-based fallback search. Used when `pg_search` is unavailable AND as the
   * deterministic degradation path when a ParadeDB `@@@` query fails to parse
   * (Story 10.1, AC#1). Naive scoring: title-hit +5, body-hit +1 per token.
   * Same forgotten-filter as the pg_search path so search semantics stay
   * consistent.
   */
  private async likeFallbackSearch(
    query: string,
    topK: number,
    vaultId?: string,
  ): Promise<BM25Hit[]> {
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
    // Bind-parameter — body content cannot break the SQL text. `%` / `_` inside
    // the token act as LIKE wildcards, which is harmless (over-matches at worst)
    // and never throws, so no escaping is needed for crash-safety.
    const ilikePattern = `%${tokens[0]}%`;
    const vaultClause = vaultId ? sql`AND vault_id = ${vaultId}` : sql``;
    const rows = (await database().execute(sql`
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
