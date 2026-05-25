import { IntentClassifier, type QueryIntent } from "../llm/intent.js";
import { RagFusion } from "../llm/ragFusion.js";
import { SelfRagReflector, type ReflectionDecision } from "../llm/selfRag.js";
import { RerankerService, type RerankedHit } from "../llm/reranker.js";
import {
  buildLayoutedPrompt,
  layoutToMessages,
  type ContextChunk,
} from "../llm/contextLayout.js";
import { hybridSearch } from "../memory/hybrid.js";
import {
  personalizedPageRank,
  seedsFromRrfHits,
} from "../graph/ppr.js";
import { workingMemory } from "../scoring/workingMemory.js";
import {
  applyContextBoost,
  type QueryContext,
  type ScoredHit as EncodingScoredHit,
} from "../scoring/encodingContext.js";
// Re-export QueryContext so consumers can `import type { QueryContext } from
// "@lokyy/core"` via the pipeline barrel.
export type { QueryContext };
import { LlmRouter } from "../llm/router.js";
import { getLlmRouting } from "../llm/configStore.js";
import type { ChatMessage } from "../llm/types.js";
import { parseFrontmatter } from "../frontmatter/index.js";

/**
 * Phase B Wave B3 / Story 2 — End-to-End Retrieval-Pipeline Orchestrator.
 *
 * Wires the eight stages of the lokyy-brain cognitive retrieval loop:
 *   1. Conversational query rewrite (history → self-contained query)
 *   2. Intent classification (exact_recall | topical | associative | question)
 *   3. First-stage retrieval — intent-routed: question → RAG-Fusion,
 *      everything else → plain hybrid (BM25 + Dense + RRF)
 *   4. Personalized PageRank (associative-intent only) — spreading activation
 *      over the wikilink graph
 *   5. Encoding-Context-Match boost (Tulving 1973 — uses the optional
 *      Wave B3 / Story 1 `applyContextBoost` if present; degrades to no-op)
 *   6. Re-ranking (bge-reranker-v2-m3 or fallback) with importance multiplier
 *   7. Lost-in-the-Middle layout (Liu et al. 2023) — strongest evidence at
 *      head + tail, weak evidence buried in the middle
 *   8. Generation with Self-RAG-style prompt-level reflection. Reflection
 *      decides whether to issue another retrieval hop with a refined query
 *      (capped at `maxRetrievalHops`).
 *
 * Working-memory boost (Baddeley & Hitch 1974 in retrieval clothing) is
 * applied after Step 3, before Step 4 — the recently-touched notes get a
 * decaying additive nudge so what the user just looked at floats up.
 *
 * Error policy: NEVER throws to the caller. Every step is wrapped in
 * try/catch — failures append a string to `degraded[]` and the next step
 * sees the previous step's last good output. This matches the rest of
 * the LLM layer (e.g. RagFusion.fuse, SelfRagReflector.reflect).
 *
 * Pure composition: no underlying primitive (intent, hybrid, ppr,
 * reranker, selfRag, contextLayout) is altered. The orchestrator just
 * sequences them and threads telemetry.
 */

// ─── Public types ───────────────────────────────────────────────────────────

export interface SearchPipelineInput {
  query: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  sessionId?: string;
  /** Query-side encoding context for the Tulving Story-1 boost. */
  sessionContext?: QueryContext;
  /** When true, execute Steps 7 + 8 (layout + LLM synthesis). */
  generate?: boolean;
  /** Force a specific intent — skips Step 2. Useful for explicit-mode UI. */
  forceIntent?: QueryIntent;
  /** Max hops in the Self-RAG reflection loop (incl. initial generation). Default 3. */
  maxRetrievalHops?: number;
  /** Restrict retrieval to one vault (multi-tenant correctness). Optional. */
  vaultId?: string;
}

export interface PipelineStepTrace {
  step: number;
  name: string;
  durationMs: number;
  notes?: string;
  hitCount?: number;
}

export interface SearchPipelineResult {
  query: string;
  /** Self-contained query after Step 1 (== input.query when no history). */
  rewrittenQuery: string;
  intent: QueryIntent;
  /** Number of generation passes (1 = initial only; >1 = reflection loops). */
  hops: number;
  totalDurationMs: number;
  steps: PipelineStepTrace[];
  rerankedHits: RerankedHit[];
  generation?: {
    text: string;
    citedNoteIds: string[];
    reflection?: ReflectionDecision;
  };
  /** Soft-failure flags. Empty array means every step ran cleanly. */
  degraded: string[];
}

