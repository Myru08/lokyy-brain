/**
 * Phase A Wave A2 / Stories 5+6 — Late Chunking + Multi-Chunk-Embedding.
 *
 * Decomposes a note into a small fan-out of chunks that get embedded
 * separately. Every chunk is prefixed with an "anchor" — the note title
 * plus the heading breadcrumb — before embedding, because on personal
 * vaults the title often carries more semantic signal than any individual
 * paragraph. Anchor-Text-Injection is a large retrieval-quality win that
 * we apply unconditionally.
 *
 * Chunk types (in emission order):
 *   - title         : the title alone, self-anchored
 *   - body_full     : the entire body, but ONLY when it fits inside the
 *                     long-context token budget (default 1920 tokens — the
 *                     model's real 2048-token window minus anchor headroom).
 *                     This is the "structural late chunking" leg — the
 *                     full document context lives inside one embedding,
 *                     so retrieval against it preserves long-range coref.
 *   - section       : one row per heading (H1/H2/H3) with body, anchored
 *                     by the heading breadcrumb (e.g. "H1 > H2 > H3").
 *                     A section larger than the model's context window is
 *                     split into several budget-sized rows.
 *   - sliding_3para : 3-paragraph windows inside sections that have at
 *                     least 5 paragraphs — gives fine-grained passages
 *                     for question-style queries.
 *
 * Edge cases handled by parseSections:
 *   - No headings at all : one synthetic section spanning the whole body,
 *                          title=note title, breadcrumb=[] — keeps the
 *                          fan-out non-empty.
 *   - Out-of-order levels (H3 before H2): breadcrumb stack trims to the
 *                          deepest still-open level, so siblings get a
 *                          flat path and nested children get nested paths.
 *   - Empty section bodies: skipped (no point embedding a heading alone).
 */

import { createHash } from "node:crypto";

export type ChunkType = "title" | "body_full" | "section" | "sliding_3para";

export interface Chunk {
  chunkType: ChunkType;
  chunkIdx: number;
  /** Raw text — what the chunk actually contains, no anchor prefix. */
  text: string;
  /** Anchor-prefixed text — what gets passed to the embedder. */
  anchored: string;
  /** SHA-256 prefix (32 hex chars) of `anchored` — for incremental skip. */
  hash: string;
  /** Heading breadcrumb in display form, e.g. "Goals > 2026 > Q3". */
  breadcrumb: string;
}

export interface ChunkOptions {
  title: string;
  /** Markdown body WITHOUT frontmatter. */
  body: string;
  /** Token budget above which body_full is skipped. Default 1920. */
  maxBodyFullTokens?: number;
  /**
   * Hard per-chunk ceiling applied to the ANCHORED text of every chunk type.
   * Default {@link EMBED_MODEL_CONTEXT_TOKENS}. Lower it when swapping in a
   * model with a smaller window.
   */
  maxChunkTokens?: number;
}

