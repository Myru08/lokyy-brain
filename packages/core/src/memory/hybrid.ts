import { sql } from "drizzle-orm";
import { database } from "../db/index.js";
import { getNote } from "../notes/notesService.js";
import type { SearchHit } from "./MemoryProvider.js";

/**
 * Hybrid retrieval — BM25 (ParadeDB pg_search) + Dense (pgvector) fused via
 * Reciprocal Rank Fusion (RRF) in a single SQL CTE
 * (Phase A Wave A1 / Story 2).
 *
 * RRF: each retriever's rank `r` contributes `1 / (k + r)` to the combined
 * score. k=60 (default from the original 2009 Cormack et al. paper) gives
 * a smooth fall-off across positions and is the de-facto industry default.
 *
 * Graceful degradation:
 *   - If `pg_search` extension is missing → BM25 leg returns 0 rows and
 *     the result is effectively dense-only.
 *   - If `note_embeddings` has no matching active-generation rows → dense
 *     leg returns 0 rows and the result is effectively BM25-only.
 *   - If both legs are empty → returns [].
 */

export interface HybridOpts {
  /** Maximum hits returned from the fused result. Default 50. */
  topK?: number;
  /** Per-leg fetch depth before fusion. Default 100. */
  perLegLimit?: number;
  /** RRF constant k. Default 60. */
  rrfK?: number;
  /**
   * Intent hint — reserved for the α-weighting story landing next. Currently
   * unused; included so callers can wire it through today.
   */
  intent?: "exact_recall" | "topical" | "associative" | "question";
  /** Restrict both legs to one vault. Required for multi-tenant correctness. */
  vaultId?: string;
}

/** Probe pg_search availability once per process. */
let pgSearchAvailable: boolean | null = null;
async function hasPgSearch(): Promise<boolean> {
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

function toPgVector(arr: number[]): string {
  return `[${arr.join(",")}]`;
}

/**
 * Hybrid retrieval. Returns SearchHit[] ranked by RRF score, marked with
 * tier `"t2"` (the combined result owns no single tier — we treat the
 * fused hit as the strongest semantic signal we have).
 */
export async function hybridSearch(
  query: string,
  queryEmbedding: number[],
  opts: HybridOpts = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 50;
  const perLeg = opts.perLegLimit ?? 100;
  const rrfK = opts.rrfK ?? 60;
  const vaultId = opts.vaultId;
  const v = toPgVector(queryEmbedding);

  const bm25Enabled = (await hasPgSearch()) && query.trim().length > 0;

  // Dense leg always runs (pgvector is mandatory in the image). BM25 leg
  // is conditionally included via UNION ALL — when disabled, we use a
  // single CTE that emits zero rows for it.
  const denseVaultClause = vaultId ? sql`AND vault_id = ${vaultId}` : sql``;
  const bm25VaultClause = vaultId ? sql`AND vault_id = ${vaultId}` : sql``;

  // Active-embeddings generation — read inline. Falls back to 'default' if
  // the system_config row is missing (older databases pre-0002).
  const generationExpr = sql`COALESCE(
    (SELECT value_text FROM system_config WHERE key = 'active_embeddings_generation'),
    'default'
  )`;

  const bm25Cte = bm25Enabled
    ? sql`
      bm25 AS (
        SELECT note_id AS id,
               paradedb.score(note_id) AS s,
               ROW_NUMBER() OVER (ORDER BY paradedb.score(note_id) DESC) AS r
        FROM note_search
        WHERE note_id @@@ ${query}
          ${bm25VaultClause}
        ORDER BY paradedb.score(note_id) DESC
        LIMIT ${perLeg}
      )
    `
    : sql`
      bm25 AS (
        SELECT NULL::text AS id, NULL::double precision AS s, NULL::bigint AS r
        WHERE FALSE
      )
    `;

  const fullSql = sql`
    WITH
    ${bm25Cte},
    dense AS (
      SELECT note_id AS id,
             1 - (embedding <=> ${v}::vector) AS s,
             ROW_NUMBER() OVER (ORDER BY embedding <=> ${v}::vector ASC) AS r
      FROM note_embeddings
      WHERE generation = ${generationExpr}
        ${denseVaultClause}
      ORDER BY embedding <=> ${v}::vector ASC
      LIMIT ${perLeg}
    )
    SELECT
      COALESCE(bm25.id, dense.id) AS id,
      COALESCE(bm25.s, 0)         AS bm25_score,
      COALESCE(dense.s, 0)        AS dense_score,
      COALESCE(1.0 / (${rrfK} + bm25.r), 0)
        + COALESCE(1.0 / (${rrfK} + dense.r), 0) AS rrf_score
    FROM bm25
    FULL OUTER JOIN dense USING (id)
    WHERE COALESCE(bm25.id, dense.id) IS NOT NULL
    ORDER BY rrf_score DESC
    LIMIT ${topK}
  `;

  const rows = (await database().execute(fullSql)) as unknown as {
    id: string;
    bm25_score: number;
    dense_score: number;
    rrf_score: number;
  }[];

  const hits: SearchHit[] = [];
  for (const r of rows) {
    if (!r.id) continue;
    const note = await getNote(r.id);
    if (!note) continue;
    hits.push({
      noteId: r.id,
      title: note.title,
      score: Number(r.rrf_score),
      tier: "t2",
    });
  }
  return hits;
}

/** Test hook — reset the cached extension-availability probe. */
export function resetHybridAvailabilityCache(): void {
  pgSearchAvailable = null;
}
