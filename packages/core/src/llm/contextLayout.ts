/**
 * Lost-in-the-Middle Context-Layout — Phase B Wave B2 / Story 3.
 *
 * Pure functions for arranging ranked context chunks into an LLM prompt that
 * mitigates the "Lost in the Middle" effect (Liu et al. 2023, arXiv:2307.03172).
 *
 * Key empirical findings the layout exploits:
 *   1. LLM recall is U-shaped over context position: tokens near the START and
 *      END are recalled best; tokens in the MIDDLE are recalled worst.
 *      → Place the strongest evidence at position 0 and the second-strongest
 *        at position N-1; bury weaker chunks in the middle.
 *   2. Recall degrades non-linearly as context grows.
 *      → Compress aggressively: top 3–5 chunks instead of 20.
 *   3. Recall is higher when the question is repeated after the context.
 *      → "Query sandwich" — emit the query both before AND after the context.
 *
 * No state. No I/O. No LLM calls. Safe to call from any layer.
 */

import type { ChatMessage } from "./types.js";

// ─── Public types ───────────────────────────────────────────────────────────

export interface ContextChunk {
  noteId: string;
  chunkId?: string;
  title?: string;
  /** Raw chunk text or pre-anchored chunk body. */
  text: string;
  /** Higher = more relevant. Used for ranking only. */
  score: number;
}

export type QueryInjectionMode = "before" | "after" | "sandwich" | "none";

export interface ContextLayoutOptions {
  /** Cap on how many chunks survive compression. Default 5. */
  maxChunks?: number;
  /**
   * Where to inject the query relative to the context block.
   * Default `"sandwich"` (matches the lost-in-middle paper's mitigation).
   */
  queryInjectionMode?: QueryInjectionMode;
  /** Separator between rendered chunks. Default `"\n\n---\n\n"`. */
  separatorTemplate?: string;
  /**
   * Mustache-lite template for each chunk. Supported placeholders:
   *   `{noteId}`, `{title}`, `{text}`.
   * Default `"[{noteId}] {title}\n{text}"`.
   */
  chunkTemplate?: string;
}

export interface LayoutResult {
  systemMessage: string;
  userMessage: string;
  /** Chunks in their final prompt order (post lost-in-middle rearrangement). */
  arrangedChunks: ContextChunk[];
  /** Chunks dropped because they fell below `maxChunks`. */
  rejectedChunks: ContextChunk[];
  /**
   * chunkId → 0-based position in the final prompt's context block.
   * Only chunks that carried a `chunkId` are included.
   */
  positionMapping: Record<string, number>;
}

// ─── Default system prompt ──────────────────────────────────────────────────

const DEFAULT_SYSTEM_MESSAGE =
  "You are a knowledge-aware assistant. Use the provided context chunks " +
  "to answer the user's query. Cite chunk noteIds in [brackets] when " +
  "referencing facts. If the context doesn't contain enough information, " +
  "say so explicitly.";

// ─── Core arrangement ───────────────────────────────────────────────────────

/**
 * Apply Lost-in-the-Middle positioning to a ranked chunk list.
 *
 * Re-arrangement for N chunks (best = rank 0):
 *   N=1 → [r0]
 *   N=2 → [r0, r1]
 *   N=3 → [r0, r2, r1]
 *   N=4 → [r0, r2, r3, r1]
 *   N=5 → [r0, r2, r4, r3, r1]
 *
 * Algorithm in words:
 *   - Best chunk at the start (position 0).
 *   - Second-best chunk at the end (position N-1).
 *   - Remaining chunks (rank 2, 3, …) fill inward from both ends so the
 *     WEAKEST evidence sits in the center, where the LLM is least likely
 *     to attend to it.
 *
 * Pure: never mutates the input.
 */
