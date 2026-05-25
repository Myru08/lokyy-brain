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
 *                     long-context token budget (default 6000 tokens).
 *                     This is the "structural late chunking" leg — the
 *                     full document context lives inside one embedding,
 *                     so retrieval against it preserves long-range coref.
 *   - section       : one row per heading (H1/H2/H3) with body, anchored
 *                     by the heading breadcrumb (e.g. "H1 > H2 > H3").
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
  /** Token budget above which body_full is skipped. Default 6000. */
  maxBodyFullTokens?: number;
}

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_BODY_FULL_TOKENS = 6000;
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

  // 2. body_full chunk — only when the body fits the long-context budget.
  if (approximateTokens(body) <= maxBodyFull) {
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

    const sectionAnchored = buildAnchor(title, headingPath, sec.body);
    chunks.push({
      chunkType: "section",
      chunkIdx: sectionIdx++,
      text: sec.body,
      anchored: sectionAnchored,
      hash: hashChunk(sectionAnchored),
      breadcrumb: breadcrumbStr,
    });

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
