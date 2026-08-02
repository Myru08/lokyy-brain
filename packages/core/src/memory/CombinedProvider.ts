import { Tier1Provider } from "./Tier1Provider.js";
import {
  Tier2Provider,
  EmbeddingUnavailableError,
  EmbeddingInputTooLargeError,
} from "./Tier2Provider.js";
import { Tier1BM25 } from "./Tier1BM25.js";
import type { MemoryProvider, RelatedOpts, SearchHit, SearchOpts } from "./MemoryProvider.js";

/**
 * CombinedProvider — Tier 1 + Tier 2 merged.
 *
 * Search: the Tier-1 leg is served by the **indexed** `Tier1BM25` path
 * (ParadeDB `pg_search` over the `note_search` table, with a built-in
 * LIKE fallback when the extension is missing). This replaces the cold,
 * per-note `getNote()` rebuild that `Tier1Provider` performed on first
 * query — that rebuild was the ~25s structural-search latency (it read
 * every note off disk/git). The BM25 path is a single indexed SQL query,
 * so the hot path stays sub-second on a ~100-note vault.
 *
 * `Tier1Provider` (in-memory) is kept as the always-available fallback for
 * two cases:
 *   1. `note_search` returns zero hits for a non-empty query — e.g. the
 *      table was never backfilled for pre-existing notes, or pg_search +
 *      the table are both unavailable. We then fall back to the structural
 *      index so result quality never regresses to 0.
 *   2. Structured filter queries (tagFilter / folderPrefix / wikilinkTarget)
 *      and `relatedNotes`, which need the structural tag/wikilink index that
 *      `note_search` does not model.
 *
 * Then Tier 2 (semantic) is appended for hits not already returned.
 * relatedNotes: Tier 2 first (semantically close beats structurally close),
 * Tier 1 fallback when T2 returns empty.
 *
 * indexNote: Tier 1 marks dirty (free), Tier 2 fire-and-forget (Story 5.4).
 * The `note_search` BM25 corpus is maintained separately via
 * `queueSearchIndexRefresh` in `./index.ts` on every save — not here.
 */
/**
 * Fraction of a search's `limit` held open for Tier-2 (semantic) hits when the
 * semantic leg has anything new to contribute (Story 5.8 AC#6). At the default
 * limit of 25 this is 8 slots. Unused reserve is backfilled from Tier 1.
 */
const TIER2_RESERVED_SHARE = 0.3;

export class CombinedProvider implements MemoryProvider {
  readonly t1: Tier1Provider;
  readonly t2: Tier2Provider;
  /** Indexed BM25 path used for the Tier-1 leg of `search`. */
  private readonly bm25: Tier1BM25;
  /** Vault to scope BM25 queries to (multi-tenant correctness). */
  private readonly vaultId?: string;

  constructor(t1: Tier1Provider, t2: Tier2Provider, vaultId?: string, bm25?: Tier1BM25) {
    this.t1 = t1;
    this.t2 = t2;
    this.vaultId = vaultId;
    this.bm25 = bm25 ?? new Tier1BM25();
  }

  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 25;

    // ── Tier-1 leg: indexed BM25 (fast) with a structural fallback ──────────
    //
    // The BM25 path does not model the structured filters (tagFilter,
    // folderPrefix, wikilinkTarget). When the caller passes one of those we
    // must use the structural `Tier1Provider`, which understands them. Plain
    // free-text queries (the CommandPalette / cmd-k hot path) take the fast
    // indexed route.
    const needsStructuralFilter = Boolean(
      opts.tagFilter?.length || opts.folderPrefix || opts.wikilinkTarget,
    );

    let t1Hits: SearchHit[];
    if (!needsStructuralFilter && query.trim().length > 0) {
      // Tier1BM25.search already sanitizes the query, scopes by vault, and
      // degrades to LIKE when pg_search is unavailable — and never reads a
      // note off disk. Map BM25Hit → SearchHit (tier "t1").
      const bm25Hits = await this.bm25.search(query, limit, this.vaultId);
      if (bm25Hits.length > 0) {
        t1Hits = bm25Hits.map((h) => ({
          noteId: h.noteId,
          title: h.title,
          snippet: h.snippet,
          score: h.score,
          tier: "t1" as const,
        }));
      } else {
        // Empty BM25 result for a real query → the corpus may be
        // un-backfilled (note_search empty for legacy notes) or pg_search +
        // the table are both unavailable. Fall back to the structural index
        // so quality never regresses to 0. This is the only path that can
        // still trigger the slower in-memory rebuild — and only when BM25
        // found nothing at all.
        t1Hits = await this.t1.search(query, opts);
      }
    } else {
      // Structural filters or empty/filter-only query → structural index.
      t1Hits = await this.t1.search(query, opts);
    }

    const seen = new Set(t1Hits.map((h) => h.noteId));
    const t2Hits = await this.t2.search(query, opts);
    const t2New = t2Hits.filter((h) => !seen.has(h.noteId));
    if (t2New.length === 0) return t1Hits.slice(0, limit);

    // ── Story 5.8 AC#6: reserve capacity for the semantic leg ───────────────
    //
    // The previous merge appended Tier 2 AFTER an uncapped Tier 1 and then
    // sliced to `limit`, so a query with `limit` keyword hits could never
    // surface a semantic one — the whole point of Tier 2 (finding notes that
    // share no keywords with the query) was unreachable exactly when the vault
    // was well-populated.
    //
    // Reserving a share beats re-ranking by score: BM25 scores and cosine
    // similarities are not on a comparable scale, so a numeric merge would be
    // arbitrary. Whatever either leg leaves unused is backfilled from the
    // other, so the caller always gets `limit` hits when they exist.
    const reserved = Math.min(
      t2New.length,
      Math.max(1, Math.ceil(limit * TIER2_RESERVED_SHARE)),
    );
    const t1Take = Math.max(0, limit - reserved);

    const merged = [...t1Hits.slice(0, t1Take), ...t2New.slice(0, reserved)];
    for (const h of [...t1Hits.slice(t1Take), ...t2New.slice(reserved)]) {
      if (merged.length >= limit) break;
      merged.push(h);
    }
    return merged.slice(0, limit);
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
      if (err instanceof EmbeddingInputTooLargeError) {
        // Story 5.8 AC#5: a chunk that slipped past the size gates must not
        // read as an outage, and must not abort indexing of the whole note.
        console.warn(
          `[tier2] chunk rejected for note ${noteId} — Ollama is UP: ${err.message}`,
        );
      } else if (err instanceof EmbeddingUnavailableError) {
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