// ─── Internal scoring shape ─────────────────────────────────────────────────

interface ScoredHit {
  noteId: string;
  score: number;
}

/**
 * The Story-1 `EncodingScoredHit` already carries `noteId`, `score`,
 * optional `encoded` and `folder`. We use it directly as the shape
 * threaded between Step 4 (PPR fuse) → Step 5 (encoding-context boost).
 */
type EnrichedHit = EncodingScoredHit;

// ─── Pipeline ───────────────────────────────────────────────────────────────

export class SearchPipeline {
  private intentClassifier: IntentClassifier;
  private ragFusion: RagFusion;
  private reranker: RerankerService;
  private selfRag: SelfRagReflector;
  private router: LlmRouter;

  constructor(router: LlmRouter) {
    this.router = router;
    this.intentClassifier = new IntentClassifier(router);
    this.selfRag = new SelfRagReflector(router);
    this.reranker = new RerankerService(router);
    // RagFusion needs a retrieve-fn — wrap hybridSearch so each variant
    // round-trips through BM25+Dense+RRF.
    this.ragFusion = new RagFusion(router, async (q) => {
      const embedding = await this.embedQuery(q);
      const hits = await hybridSearch(q, embedding, { topK: 50 });
      return hits.map((h) => ({ noteId: h.noteId, score: h.score }));
    });
  }

