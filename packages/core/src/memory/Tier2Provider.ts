import { sql } from "drizzle-orm";
import { database } from "../db/index.js";
import { getNote } from "../notes/notesService.js";
import { getActiveGeneration } from "../llm/embeddingsMigration.js";
import { DEFAULT_EMBEDDINGS_GENERATION } from "../db/schema/embeddingsMigration.js";
import {
  chunkNote,
  maxTokensUpperBound,
  EMBED_MODEL_CONTEXT_TOKENS,
  type Chunk,
  type ChunkType,
} from "../chunking/index.js";
import type { MemoryProvider, RelatedOpts, SearchHit, SearchOpts } from "./MemoryProvider.js";

/**
 * Tier 2 — semantic embeddings via Ollama (`nomic-embed-text`) + pgvector.
 *
 * Phase A Wave A2 (Stories 5+6): multi-chunk embeddings per note.
 *
 *  - `indexNote` calls `chunkNote()` (title / body_full / section /
 *    sliding_3para fan-out with anchor-text injection), then for each
 *    chunk checks the stored `content_hash` against the freshly-computed
 *    one. If they match — no Ollama call, no DB write. Otherwise embed
 *    and upsert. Chunks that no longer exist (the note shrank or was
 *    restructured) are deleted at the end of the run.
 *  - `search` embeds the query, joins against ALL chunks in the active
 *    generation, then dedupes to one hit per note (keeping the max-
 *    similarity chunk so a title-match isn't drowned out by a weaker
 *    body match).
 *  - `searchByChunkType` exposes the chunk-typed table for advanced
 *    callers (e.g. "search only against titles" or "only against H2
 *    sections") — built on top of the same SQL.
 *
 * When Ollama is unreachable, indexNote throws EmbeddingUnavailableError
 * (caller is expected to handle fire-and-forget — Story 5.4). search /
 * relatedNotes return [] in that case so the CombinedProvider can fall
 * back to Tier 1 transparently.
 */

export class EmbeddingUnavailableError extends Error {
  constructor(cause?: unknown) {
    // Story 5.8 AC#5: keep the reason IN the message. It used to live only in
    // `cause`, so every log line read as a bare "unreachable" regardless of
    // what actually failed (wrong model name, 503, bad response shape).
    const reason =
      cause === undefined || cause === null
        ? ""
        : cause instanceof Error
          ? cause.message
          : String(cause);
    super(
      `Ollama embedding service unreachable${reason ? ` (${reason})` : ""}`,
      cause ? { cause } : undefined,
    );
    this.name = "EmbeddingUnavailableError";
  }
}

/**
 * The embedding service was reachable and REFUSED the input because it is
 * longer than the model's context window (Story 5.8 AC#5).
 *
 * Deliberately NOT a subclass of {@link EmbeddingUnavailableError}: reporting
 * this as "service unreachable" is what sent the community bug reporter
 * debugging a healthy Ollama. The fix is on the caller's side (chunk smaller —
 * see `EMBED_MODEL_CONTEXT_TOKENS`), not on the service's.
 */
export class EmbeddingInputTooLargeError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly approxTokens: number;
  constructor(status: number, detail: string, approxTokens: number) {
    super(
      `Embedding input rejected: it exceeds the model's context window ` +
        `(~${approxTokens} tokens sent, model limit ${EMBED_MODEL_CONTEXT_TOKENS}). ` +
        `The service is UP — the chunk is too large. HTTP ${status}: ${detail}`,
    );
    this.name = "EmbeddingInputTooLargeError";
    this.status = status;
    this.detail = detail;
    this.approxTokens = approxTokens;
  }
}

/**
 * Ollama's wording when a prompt overruns the context window, observed against
 * the deployed model:
 *   HTTP 500 {"error":"the input length exceeds the context length"}
 * Kept deliberately loose so a reworded upstream message still classifies.
 */
const INPUT_TOO_LONG_RE = /context length|context window|input (?:length|is too long)|too (?:long|large)|exceeds/i;

