/**
 * Story 7.12 Task 5 — the changelog excerpt arrives as RAW MARKDOWN.
 *
 * `GET /api/system/version` returns `highlights` exactly as they stand in the
 * live `CHANGELOG.md`, e.g.
 *
 *   "### Lokyy Brain ist jetzt Open Source"
 *   "- **Lizenz: AGPL-3.0.** Der Quellcode liegt öffentlich …"
 *
 * Dropping those strings into the banner verbatim shows literal `###` and `**`
 * to the user, which reads as a broken app. This module turns one raw line
 * into (a) its kind — a sub-heading or a bullet — and (b) inline tokens the
 * banner renders as real emphasis. No markdown library: the changelog uses a
 * handful of constructs and a 60-line tokenizer is cheaper than a dependency
 * in a bundle that already sits close to the 4 MiB precache limit.
 */

/** A sub-heading groups the bullets beneath it; an item is a single point. */
export type HighlightKind = "heading" | "item";

export interface Highlight {
  kind: HighlightKind;
  /** The line with its leading markdown marker removed. */
  text: string;
}

/** One inline run. `strong`/`em`/`code` carry emphasis; `text` is plain. */
export interface InlineToken {
  type: "text" | "strong" | "em" | "code";
  value: string;
}

const HEADING = /^#{1,6}\s+/;
const BULLET = /^[-*+]\s+/;
const ORDERED = /^\d+[.)]\s+/;

/**
 * Classify one raw changelog line and strip its leading marker.
 *
 * Anything that is not a heading is an item — including plain paragraphs,
 * which the changelog uses between bullet groups.
 */
export function parseHighlight(raw: unknown): Highlight {
  const line = typeof raw === "string" ? raw.trim() : "";
  if (HEADING.test(line)) {
    return { kind: "heading", text: line.replace(HEADING, "").trim() };
  }
  if (BULLET.test(line)) {
    return { kind: "item", text: line.replace(BULLET, "").trim() };
  }
  if (ORDERED.test(line)) {
    return { kind: "item", text: line.replace(ORDERED, "").trim() };
  }
  return { kind: "item", text: line };
}

/**
 * Inline constructs, in precedence order. `**` and `__` before their single
 * counterparts so `**bold**` is never read as an empty italic pair. Links
 * keep their label and drop the URL — the banner is not a place to send
 * someone off to GitHub mid-update.
 */
const INLINE =
  /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\([^)]*\)|\*([^*\s][^*]*)\*|(?<![A-Za-z0-9])_([^_\s][^_]*)_(?![A-Za-z0-9])/g;

/**
 * Remove markers that survived tokenizing — an unbalanced `**` at the end of a
 * truncated highlight (the server cuts items at 300 chars with an ellipsis) is
 * exactly the case that would otherwise leak asterisks into the UI.
 */
function stripStrayMarkers(text: string): string {
  return text.replace(/\*\*/g, "").replace(/`/g, "");
}

/** Split a line into plain and emphasized runs. Never returns empty runs. */
export function tokenizeInline(raw: unknown): InlineToken[] {
  const text = typeof raw === "string" ? raw : "";
  const tokens: InlineToken[] = [];
  let cursor = 0;

  const pushText = (value: string): void => {
    const cleaned = stripStrayMarkers(value);
    if (cleaned !== "") tokens.push({ type: "text", value: cleaned });
  };

  INLINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > cursor) pushText(text.slice(cursor, match.index));
    const [, strong, strongAlt, code, link, em, emAlt] = match;
    if (strong !== undefined || strongAlt !== undefined) {
      tokens.push({ type: "strong", value: (strong ?? strongAlt) as string });
    } else if (code !== undefined) {
      tokens.push({ type: "code", value: code });
    } else if (link !== undefined) {
      tokens.push({ type: "text", value: link });
    } else {
      tokens.push({ type: "em", value: (em ?? emAlt) as string });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) pushText(text.slice(cursor));

  return tokens;
}

/** Plain-text rendering of a highlight — for `title=` attributes and tests. */
export function highlightToPlainText(raw: unknown): string {
  return tokenizeInline(parseHighlight(raw).text)
    .map((t) => t.value)
    .join("");
}