const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Real context window of the configured embedding model (Story 5.8 AC#3).
 *
 * Verified against the deployed model, not assumed:
 *   `ollama show nomic-embed-text` → `context length 2048`, and an
 *   over-long prompt to `/api/embeddings` returns
 *   `HTTP 500 {"error":"the input length exceeds the context length"}`.
 *
 * Anything above this is rejected by Ollama, so no chunk may exceed it AFTER
 * the anchor prefix is prepended.
 */
export const EMBED_MODEL_CONTEXT_TOKENS = 2048;

/**
 * Headroom reserved for the anchor prefix (title + heading breadcrumb) that
 * `buildAnchor` prepends before embedding. `body_full` is gated on the RAW
 * body, so its budget must stay below the window by at least this much; the
 * per-chunk cap below then bounds the final anchored string exactly.
 */
const ANCHOR_HEADROOM_TOKENS = 128;

const DEFAULT_MAX_BODY_FULL_TOKENS =
  EMBED_MODEL_CONTEXT_TOKENS - ANCHOR_HEADROOM_TOKENS;
export { DEFAULT_MAX_BODY_FULL_TOKENS };

const SLIDING_PARAGRAPH_WINDOW = 3;
const SLIDING_MIN_PARAGRAPHS = 5;

/**
 * Cheap upper-bound estimate. Real BPE tokenizers vary by 20-30%, so we
 * default to ~4 chars/token which is conservative for English+German
 * mixed content. The body_full gate only needs to reject obviously-too-
 * large notes, not be perfectly accurate.
 */
export function approximateTokens(s: string): number {
  return Math.ceil(s.length / APPROX_CHARS_PER_TOKEN);
}

/** SHA-256 hex hash, truncated to 32 chars (128 bits — collision-safe). */
export function hashChunk(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

interface Section {
  /** 1 for H1, 2 for H2, 3 for H3, … */
  level: number;
  /** Heading text. For the no-heading synthetic section, the note title. */
  title: string;
  /** Parent heading titles, root-to-immediate-parent. */
  breadcrumb: string[];
  /** Body lines between this heading and the next same-or-shallower one. */
  body: string;
}

/**
 * Walk the markdown body line by line, splitting on ATX headings (`# …`
 * through `###### …`). Maintains a breadcrumb stack so each section knows
 * its ancestors.
 *
 * Handling of edge cases:
 *   - No headings: yields one synthetic section level=0, breadcrumb=[].
 *   - First heading is H3 (level skip): stack is empty so breadcrumb=[];
 *     subsequent H2 doesn't become a child of that H3 because we trim
 *     the stack to ancestors strictly above the new heading's level.
 *   - Code fences containing `#` chars: NOT excluded; H-detection is
 *     intentionally simple (line-anchored ATX regex). Personal vaults
 *     occasionally have shell prompts in fences — we accept the false
 *     positives rather than complicate the parser.
 */
function parseSections(body: string): Section[] {
  const sections: Section[] = [];
  const lines = body.split("\n");
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;

  // `stack` holds the open headings (titles only) at each level.
  const stack: { level: number; title: string }[] = [];
  let current: Section | null = null;

  const flush = (): void => {
    if (current && current.body.trim().length > 0) {
      sections.push({ ...current, body: current.body.replace(/\n+$/, "") });
    }
    current = null;
  };

  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      flush();
      const level = m[1]!.length;
      const title = m[2]!.trim();
      // Trim the stack to ancestors strictly shallower than `level`.
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }
      const breadcrumb = stack.map((s) => s.title);
      stack.push({ level, title });
      current = { level, title, breadcrumb, body: "" };
    } else {
      if (current === null) {
        // Lines before the first heading become a synthetic "prelude"
        // section. If no headings appear at all, this is the entire body.
        current = { level: 0, title: "", breadcrumb: [], body: "" };
      }
      current.body += line + "\n";
    }
  }
  flush();

  return sections;
}

/** Build the anchor-prefixed text that actually gets embedded. */
function buildAnchor(
  title: string,
  breadcrumb: string[],
  text: string,
): string {
  const bcParts = breadcrumb.filter((b) => b.length > 0);
  const bc = bcParts.length > 0 ? bcParts.join(" > ") : "";
  return `${title}${bc ? "\n" + bc : ""}\n\n${text}`;
}

/**
 * Character budget left for a chunk's raw text once its anchor prefix is
 * accounted for. `approximateTokens` is `ceil(len / 4)`, so bounding the
 * anchored string's LENGTH bounds its token estimate exactly.
 */
function textBudgetChars(
  title: string,
  breadcrumb: string[],
  maxChunkTokens: number,
): number {
  const prefixLen = buildAnchor(title, breadcrumb, "").length;
  return Math.max(1, maxChunkTokens * APPROX_CHARS_PER_TOKEN - prefixLen);
}

/**
 * Split text that exceeds `budgetChars` into pieces that fit (Story 5.8 AC#4).
 *
 * Oversized sections are SPLIT rather than skipped: dropping them would erase
 * a long note from the semantic index entirely (its `body_full` is already
 * over budget, and a section with <5 paragraphs emits no sliding windows
 * either — the note would be findable by title alone).
 *
 * Packing is paragraph-greedy so pieces stay semantically coherent; a single
 * paragraph that is itself too large is hard-split on character boundaries as
 * the last resort. Text at or under budget is returned untouched, so the
 * chunk hashes of every normal note are unchanged by this gate — no mass
 * re-embedding on deploy.
 */
function splitToBudget(text: string, budgetChars: number): string[] {
  if (text.length <= budgetChars) return [text];

  const pieces: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.trim().length > 0) pieces.push(current.trim());
    current = "";
  };

  for (const raw of text.split(/\n\s*\n/)) {
    const para = raw.trim();
    if (para.length === 0) continue;
    if (para.length > budgetChars) {
      flush();
      for (let i = 0; i < para.length; i += budgetChars) {
        pieces.push(para.slice(i, i + budgetChars));
      }
      continue;
    }
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (candidate.length > budgetChars) {
      flush();
      current = para;
    } else {
      current = candidate;
    }
  }
  flush();

  return pieces.length > 0 ? pieces : [text.slice(0, budgetChars)];
}