export interface Tier2Config {
  ollamaHost?: string;
  model?: string;
  vaultId: string;
  /** Override the body_full token cap (default 1920 — see chunking/index.ts). */
  maxBodyFullTokens?: number;
}

const DIM = 768;

interface ExistingChunkRow extends Record<string, unknown> {
  chunk_type: string;
  chunk_idx: number;
  content_hash: string | null;
}

export class Tier2Provider implements MemoryProvider {
  private readonly host: string;
  private readonly model: string;
  private readonly vaultId: string;
  private readonly maxBodyFullTokens: number | undefined;

  constructor(cfg: Tier2Config) {
    this.host = cfg.ollamaHost ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
    this.model = cfg.model ?? "nomic-embed-text";
    this.vaultId = cfg.vaultId;
    this.maxBodyFullTokens = cfg.maxBodyFullTokens;
  }

  private async embed(text: string): Promise<number[]> {
    let res: Response;
    try {
      res = await fetch(`${this.host}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new EmbeddingUnavailableError(err);
    }
    if (!res.ok) {
      // AC#5: read the body before deciding. "Service down" and "you sent too
      // much text" are different failures with different fixes, and only the
      // body distinguishes them — the status is 500 in both cases.
      const detail = await res.text().catch(() => "");
      if (INPUT_TOO_LONG_RE.test(detail)) {
        throw new EmbeddingInputTooLargeError(
          res.status,
          detail.trim().slice(0, 200),
          // Report the conservative upper bound (#42): the neutral ~4-chars
          // estimate under-counts the dense content that triggers THIS error,
          // which is exactly when an honest token number matters.
          maxTokensUpperBound(text),
        );
      }
      throw new EmbeddingUnavailableError(
        `HTTP ${res.status}${detail ? `: ${detail.trim().slice(0, 200)}` : ""}`,
      );
    }
    const data = (await res.json()) as { embedding: number[] };
    if (!Array.isArray(data.embedding) || data.embedding.length !== DIM) {
      throw new EmbeddingUnavailableError(`Unexpected embedding shape: ${data.embedding?.length}`);
    }
    return data.embedding;
  }

  private toPgVector(arr: number[]): string {
    return `[${arr.join(",")}]`;
  }

  /**
   * Resolve the active generation tag with a safe fallback. If the
   * system_config row is missing (older databases pre-migration 0002),
   * fall back to "default" so the legacy single-generation behaviour
   * keeps working.
   */
  private async activeGeneration(): Promise<string> {
    try {
      return await getActiveGeneration();
    } catch {
      return DEFAULT_EMBEDDINGS_GENERATION;
    }
  }

  /**
   * Multi-chunk index — Late Chunking + Anchor-Text-Injection.
   *
   * Steps:
   *   1. Build chunk fan-out via `chunkNote()`.
   *   2. Load existing (chunk_type, chunk_idx, content_hash) rows for this
   *      note in the active generation.
   *   3. For each new chunk: if its hash matches the stored hash, skip
   *      the embed call entirely (incremental — saves Ollama round-trips
   *      when only one section of a note changed). Otherwise embed +
   *      upsert.
   *   4. Delete any (chunk_type, chunk_idx) pairs that no longer exist
   *      in the new fan-out — covers notes that shrank or had headings
   *      removed.
   */
  async indexNote(noteId: string): Promise<void> {
    const note = await getNote(noteId);
    if (!note) return;

    const chunks = chunkNote({
      title: note.title,
      body: note.body,
      maxBodyFullTokens: this.maxBodyFullTokens,
    });

    const generation = await this.activeGeneration();
    const db = database();

    const existingRows = await db.execute<ExistingChunkRow>(sql`
      SELECT chunk_type, chunk_idx, content_hash
      FROM note_embeddings
      WHERE note_id = ${noteId}
        AND vault_id = ${this.vaultId}
        AND generation = ${generation}
    `);
    const existingByKey = new Map<string, string | null>();
    for (const row of existingRows as unknown as ExistingChunkRow[]) {
      existingByKey.set(`${row.chunk_type}:${row.chunk_idx}`, row.content_hash);
    }

    const keptKeys = new Set<string>();

    for (const chunk of chunks) {
      const key = `${chunk.chunkType}:${chunk.chunkIdx}`;
      keptKeys.add(key);

      const existingHash = existingByKey.get(key);
      if (existingHash !== undefined && existingHash === chunk.hash) {
        // Hash match → no embed call, no write. This is where the cost
        // savings live: a 50-section note with one edited section only
        // pays for one Ollama call instead of 50+.
        continue;
      }

      const vec = await this.embed(chunk.anchored);
      const v = this.toPgVector(vec);
      await db.execute(sql`
        INSERT INTO note_embeddings
          (note_id, vault_id, generation, chunk_type, chunk_idx, content_hash, embedding, updated_at)
        VALUES
          (${noteId}, ${this.vaultId}, ${generation}, ${chunk.chunkType}, ${chunk.chunkIdx}, ${chunk.hash}, ${v}::vector, NOW())
        ON CONFLICT (note_id, vault_id, generation, chunk_type, chunk_idx) DO UPDATE
          SET embedding = EXCLUDED.embedding,
              content_hash = EXCLUDED.content_hash,
              updated_at = NOW()
      `);
    }

    // Prune chunks that disappeared from the new fan-out.
    for (const oldKey of existingByKey.keys()) {
      if (keptKeys.has(oldKey)) continue;
      const [chunkType, chunkIdxStr] = oldKey.split(":");
      const chunkIdx = Number(chunkIdxStr);
      await db.execute(sql`
        DELETE FROM note_embeddings
        WHERE note_id = ${noteId}
          AND vault_id = ${this.vaultId}
          AND generation = ${generation}
          AND chunk_type = ${chunkType}
          AND chunk_idx = ${chunkIdx}
      `);
    }
  }

  async removeNote(noteId: string): Promise<void> {
    // Remove from ALL generations and ALL chunk_types — the note is gone.
    await database().execute(sql`
      DELETE FROM note_embeddings WHERE note_id = ${noteId} AND vault_id = ${this.vaultId}
    `);
  }

  /**
   * Search across all chunks in the active generation. The DB returns up
   * to `limit * 4` rows (because multiple chunks can share a note_id),
   * then we dedupe in TS keeping the max-score chunk per note.
   */
  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    if (!query) return [];
    const limit = opts.limit ?? 10;
    let vec: number[];
    try {
      vec = await this.embed(query);
    } catch {
      return [];
    }
    const v = this.toPgVector(vec);
    const generation = await this.activeGeneration();
    // Over-fetch so dedupe-by-note still produces `limit` distinct hits.
    const overFetch = Math.max(limit * 4, 40);
    // Phase C Wave C3 / Story 2 — Cognee `forget()` primitive: LEFT JOIN
    // note_search and drop rows whose backing note is forgotten. LEFT JOIN
    // (not INNER) so notes that have an embedding row but not yet a
    // note_search row stay searchable during the early-indexing window.
    const rows = await database().execute<{
      note_id: string;
      chunk_type: string;
      chunk_idx: number;
      distance: number;
    }>(sql`
      SELECT ne.note_id, ne.chunk_type, ne.chunk_idx,
             ne.embedding <=> ${v}::vector AS distance
      FROM note_embeddings ne
      LEFT JOIN note_search ns ON ns.note_id = ne.note_id
      WHERE ne.vault_id = ${this.vaultId}
        AND ne.generation = ${generation}
        AND (ns.forgotten IS NULL OR ns.forgotten = FALSE)
      ORDER BY ne.embedding <=> ${v}::vector ASC
      LIMIT ${overFetch}
    `);

    return this.dedupeAndResolve(
      rows as unknown as Array<{
        note_id: string;
        chunk_type: string;
        chunk_idx: number;
        distance: number;
      }>,
      limit,
    );
  }

  /**
   * Search restricted to a single chunk_type. Useful for advanced UI like
   * "find by title only" (titles often carry the strongest semantic signal
   * on personal vaults) or "find an H2-section that matches".
   */
  async searchByChunkType(
    query: string,
    chunkType: ChunkType,
    opts: SearchOpts = {},
  ): Promise<SearchHit[]> {
    if (!query) return [];
    const limit = opts.limit ?? 10;
    let vec: number[];
    try {
      vec = await this.embed(query);
    } catch {
      return [];
    }
    const v = this.toPgVector(vec);
    const generation = await this.activeGeneration();
    const overFetch = Math.max(limit * 4, 40);
    // Same forgotten-filter as `search` — apply at the dense layer so the
    // chunk-typed advanced UI hides forgotten notes too.
    const rows = await database().execute<{
      note_id: string;
      chunk_type: string;
      chunk_idx: number;
      distance: number;
    }>(sql`
      SELECT ne.note_id, ne.chunk_type, ne.chunk_idx,
             ne.embedding <=> ${v}::vector AS distance
      FROM note_embeddings ne
      LEFT JOIN note_search ns ON ns.note_id = ne.note_id
      WHERE ne.vault_id = ${this.vaultId}
        AND ne.generation = ${generation}
        AND ne.chunk_type = ${chunkType}
        AND (ns.forgotten IS NULL OR ns.forgotten = FALSE)
      ORDER BY ne.embedding <=> ${v}::vector ASC
      LIMIT ${overFetch}
    `);

    return this.dedupeAndResolve(
      rows as unknown as Array<{
        note_id: string;
        chunk_type: string;
        chunk_idx: number;
        distance: number;
      }>,
      limit,
    );
  }

  /**
   * Related notes — finds notes whose best-matching chunk is closest to
   * the target note's title chunk (falls back to body_full or the first
   * available chunk if no title row exists yet).
   *
   * Forgotten notes are skipped on the candidate side (the target note
   * may itself be forgotten — the user is asking "related to this", so we
   * still pull its embedding as the seed). Only `ne.note_id != target`
   * results are filtered against `note_search.forgotten`.
   */
  async relatedNotes(noteId: string, opts: RelatedOpts = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 5;
    const generation = await this.activeGeneration();
    const overFetch = Math.max(limit * 4, 40);
    const rows = await database().execute<{
      note_id: string;
      chunk_type: string;
      chunk_idx: number;
      distance: number;
    }>(sql`
      WITH target AS (
        SELECT embedding
        FROM note_embeddings
        WHERE note_id = ${noteId}
          AND vault_id = ${this.vaultId}
          AND generation = ${generation}
        ORDER BY
          CASE chunk_type
            WHEN 'title' THEN 0
            WHEN 'body_full' THEN 1
            WHEN 'section' THEN 2
            ELSE 3
          END
        LIMIT 1
      )
      SELECT ne.note_id, ne.chunk_type, ne.chunk_idx,
             ne.embedding <=> (SELECT embedding FROM target) AS distance
      FROM note_embeddings ne
      LEFT JOIN note_search ns ON ns.note_id = ne.note_id
      WHERE ne.vault_id = ${this.vaultId}
        AND ne.generation = ${generation}
        AND ne.note_id != ${noteId}
        AND (ns.forgotten IS NULL OR ns.forgotten = FALSE)
      ORDER BY ne.embedding <=> (SELECT embedding FROM target) ASC
      LIMIT ${overFetch}
    `);

    return this.dedupeAndResolve(
      rows as unknown as Array<{
        note_id: string;
        chunk_type: string;
        chunk_idx: number;
        distance: number;
      }>,
      limit,
    );
  }

  /**
   * Dedupe rows-per-chunk down to one hit per note (max-score wins) and
   * resolve note titles. Preserves the order from the SQL — first row for
   * a given note_id is by construction the closest one.
   */
  private async dedupeAndResolve(
    rows: Array<{
      note_id: string;
      chunk_type: string;
      chunk_idx: number;
      distance: number;
    }>,
    limit: number,
  ): Promise<SearchHit[]> {
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const r of rows) {
      if (seen.has(r.note_id)) continue;
      seen.add(r.note_id);
      const note = await getNote(r.note_id);
      if (!note) continue;
      hits.push({
        noteId: r.note_id,
        title: note.title,
        score: 1 - Number(r.distance),
        tier: "t2",
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}
