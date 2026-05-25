import { Tier1Provider } from "./Tier1Provider.js";
import { Tier2Provider, EmbeddingUnavailableError } from "./Tier2Provider.js";
import type { MemoryProvider, RelatedOpts, SearchHit, SearchOpts } from "./MemoryProvider.js";

/**
 * CombinedProvider — Tier 1 + Tier 2 merged.
 *
 * Search: Tier 1 first (always available), then Tier 2 appended for hits
 * not already returned by Tier 1. relatedNotes: Tier 2 first (semantically
 * close beats structurally close), Tier 1 fallback when T2 returns empty.
 *
 * indexNote: Tier 1 marks dirty (free), Tier 2 fire-and-forget (Story 5.4).
 */
export class CombinedProvider implements MemoryProvider {
  readonly t1: Tier1Provider;
  readonly t2: Tier2Provider;

  constructor(t1: Tier1Provider, t2: Tier2Provider) {
    this.t1 = t1;
    this.t2 = t2;
  }

  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const t1Hits = await this.t1.search(query, opts);
    const seen = new Set(t1Hits.map((h) => h.noteId));
    const t2Hits = await this.t2.search(query, opts);
    const merged = [...t1Hits];
    for (const h of t2Hits) {
      if (!seen.has(h.noteId)) merged.push(h);
    }
    return merged.slice(0, opts.limit ?? 25);
  }

  async relatedNotes(noteId: string, opts: RelatedOpts = {}): Promise<SearchHit[]> {
    const t2 = await this.t2.relatedNotes(noteId, opts);
    if (t2.length > 0) return t2;
    return this.t1.relatedNotes(noteId, opts);
  }

  async indexNote(noteId: string): Promise<void> {
    await this.t1.indexNote(noteId);
    // Tier 2 is fire-and-forget (Story 5.4) — caller controls awaitness.
    try {
      await this.t2.indexNote(noteId);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        console.warn("[tier2] embedding sync skipped:", err.message);
      } else {
        throw err;
      }
    }
  }

  async removeNote(noteId: string): Promise<void> {
    await this.t1.removeNote(noteId);
    try {
      await this.t2.removeNote(noteId);
    } catch (err) {
      console.warn("[tier2] embedding remove failed:", err);
    }
  }
}
