import { sql } from "drizzle-orm";
import { database } from "../db/index.js";
import { getNote } from "../notes/notesService.js";
import type { MemoryProvider, RelatedOpts, SearchHit, SearchOpts } from "./MemoryProvider.js";

/**
 * Tier 2 — semantic embeddings via Ollama (`nomic-embed-text`) + pgvector.
 *
 * Story 5.3: indexNote calls Ollama /api/embeddings, upserts into the
 * note_embeddings table; search runs an HNSW cosine-similarity query;
 * relatedNotes resolves the target's embedding then queries by similarity.
 *
 * When Ollama is unreachable, indexNote throws EmbeddingUnavailableError
 * (caller is expected to handle fire-and-forget — Story 5.4). search /
 * relatedNotes return [] in that case so the CombinedProvider can fall
 * back to Tier 1 transparently.
 */

export class EmbeddingUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Ollama embedding service unreachable", cause ? { cause } : undefined);
    this.name = "EmbeddingUnavailableError";
  }
}

export interface Tier2Config {
  ollamaHost?: string;
  model?: string;
  vaultId: string;
}

const DIM = 768;

export class Tier2Provider implements MemoryProvider {
  private readonly host: string;
  private readonly model: string;
  private readonly vaultId: string;

  constructor(cfg: Tier2Config) {
    this.host = cfg.ollamaHost ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
    this.model = cfg.model ?? "nomic-embed-text";
    this.vaultId = cfg.vaultId;
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
    if (!res.ok) throw new EmbeddingUnavailableError(`HTTP ${res.status}`);
    const data = (await res.json()) as { embedding: number[] };
    if (!Array.isArray(data.embedding) || data.embedding.length !== DIM) {
      throw new EmbeddingUnavailableError(`Unexpected embedding shape: ${data.embedding?.length}`);
    }
    return data.embedding;
  }

  private toPgVector(arr: number[]): string {
    return `[${arr.join(",")}]`;
  }

  async indexNote(noteId: string): Promise<void> {
    const note = await getNote(noteId);
    if (!note) return;
    const vec = await this.embed(`${note.title}\n\n${note.body}`);
    const v = this.toPgVector(vec);
    await database().execute(sql`
      INSERT INTO note_embeddings (note_id, vault_id, embedding, updated_at)
      VALUES (${noteId}, ${this.vaultId}, ${v}::vector, NOW())
      ON CONFLICT (note_id, vault_id) DO UPDATE
        SET embedding = EXCLUDED.embedding, updated_at = NOW()
    `);
  }

  async removeNote(noteId: string): Promise<void> {
    await database().execute(sql`
      DELETE FROM note_embeddings WHERE note_id = ${noteId} AND vault_id = ${this.vaultId}
    `);
  }

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
    const rows = await database().execute<{ note_id: string; distance: number }>(sql`
      SELECT note_id, embedding <=> ${v}::vector AS distance
      FROM note_embeddings
      WHERE vault_id = ${this.vaultId}
      ORDER BY embedding <=> ${v}::vector ASC
      LIMIT ${limit}
    `);
    const hits: SearchHit[] = [];
    for (const r of rows as unknown as { note_id: string; distance: number }[]) {
      const note = await getNote(r.note_id);
      if (!note) continue;
      hits.push({
        noteId: r.note_id,
        title: note.title,
        score: 1 - Number(r.distance),
        tier: "t2",
      });
    }
    return hits;
  }

  async relatedNotes(noteId: string, opts: RelatedOpts = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 5;
    const rows = await database().execute<{ note_id: string; distance: number }>(sql`
      SELECT ne.note_id, ne.embedding <=> me.embedding AS distance
      FROM note_embeddings ne, note_embeddings me
      WHERE me.note_id = ${noteId}
        AND me.vault_id = ${this.vaultId}
        AND ne.vault_id = ${this.vaultId}
        AND ne.note_id != ${noteId}
      ORDER BY ne.embedding <=> me.embedding ASC
      LIMIT ${limit}
    `);
    const hits: SearchHit[] = [];
    for (const r of rows as unknown as { note_id: string; distance: number }[]) {
      const note = await getNote(r.note_id);
      if (!note) continue;
      hits.push({
        noteId: r.note_id,
        title: note.title,
        score: 1 - Number(r.distance),
        tier: "t2",
      });
    }
    return hits;
  }
}
