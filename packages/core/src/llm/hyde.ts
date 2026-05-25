import type { LlmRouter } from "./router.js";
import type { ChatMessage } from "./types.js";

/**
 * HyDE — Hypothetical Document Embedding (Gao et al., ACL 2023, arXiv:2212.10496).
 *
 * Rather than embedding the raw query, we ask an LLM to write a *hypothetical
 * answer* and embed that. The hypothetical doc lives in the same semantic
 * neighbourhood as real corpus documents, so cosine-sim against pgvector
 * yields better recall (paper reports +14-37% on zero-shot retrieval).
 *
 * Use only for `intent === "question"` queries (see `intent.ts`). For
 * `exact_recall` or `topical` it would dilute the signal — the user already
 * told us what they want.
 *
 * Routing: `LlmRouter.getProvider("hyde")` returns the chat provider; the
 * embeddings come from the `embedding` role (must be the SAME model used to
 * index the corpus — otherwise cosine-sim is meaningless across spaces).
 *
 * Multi-HyDE (`numHypothetical > 1`): generate N independent hypotheticals
 * at non-zero temperature, embed each, then mean-pool the vectors. This
 * follows the paper's §5 multi-sample variant and trades latency for a more
 * stable centroid. Single-sample is the default — N=1 is what the paper
 * reports across all main benchmarks (Table 2) and what costs one chat call
 * instead of N. Bump to 3-5 when you can afford the latency and the user
 * intent is broad enough that any single hypothesis would be off-centre.
 *
 * Mean-pool note: averaging is correct *direction-wise* when the vectors
 * are similar (which is the only case where pooling helps anyway). It does
 * NOT preserve unit-norm — the magnitude shrinks toward the centroid.
 * pgvector cosine-distance normalises internally, so callers using
 * `<=>` get correct cosine. Callers comparing via dot product on a
 * non-normalised index should re-normalise (`v / ||v||`) before use.
 */

export interface HyDEOptions {
  /** Number of hypothetical docs to generate (default 1; >1 = multi-HyDE) */
  numHypothetical?: number;
  /** Domain hint to make hypothetical more realistic (e.g. "personal notes") */
  domainHint?: string;
  /** Max tokens per hypothetical */
  maxTokens?: number;
}

export interface HyDEResult {
  /** Generated hypothetical documents, one per LLM call. */
  hypotheticalDocs: string[];
  /** Per-doc embeddings. `embeddings[i]` is the vector for `hypotheticalDocs[i]`. */
  embeddings: number[][];
  /** Mean-pooled centroid across all hypothetical embeddings. */
  fusedEmbedding: number[];
  /** Original user query (echoed for trace/log convenience). */
  query: string;
  /** Total wall-clock time including chat + embed roundtrips. */
  durationMs: number;
}

const PROMPT = `Write a concise, factual paragraph that would directly answer the following question.
Imagine it as content from a personal knowledge base. Use 3-5 sentences. No preamble. No meta-commentary.

Domain: {{DOMAIN}}

Question: {{QUERY}}

Answer:`;

const DEFAULT_DOMAIN =
  "personal knowledge base notes (meetings, decisions, projects, captures, daily notes)";

export class HyDE {
  constructor(private router: LlmRouter) {}

  async expand(query: string, opts: HyDEOptions = {}): Promise<HyDEResult> {
    const start = Date.now();
    const num = Math.max(1, opts.numHypothetical ?? 1);
    const domain = opts.domainHint ?? DEFAULT_DOMAIN;
    const maxTokens = opts.maxTokens ?? 250;

    // 1. Generate N hypothetical docs via the "hyde" chat role.
    const chatProvider = this.router.getProvider("hyde");
    if (!chatProvider.chat) {
      throw new Error("hyde provider has no chat capability");
    }

    const hypotheticals: string[] = [];
    for (let i = 0; i < num; i++) {
      const prompt = PROMPT.replace("{{DOMAIN}}", domain).replace(
        "{{QUERY}}",
        query,
      );
      const messages: ChatMessage[] = [{ role: "user", content: prompt }];
      const result = await chatProvider.chat(messages, {
        maxTokens,
        // 0.7 gives the variance needed for multi-HyDE without losing factuality.
        temperature: 0.7,
      });
      hypotheticals.push(result.text.trim());
    }

    // 2. Embed all hypotheticals via the embedding-role provider. Must match
    //    the model used to index the corpus — the router enforces this via
    //    the "embedding" role mapping.
    const embedProvider = this.router.getProvider("embedding");
    if (!embedProvider.embeddings) {
      throw new Error("embedding provider has no embeddings capability");
    }
    const embedResult = await embedProvider.embeddings(hypotheticals);
    const embeddings = embedResult.vectors;

    // 3. Mean-pool across hypotheticals for the fused centroid.
    const dim = embeddings[0]?.length ?? 0;
    const fused = new Array<number>(dim).fill(0);
    for (const vec of embeddings) {
      for (let i = 0; i < dim; i++) fused[i] += vec[i] ?? 0;
    }
    const divisor = Math.max(1, embeddings.length);
    for (let i = 0; i < dim; i++) fused[i] /= divisor;

    return {
      hypotheticalDocs: hypotheticals,
      embeddings,
      fusedEmbedding: fused,
      query,
      durationMs: Date.now() - start,
    };
  }
}
