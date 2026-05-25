import type { LlmRouter } from "./router.js";
import { LlmCapabilityMissing } from "./errors.js";
import { getScoring } from "../scoring/store.js";

/**
 * Phase B Wave B2 / Story 1 — Reranker-Service mit Importance-Boost.
 *
 * Zweite Retrieval-Stufe nach Hybrid (BM25 + Dense + RRF):
 *  1. Cross-Encoder / LLM-judge bewertet die Top-N Hits (z.B. Top-25) neu.
 *  2. Multipliziert mit der eigenen Note-Importance — eigene Notes mit hoher
 *     viewCount/editCount/backlinks-Aktivität werden gegenüber importierten
 *     Captures geboostet, low-importance Notes leicht gedämpft.
 *  3. Sortiert nach Final-Score, gibt Top-K (Default 5) zurück.
 *
 * Provider hinter `rerank`-Rolle ist Routing-Config (Cohere | LocalReranker).
 * Importance kommt aus `note_scoring.importanceScore` (Phase A Wave A1 / Story 1).
 *
 * Boost-Formel:
 *   mult = 1 + importanceWeight * (importance - 0.5) * 2
 *   final = rerankScore * mult
 *
 * Verhalten (für `importanceWeight = 0.3`):
 *   importance 1.0 (Top-Note) → mult = 1.30 → +30%
 *   importance 0.75           → mult = 1.15 → +15%
 *   importance 0.5 (neutral)  → mult = 1.00 → unverändert
 *   importance 0.25           → mult = 0.85 → -15%
 *   importance 0.0 (kalt)     → mult = 0.70 → -30%
 *
 * Symmetrisch um 0.5 — neutrale Notes verzerren nicht, extreme schon. Mit
 * `applyImportanceBoost=false` ist mult immer 1.0 (für Vergleichs-Evals).
 */

import type { LlmProvider } from "./types.js";

export interface RerankInput {
  /** Vault-Note-Id, used to look up the importance score. */
  noteId: string;
  /** Text the reranker scores against the query — typically anchored chunk
   *  text, or title + first paragraph for note-level reranking. */
  text: string;
  /** Optional base score from the initial hybrid retrieval. Echoed back, not
   *  used in the combined score (rerank replaces it entirely). */
  baseScore?: number;
}

export interface RerankedHit {
  noteId: string;
  /** Raw score from the reranker provider, normalised to [0, 1]. */
  rerankScore: number;
  /** Importance multiplier applied (1.0 if boost disabled). */
  importanceMultiplier: number;
  /** Final score = `rerankScore * importanceMultiplier`. */
  finalScore: number;
  /** Index into the original `inputs` array. */
  originalIndex: number;
  /** Echo of `RerankInput.baseScore` so callers can compare delta vs hybrid. */
  baseScore?: number;
}

export interface RerankServiceOptions {
  /** Final result size (default 5). */
  topN?: number;
  /** Apply per-note importance boost (default true). */
  applyImportanceBoost?: boolean;
  /** Boost strength: 0 = ignore, 1.0 = pure importance overlay (default 0.3). */
  importanceWeight?: number;
}

export class RerankerService {
  constructor(private router: LlmRouter) {}

  async rerank(
    query: string,
    inputs: RerankInput[],
    opts: RerankServiceOptions = {},
  ): Promise<RerankedHit[]> {
    const topN = opts.topN ?? 5;
    const importanceWeight = opts.importanceWeight ?? 0.3;
    const apply = opts.applyImportanceBoost !== false;

    if (inputs.length === 0) return [];

    // 1. Score every input via the configured rerank provider. We ask for
    //    `topN: inputs.length` so we get a score for every doc; the final
    //    slice happens AFTER the importance multiplier is applied.
    const provider: LlmProvider = this.router.getProvider("rerank");
    if (!provider.rerank) {
      throw new LlmCapabilityMissing(provider.info.name, "rerank");
    }
    const result = await provider.rerank(
      query,
      inputs.map((i) => i.text),
      { topN: inputs.length },
    );

    // 2. Optionally look up importance scores. Failures here are non-fatal —
    //    we fall back to a neutral 0.5 so a missing scoring row never breaks
    //    retrieval. Promise.all is OK: getScoring is a single indexed
    //    db.select per call, no fan-out problem at Top-25.
    const importanceMap = new Map<string, number>();
    if (apply) {
      await Promise.all(
        inputs.map(async (inp) => {
          try {
            const s = await getScoring(inp.noteId);
            importanceMap.set(inp.noteId, s?.importanceScore ?? 0.5);
          } catch {
            importanceMap.set(inp.noteId, 0.5);
          }
        }),
      );
    }

    // 3. Combine scores. Skip ranking entries whose `index` is out of range
    //    (defensive; shouldn't happen but Cohere has been known to return
    //    `index: -1` for filtered docs in past API versions).
    const hits: RerankedHit[] = [];
    for (const r of result.rankings) {
      const input = inputs[r.index];
      if (!input) continue;
      const importance = importanceMap.get(input.noteId) ?? 0.5;
      const mult = apply ? 1 + importanceWeight * (importance - 0.5) * 2 : 1;
      hits.push({
        noteId: input.noteId,
        rerankScore: r.score,
        importanceMultiplier: mult,
        finalScore: r.score * mult,
        originalIndex: r.index,
        baseScore: input.baseScore,
      });
    }

    // 4. Final sort by combined score, slice topN.
    hits.sort((a, b) => b.finalScore - a.finalScore);
    return hits.slice(0, topN);
  }
}