export function lostInMiddleArrange<T extends { score: number }>(
  chunks: readonly T[],
): T[] {
  if (chunks.length === 0) return [];
  if (chunks.length === 1) return [chunks[0]!];

  const sorted = [...chunks].sort((a, b) => b.score - a.score);

  if (sorted.length === 2) return sorted;

  const result: T[] = new Array(sorted.length);
  result[0] = sorted[0]!;
  result[sorted.length - 1] = sorted[1]!;

  // Fill the middle. Remaining ranks (2, 3, 4, …) alternate left/right:
  //   rank 2 → just after the head        (position 1)
  //   rank 3 → just before the tail       (position N-2)
  //   rank 4 → next inward from the left  (position 2)
  //   rank 5 → next inward from the right (position N-3)
  //   …
  // This drives the WEAKEST chunks toward the geometric center, matching
  // the canonical sequence N=5 → [r0, r2, r4, r3, r1].
  let left = 1;
  let right = sorted.length - 2;
  let putLeft = true;
  for (let i = 2; i < sorted.length; i++) {
    if (putLeft) {
      result[left++] = sorted[i]!;
    } else {
      result[right--] = sorted[i]!;
    }
    putLeft = !putLeft;
  }
  return result;
}

// ─── Full prompt builder ────────────────────────────────────────────────────

/**
 * Build a complete LLM prompt with lost-in-middle layout + query-sandwich.
 *
 * Pure. Caller is responsible for token-budget pre-truncation of chunk text.
 */
export function buildLayoutedPrompt(
  query: string,
  chunks: readonly ContextChunk[],
  opts: ContextLayoutOptions = {},
): LayoutResult {
  const maxChunks = opts.maxChunks ?? 5;
  const queryMode: QueryInjectionMode = opts.queryInjectionMode ?? "sandwich";
  const separator = opts.separatorTemplate ?? "\n\n---\n\n";
  const chunkTemplate = opts.chunkTemplate ?? "[{noteId}] {title}\n{text}";

  // 1. Compress — keep only the top `maxChunks` by score.
  const sortedByScore = [...chunks].sort((a, b) => b.score - a.score);
  const kept = sortedByScore.slice(0, Math.max(0, maxChunks));
  const rejected = sortedByScore.slice(Math.max(0, maxChunks));

  // 2. Lost-in-middle re-arrangement.
  const arranged = lostInMiddleArrange(kept);

  // 3. Position mapping (chunkId → final index).
  const positionMapping: Record<string, number> = {};
  arranged.forEach((c, i) => {
    if (c.chunkId) positionMapping[c.chunkId] = i;
  });

  // 4. Render the context block.
  const renderedChunks = arranged
    .map((c) => renderChunk(chunkTemplate, c))
    .join(separator);

  // 5. Apply query injection.
  const userMessage = applyQueryInjection(queryMode, query, renderedChunks);

  return {
    systemMessage: DEFAULT_SYSTEM_MESSAGE,
    userMessage,
    arrangedChunks: arranged,
    rejectedChunks: rejected,
    positionMapping,
  };
}

/** Convenience: convert a LayoutResult into a ChatMessage[] suitable for `provider.chat()`. */
export function layoutToMessages(result: LayoutResult): ChatMessage[] {
  return [
    { role: "system", content: result.systemMessage },
    { role: "user", content: result.userMessage },
  ];
}

// ─── Internals ──────────────────────────────────────────────────────────────

function renderChunk(template: string, chunk: ContextChunk): string {
  return template
    .replace("{noteId}", chunk.noteId)
    .replace("{title}", chunk.title ?? "")
    .replace("{text}", chunk.text);
}

function applyQueryInjection(
  mode: QueryInjectionMode,
  query: string,
  renderedChunks: string,
): string {
  switch (mode) {
    case "before":
      return `Query: ${query}\n\n## Context\n${renderedChunks}`;
    case "after":
      return `## Context\n${renderedChunks}\n\nQuery: ${query}`;
    case "sandwich":
      return (
        `Query: ${query}\n\n` +
        `## Context\n${renderedChunks}\n\n` +
        `## Reminder of query\n${query}`
      );
    case "none":
      return renderedChunks;
  }
}
