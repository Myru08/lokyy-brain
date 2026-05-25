/**
 * MemoryProvider (Story 5.1) — abstracts vault retrieval for the server,
 * the future MCP package, and the Consolidation Agent. Implementations:
 *   - Tier1Provider (structural index — full-text + tags + wikilinks)
 *   - Tier2Provider (semantic — nomic-embed-text + pgvector HNSW)
 *   - CombinedProvider (Tier 1 first, Tier 2 merged in)
 */

export interface SearchHit {
  noteId: string;
  title: string;
  snippet?: string;
  score: number;
  tier: "t1" | "t2";
}

export interface SearchOpts {
  limit?: number;
  fields?: ("title" | "body" | "tags")[];
  tagFilter?: string[];
  folderPrefix?: string;
  wikilinkTarget?: string;
}

export interface RelatedOpts {
  limit?: number;
}

export interface MemoryProvider {
  /** Free-form search. Returns hits ranked by relevance. */
  search(query: string, opts?: SearchOpts): Promise<SearchHit[]>;

  /** Notes semantically (or structurally) close to a target note. */
  relatedNotes(noteId: string, opts?: RelatedOpts): Promise<SearchHit[]>;

  /** Add/update a note in the underlying index. */
  indexNote(noteId: string): Promise<void>;

  /** Remove a note from the underlying index. */
  removeNote(noteId: string): Promise<void>;
}

/** No-op provider for tests / when Tier 1/2 are unavailable. */
export class NullMemoryProvider implements MemoryProvider {
  async search(): Promise<SearchHit[]> {
    return [];
  }
  async relatedNotes(): Promise<SearchHit[]> {
    return [];
  }
  async indexNote(): Promise<void> {}
  async removeNote(): Promise<void> {}
}