/**
 * Main entry — turn a note into a fan-out of chunks ready to embed.
 *
 * Determinism: same inputs ⇒ same chunk list (same order, same hashes).
 * This is critical for the hash-skip path — the indexer must be able to
 * recompute a chunk's hash and find an exact match in `note_embeddings`.
 */
export function chunkNote(opts: ChunkOptions): Chunk[] {
  const title = opts.title;
  const body = opts.body;
  const maxBodyFull = opts.maxBodyFullTokens ?? DEFAULT_MAX_BODY_FULL_TOKENS;
  const maxChunkTokens = opts.maxChunkTokens ?? EMBED_MODEL_CONTEXT_TOKENS;
  const chunks: Chunk[] = [];

  // 1. Title chunk — always emitted, even for empty bodies.
  const titleAnchored = buildAnchor(title, [], title);
  chunks.push({
    chunkType: "title",
    chunkIdx: 0,
    text: title,
    anchored: titleAnchored,
    hash: hashChunk(titleAnchored),
    breadcrumb: "",
  });

  // Empty body short-circuits the rest.
  if (body.trim().length === 0) return chunks;

  // 2. body_full chunk — only when the body fits BOTH the long-context budget
  //    and the hard per-chunk cap once anchored (Story 5.8 AC#3).
  const bodyFullBudget = Math.min(
    maxBodyFull * APPROX_CHARS_PER_TOKEN,
    textBudgetChars(title, [], maxChunkTokens),
  );
  if (body.length <= bodyFullBudget) {
    const anchored = buildAnchor(title, [], body);
    chunks.push({
      chunkType: "body_full",
      chunkIdx: 0,
      text: body,
      anchored,
      hash: hashChunk(anchored),
      breadcrumb: "",
    });
  }

  // 3. Section chunks — one per heading. parseSections handles the
  // no-heading case by returning a single synthetic prelude section.
  const sections = parseSections(body);
  let sectionIdx = 0;
  let slidingIdx = 0;

  for (const sec of sections) {
    if (sec.body.trim().length === 0) continue;

    // Build the heading path used for both the anchor and the displayable
    // `breadcrumb` field. For the synthetic prelude (level=0, title=""),
    // path stays empty.
    const headingPath =
      sec.title.length > 0 ? [...sec.breadcrumb, sec.title] : sec.breadcrumb;
    const breadcrumbStr = headingPath.join(" > ");

    // Story 5.8 AC#4: a section longer than the model window is split into
    // budget-sized pieces instead of being emitted whole (which Ollama would
    // reject with "input length exceeds the context length").
    const budget = textBudgetChars(title, headingPath, maxChunkTokens);
    for (const piece of splitToBudget(sec.body, budget)) {
      const sectionAnchored = buildAnchor(title, headingPath, piece);
      chunks.push({
        chunkType: "section",
        chunkIdx: sectionIdx++,
        text: piece,
        anchored: sectionAnchored,
        hash: hashChunk(sectionAnchored),
        breadcrumb: breadcrumbStr,
      });
    }

    // 4. sliding_3para — only for "substantial" sections. Paragraph split
    // is on blank lines (markdown convention). Window size 3, stride 1.
    const paragraphs = sec.body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (paragraphs.length >= SLIDING_MIN_PARAGRAPHS) {
      for (
        let i = 0;
        i <= paragraphs.length - SLIDING_PARAGRAPH_WINDOW;
        i++
      ) {
        const slice = paragraphs
          .slice(i, i + SLIDING_PARAGRAPH_WINDOW)
          .join("\n\n");
        // Story 5.8 AC#4: an over-budget window is skipped rather than split —
        // unlike a section, its content is already covered by the section
        // chunks above, so splitting it would only add redundant embeddings.
        if (slice.length > budget) continue;
        const slidingAnchored = buildAnchor(title, headingPath, slice);
        chunks.push({
          chunkType: "sliding_3para",
          chunkIdx: slidingIdx++,
          text: slice,
          anchored: slidingAnchored,
          hash: hashChunk(slidingAnchored),
          breadcrumb: breadcrumbStr,
        });
      }
    }
  }

  return chunks;
}