  async execute(input: SearchPipelineInput): Promise<SearchPipelineResult> {
    const start = Date.now();
    const steps: PipelineStepTrace[] = [];
    const degraded: string[] = [];
    const vaultId = input.vaultId;

    // ─── STEP 1 — Conversational Rewrite ───────────────────────────────
    let rewrittenQuery = input.query;
    if (input.conversationHistory?.length) {
      const s1 = Date.now();
      try {
        rewrittenQuery = await this.rewriteWithHistory(
          input.query,
          input.conversationHistory,
        );
      } catch {
        degraded.push("conversational_rewrite_failed");
      }
      steps.push({
        step: 1,
        name: "conversational-rewrite",
        durationMs: Date.now() - s1,
      });
    }

    // ─── STEP 2 — Intent Classification ────────────────────────────────
    const s2 = Date.now();
    let intent: QueryIntent;
    if (input.forceIntent) {
      intent = input.forceIntent;
    } else {
      try {
        const res = await this.intentClassifier.classify(rewrittenQuery);
        intent = res.intent;
      } catch {
        degraded.push("intent_classification_failed");
        intent = "topical";
      }
    }
    steps.push({
      step: 2,
      name: "intent-classification",
      durationMs: Date.now() - s2,
      notes: intent,
    });

    // ─── STEP 3 — First-Stage Retrieval ────────────────────────────────
    const s3 = Date.now();
    let firstStage: ScoredHit[] = [];

    if (intent === "question") {
      // Question intent → RAG-Fusion (LLM rewrite × N + RRF). HyDE is
      // available via the LLM layer but RAG-Fusion empirically beats it
      // on multi-hop questions (Microsoft 2023, +7pp F1 on HotPotQA).
      try {
        const fused = await this.ragFusion.fuse(rewrittenQuery, {
          numRewrites: 3,
        });
        firstStage = fused.fused.map((f) => ({
          noteId: f.noteId,
          score: f.score,
        }));
        if (fused.degraded) degraded.push("rag_fusion_degraded");
      } catch {
        degraded.push("rag_fusion_failed");
        firstStage = await this.runHybrid(rewrittenQuery, vaultId, degraded);
      }
    } else {
      // exact_recall, topical, associative → plain hybrid. The HybridOpts
      // `intent` field is reserved for the α-weighting story; we pass it
      // through so the SQL layer can act on it when ready.
      firstStage = await this.runHybrid(rewrittenQuery, vaultId, degraded, intent);
    }
    steps.push({
      step: 3,
      name: "hybrid-retrieval",
      durationMs: Date.now() - s3,
      hitCount: firstStage.length,
    });

    // Working-Memory boost (post-Step 3, pre-Step 4). Additive on score,
    // re-sort, never throws — singleton is in-process.
    if (input.sessionId && firstStage.length > 0) {
      try {
        const wm = workingMemory();
        const boosts = wm.getBoosts(
          firstStage.map((h) => h.noteId),
          input.sessionId,
        );
        if (boosts.length > 0) {
          const boostMap = new Map(boosts.map((b) => [b.noteId, b.boost]));
          firstStage = firstStage
            .map((h) => ({
              ...h,
              score: h.score + (boostMap.get(h.noteId) ?? 0),
            }))
            .sort((a, b) => b.score - a.score);
        }
      } catch {
        degraded.push("working_memory_boost_failed");
      }
    }

    // ─── STEP 4 — Spreading Activation (PPR) — associative only ────────
    let expanded: ScoredHit[] = firstStage;
    if (intent === "associative" && firstStage.length > 0) {
      const s4 = Date.now();
      try {
        const seeds = seedsFromRrfHits(firstStage.slice(0, 20));
        const pprHits = await personalizedPageRank(seeds, {
          topK: 50,
          damping: 0.5,
        });
        // Fuse PPR + first-stage via RRF k=60 so the PPR-only "associative
        // shoulder" of the graph doesn't crowd out the direct semantic hits.
        expanded = this.rrfFuse(
          [
            firstStage,
            pprHits.map((h) => ({ noteId: h.noteId, score: h.score })),
          ],
          60,
        ).slice(0, 50);
      } catch {
        degraded.push("ppr_failed");
      }
      steps.push({
        step: 4,
        name: "spreading-activation-ppr",
        durationMs: Date.now() - s4,
        hitCount: expanded.length,
      });
    }

    // ─── STEP 5 — Encoding-Context-Match Boost (Tulving 1973) ──────────
    if (input.sessionContext && expanded.length > 0) {
      const s5 = Date.now();
      try {
        const enriched = await this.enrichWithEncoded(expanded);
        const boosted = applyContextBoost(enriched, input.sessionContext);
        // `applyContextBoost` already returns the list sorted by
        // boostedScore desc; we drop the per-hit ContextMatchResult here
        // since downstream stages only need (noteId, score).
        expanded = boosted.map((b) => ({
          noteId: b.noteId,
          score: b.boostedScore,
        }));
      } catch {
        degraded.push("encoding_context_boost_failed");
      }
      steps.push({
        step: 5,
        name: "encoding-context-boost",
        durationMs: Date.now() - s5,
      });
    }

    // ─── STEP 6 — Re-Ranking ───────────────────────────────────────────
    const s6 = Date.now();
    let rerankedHits: RerankedHit[];
    if (expanded.length === 0) {
      // Empty-retrieval short-circuit: nothing to rerank. Skip the LLM
      // call entirely — saves ~1s of provider round-trip.
      rerankedHits = [];
      degraded.push("empty_retrieval");
    } else {
      try {
        const top25 = expanded.slice(0, 25);
        const rerankInputs = await Promise.all(
          top25.map(async (h) => ({
            noteId: h.noteId,
            text: await this.fetchNoteText(h.noteId),
            baseScore: h.score,
          })),
        );
        // Drop empty-body inputs — the reranker would just score them low
        // and waste a slot in the LLM context.
        const usable = rerankInputs.filter((r) => r.text.trim().length > 0);
        if (usable.length === 0) {
          rerankedHits = [];
          degraded.push("rerank_no_usable_text");
        } else {
          rerankedHits = await this.reranker.rerank(rewrittenQuery, usable, {
            topN: 5,
          });
        }
      } catch {
        degraded.push("rerank_failed");
        // Fallback: synthesise RerankedHits from the top-5 first-stage scores.
        rerankedHits = expanded.slice(0, 5).map((h, i) => ({
          noteId: h.noteId,
          rerankScore: h.score,
          importanceMultiplier: 1,
          finalScore: h.score,
          originalIndex: i,
          baseScore: h.score,
        }));
      }
    }
    steps.push({
      step: 6,
      name: "rerank",
      durationMs: Date.now() - s6,
      hitCount: rerankedHits.length,
    });

    // Record retrievals into working-memory AFTER the final ranking. This
    // is the "you just touched these" signal for the next query's Step 3.
    if (input.sessionId && rerankedHits.length > 0) {
      try {
        const wm = workingMemory();
        for (const h of rerankedHits) wm.record(h.noteId, input.sessionId);
      } catch {
        degraded.push("working_memory_record_failed");
      }
    }

    // ─── STEPS 7+8 — Layout + Generate (only if generate=true) ─────────
    let generation: SearchPipelineResult["generation"];
    let hops = 1;
    if (input.generate && rerankedHits.length > 0) {
      const s7 = Date.now();
      let chunks: ContextChunk[] = [];
      try {
        chunks = await Promise.all(
          rerankedHits.map(async (h) => ({
            noteId: h.noteId,
            chunkId: h.noteId,
            title: await this.fetchTitle(h.noteId),
            text: await this.fetchNoteText(h.noteId),
            score: h.finalScore,
          })),
        );
      } catch {
        degraded.push("layout_fetch_failed");
      }
      const layout = buildLayoutedPrompt(rewrittenQuery, chunks, {
        maxChunks: 5,
        queryInjectionMode: "sandwich",
      });
      const messages = layoutToMessages(layout);
      steps.push({
        step: 7,
        name: "lost-in-middle-layout",
        durationMs: Date.now() - s7,
        hitCount: layout.arrangedChunks.length,
      });

      const s8 = Date.now();
      const maxHops = Math.max(1, input.maxRetrievalHops ?? 3);
      let answer = "";
      const citedNoteIds: string[] = rerankedHits.map((h) => h.noteId);
      let lastReflection: ReflectionDecision | undefined;

      try {
        const provider = this.router.getProvider("topic-synthesis");
        if (!provider.chat) {
          degraded.push("no_chat_provider_for_synthesis");
        } else {
          const result = await provider.chat(messages, { maxTokens: 800 });
          answer = result.text;

          // Self-RAG reflection loop — `hops` already counts the initial pass.
          // We can issue at most `maxHops - 1` extra hops.
          let workingChunks = [...chunks];
          for (let hop = 1; hop < maxHops; hop++) {
            const reflection = await this.selfRag.reflect(
              rewrittenQuery,
              answer,
              workingChunks.length,
            );
            lastReflection = reflection;
            if (!reflection.needMoreRetrieval || !reflection.refinedQuery) {
              break;
            }
            // Sub-retrieval is direct hybrid only — no recursion through
            // the full pipeline. Keeps cost bounded (no RAG-Fusion ×3,
            // no PPR, no rerank). The refined query already has narrower
            // intent than the original, so a single hybrid pass suffices.
            let subHits: Awaited<ReturnType<typeof hybridSearch>> = [];
            try {
              const subEmbed = await this.embedQuery(reflection.refinedQuery);
              subHits = await hybridSearch(reflection.refinedQuery, subEmbed, {
                topK: 5,
                ...(vaultId ? { vaultId } : {}),
              });
            } catch {
              degraded.push(`subhop_${hop}_retrieval_failed`);
              break;
            }
            if (subHits.length === 0) break;
            const subChunks: ContextChunk[] = await Promise.all(
              subHits.map(async (h) => ({
                noteId: h.noteId,
                chunkId: h.noteId,
                title: await this.fetchTitle(h.noteId),
                text: await this.fetchNoteText(h.noteId),
                score: h.score,
              })),
            );
            workingChunks = [...workingChunks, ...subChunks];
            const subLayout = buildLayoutedPrompt(
              rewrittenQuery,
              workingChunks,
              { maxChunks: 7, queryInjectionMode: "sandwich" },
            );
            try {
              const subResult = await provider.chat(
                layoutToMessages(subLayout),
                { maxTokens: 800 },
              );
              answer = subResult.text;
            } catch {
              degraded.push(`subhop_${hop}_generate_failed`);
              break;
            }
            for (const h of subHits) {
              if (!citedNoteIds.includes(h.noteId)) citedNoteIds.push(h.noteId);
            }
            hops++;
          }
        }
      } catch {
        degraded.push("synthesis_failed");
      }

      generation = {
        text: answer,
        citedNoteIds,
        ...(lastReflection ? { reflection: lastReflection } : {}),
      };
      steps.push({
        step: 8,
        name: "generate-with-reflection",
        durationMs: Date.now() - s8,
        hitCount: hops,
      });
    } else if (input.generate && rerankedHits.length === 0) {
      // generate=true but nothing to ground in. Emit an explicit empty
      // generation so the caller can render an "I don't know" fallback
      // without re-checking rerankedHits.length.
      generation = { text: "", citedNoteIds: [] };
      degraded.push("generate_skipped_empty_retrieval");
    }

    return {
      query: input.query,
      rewrittenQuery,
      intent,
      hops,
      totalDurationMs: Date.now() - start,
      steps,
      rerankedHits,
      ...(generation ? { generation } : {}),
      degraded,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────

  private async runHybrid(
    query: string,
    vaultId: string | undefined,
    degraded: string[],
    intent?: QueryIntent,
  ): Promise<ScoredHit[]> {
    let embedding: number[];
    try {
      embedding = await this.embedQuery(query);
    } catch {
      // Zero-vector — dense leg contributes no useful signal but BM25 still
      // works. Mirrors the policy in server/src/routes/search.ts.
      embedding = new Array<number>(768).fill(0);
      degraded.push("embedding_unavailable");
    }
    try {
      const hits = await hybridSearch(query, embedding, {
        topK: 50,
        ...(vaultId ? { vaultId } : {}),
        ...(intent ? { intent } : {}),
      });
      return hits.map((h) => ({ noteId: h.noteId, score: h.score }));
    } catch {
      degraded.push("hybrid_failed");
      return [];
    }
  }

  private async embedQuery(query: string): Promise<number[]> {
    const provider = this.router.getProvider("embedding");
    if (!provider.embeddings) {
      throw new Error("embedding provider has no embeddings capability");
    }
    const result = await provider.embeddings([query]);
    const v = result.vectors[0];
    if (!v) throw new Error("embedding provider returned empty result");
    return v;
  }

  private async rewriteWithHistory(
    query: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<string> {
    const provider = this.router.getProvider("query-rewrite");
    if (!provider.chat) return query;
    // Keep only the last 4 turns — most pronoun resolution targets sit
    // within the recent context, and a long history dilutes the rewrite.
    const historyText = history
      .slice(-4)
      .map((h) => `${h.role}: ${h.content}`)
      .join("\n");
    const prompt =
      `Rewrite the user query as a self-contained question, resolving pronouns ` +
      `and implicit references using the conversation history. Return ONE line, ` +
      `no preamble.\n\nHistory:\n${historyText}\n\nQuery: ${query}\n\n` +
      `Self-contained query:`;
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];
    const result = await provider.chat(messages, {
      maxTokens: 120,
      temperature: 0.1,
    });
    const rewritten = result.text.trim();
    return rewritten.length > 0 ? rewritten : query;
  }

  private async fetchNoteText(noteId: string): Promise<string> {
    // Lazy import to avoid loading filesystem code at module-eval time.
    const { getNote } = await import("../notes/notesService.js");
    try {
      const note = await getNote(noteId);
      if (!note) return "";
      // Strip frontmatter — the body that ships to the reranker / LLM
      // should be the markdown content, not the YAML header.
      const parsed = parseFrontmatter(note.body);
      return parsed.body;
    } catch {
      return "";
    }
  }

  private async fetchTitle(noteId: string): Promise<string> {
    const { getNote } = await import("../notes/notesService.js");
    try {
      const note = await getNote(noteId);
      return note?.title ?? noteId;
    } catch {
      return noteId;
    }
  }

  /**
   * Pull `encoded:` from each hit's frontmatter for the Step-5 boost.
   * Failures are swallowed per-note (returned without `encoded`); the
   * matcher treats the absence as "no boost" — same policy as Story 1.
   */
  private async enrichWithEncoded(hits: ScoredHit[]): Promise<EnrichedHit[]> {
    const { getNote } = await import("../notes/notesService.js");
    return await Promise.all(
      hits.map(async (h): Promise<EnrichedHit> => {
        const folder = h.noteId.includes("/")
          ? h.noteId.slice(0, h.noteId.lastIndexOf("/"))
          : "";
        try {
          const note = await getNote(h.noteId);
          if (!note) return { ...h, folder };
          const parsed = parseFrontmatter(note.body);
          const encoded = parsed.data.encoded;
          return encoded
            ? { ...h, folder, encoded }
            : { ...h, folder };
        } catch {
          return { ...h, folder };
        }
      }),
    );
  }

  /**
   * Reciprocal Rank Fusion (k-default 60) — same primitive used by the
   * hybrid SQL CTE and RagFusion. Lists arrive in rank-order (best first);
   * each contributes `1 / (k + rank)` to the combined score.
   */
  private rrfFuse(lists: ScoredHit[][], k: number): ScoredHit[] {
    const fused = new Map<string, number>();
    for (const list of lists) {
      list.forEach((h, rank) => {
        const cur = fused.get(h.noteId) ?? 0;
        fused.set(h.noteId, cur + 1 / (k + rank + 1));
      });
    }
    return [...fused.entries()]
      .map(([noteId, score]) => ({ noteId, score }))
      .sort((a, b) => b.score - a.score);
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Build a SearchPipeline using the persisted LLM routing config. Use this
 * from route handlers — caches nothing, so each call sees the latest
 * routing config.
 */
export async function buildSearchPipeline(): Promise<SearchPipeline> {
  const routing = await getLlmRouting();
  const router = new LlmRouter(routing);
  return new SearchPipeline(router);
}
