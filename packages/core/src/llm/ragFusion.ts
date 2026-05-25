import type { LlmRouter } from "./router.js";
import type { ChatMessage } from "./types.js";

/**
 * RAG-Fusion — Multi-Query Rewrite + Reciprocal Rank Fusion.
 *
 * Phase B Wave B1 / Story 3.
 *
 * The user query is rewritten by an LLM into N variantly-phrased queries.
 * Each variant runs through a hybrid retriever (injected — typically
 * `hybridSearch` from `../memory/hybrid.ts`). The result lists are fused
 * via RRF (k=60), the same rank-aggregation primitive already used by
 * the hybrid CTE. The net effect: a single user query gets compared
 * against multiple semantic "angles", and the union of strong signals
 * beats any single rewrite.
 *
 * Empirical: beats HyDE on HotPotQA by +7pp F1 (Microsoft, 2023).
 * Optimal N: 3 (Microsoft's measurement — more rewrites add latency
 * without significant recall gains).
 *
 * Design notes:
 *   - Retrieval function is INJECTED (not imported). This keeps the
 *     module free of a hard dependency on `hybrid.ts` and makes the
 *     fuser unit-testable with a synthetic retriever.
 *   - Graceful LLM failure: if `query-rewrite` provider fails, we fall
 *     back to running ONLY the original query. The pipeline never
 *     hard-fails on a rewrite error — RAG-Fusion is an opt-in quality
 *     booster, not a correctness primitive.
 *   - Rewrite de-duplication: identical text variants are collapsed
 *     before retrieval so a low-creativity LLM (or a repeated original)
 *     does not double-count a single list under RRF.
 *   - Per-list retrieval errors are swallowed (returned as empty list)
 *     so a single failing variant does not poison the fusion.
 */

export interface RagFusionOptions {
  /** Number of LLM-generated rewrites. Default 3 (Microsoft empirical optimum). */
  numRewrites?: number;
  /** RRF constant — controls the fall-off across ranks. Default 60. */
  rrfK?: number;
  /** Final fused-result limit. Default 50. */
  topK?: number;
  /** Include the ORIGINAL user query as one of the retrieval variants. Default true. */
  includeOriginal?: boolean;
}

export interface RewrittenQuery {
  text: string;
  isOriginal: boolean;
}

export interface RagFusionHit {
  noteId: string;
  /** RRF-summed score across all source lists. */
  score: number;
  /** The rewrite texts whose retrieval lists contributed to this hit. */
  sources: string[];
}

export interface RagFusionResult {
  rewrites: RewrittenQuery[];
  fused: RagFusionHit[];
  durationMs: number;
  /** True iff the LLM rewrite call failed and we degraded to original-only. */
  degraded?: boolean;
}

/** Minimal hit shape the injected retriever must return. */
export interface RetrieveHit {
  noteId: string;
  score: number;
}

export type RetrieveFn = (query: string) => Promise<RetrieveHit[]>;

const PROMPT = `Generate {{N}} alternative phrasings of the following user query.
Each variant should preserve the core intent but use different wording, synonyms, or perspectives.
Return ONE per line. No numbering. No preamble.

Original: {{QUERY}}`;

export class RagFusion {
  constructor(
    private router: LlmRouter,
    /**
     * Retrieval function — typically `hybridSearch` wrapped to a uniform
     * `(query) => Promise<RetrieveHit[]>` signature. Injection keeps this
     * module independent of `memory/hybrid.ts` and trivially mockable.
     */
    private retrieve: RetrieveFn,
  ) {}

  /**
   * Ask the `query-rewrite`-role LLM for N alternative phrasings.
   * Throws on provider failure — the caller (`fuse`) catches and degrades.
   */
  async rewrite(query: string, n: number): Promise<string[]> {
    const provider = this.router.getProvider("query-rewrite");
    if (!provider.chat) {
      throw new Error("query-rewrite provider has no chat capability");
    }

    const prompt = PROMPT.replace("{{N}}", String(n)).replace("{{QUERY}}", query);
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];
    const result = await provider.chat(messages, {
      maxTokens: 60 * n,
      temperature: 0.7,
    });

    return result.text
      .split("\n")
      .map((s) => s.replace(/^[\d\-*.)]+\s*/, "").trim())
      .filter((s) => s.length > 0)
      .slice(0, n);
  }

  /**
   * Full RAG-Fusion pass: rewrite → parallel retrieve → RRF fuse → topK.
   * Never hard-fails on LLM errors — `degraded: true` flags the fallback.
   */
  async fuse(query: string, opts: RagFusionOptions = {}): Promise<RagFusionResult> {
    const start = Date.now();
    const numRewrites = opts.numRewrites ?? 3;
    const rrfK = opts.rrfK ?? 60;
    const topK = opts.topK ?? 50;
    const includeOriginal = opts.includeOriginal ?? true;

    // 1. Build the variant list. Original first (when included) so it gets
    //    de-dup priority over any LLM rewrite that happens to mirror it.
    const rewrites: RewrittenQuery[] = [];
    if (includeOriginal) {
      rewrites.push({ text: query, isOriginal: true });
    }

    let degraded = false;
    try {
      const generated = await this.rewrite(query, numRewrites);
      for (const r of generated) {
        rewrites.push({ text: r, isOriginal: false });
      }
    } catch {
      // Graceful degradation: keep the original query, mark degraded.
      // If `includeOriginal` was false we still ensure at least one
      // retrieval pass — otherwise `fuse` would return an empty result
      // for an entirely-LLM-driven flow.
      degraded = true;
      if (rewrites.length === 0) {
        rewrites.push({ text: query, isOriginal: true });
      }
    }

    // 2. De-duplicate variant texts (case-insensitive, trimmed). Identical
    //    rewrites would otherwise inflate RRF scores for whatever the
    //    duplicated retrieval happens to return.
    const dedup: RewrittenQuery[] = [];
    const seen = new Set<string>();
    for (const r of rewrites) {
      const key = r.text.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      dedup.push(r);
    }

    // 3. Run retrieval in parallel. A single variant failure must not
    //    poison the fusion — swallow per-list errors as empty lists.
    const retrievalResults = await Promise.all(
      dedup.map((r) => this.retrieve(r.text).catch((): RetrieveHit[] => [])),
    );

    // 4. Reciprocal Rank Fusion: each list contributes 1 / (k + rank) to
    //    a note's combined score. Rank is 1-based (rank+1 below — array
    //    index is 0-based). De-duplication of `sources` happens via Set.
    const rrfScores = new Map<string, { score: number; sources: Set<string> }>();
    retrievalResults.forEach((list, listIdx) => {
      const variantText = dedup[listIdx]!.text;
      list.forEach((hit, rank) => {
        const contribution = 1 / (rrfK + rank + 1);
        const cur = rrfScores.get(hit.noteId);
        if (cur) {
          cur.score += contribution;
          cur.sources.add(variantText);
        } else {
          rrfScores.set(hit.noteId, {
            score: contribution,
            sources: new Set<string>([variantText]),
          });
        }
      });
    });

    // 5. Sort by fused score descending, cap at topK.
    const fused: RagFusionHit[] = [...rrfScores.entries()]
      .map(([noteId, v]) => ({
        noteId,
        score: v.score,
        sources: [...v.sources],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    const result: RagFusionResult = {
      rewrites: dedup,
      fused,
      durationMs: Date.now() - start,
    };
    if (degraded) result.degraded = true;
    return result;
  }
}
