import { listNotes, getNote } from "../notes/notesService.js";
import { parseLinks, parseTags, parseTitle } from "../graph/graphService.js";
import type { MemoryProvider, RelatedOpts, SearchHit, SearchOpts } from "./MemoryProvider.js";

/**
 * Tier 1 — structural index (Story 5.2).
 *
 * Pure in-memory inverted index over titles, body tokens, frontmatter tags
 * and wikilink targets. Rebuilds lazily on first query and after every
 * indexNote / removeNote. For 5k notes this stays well under 100ms p95
 * even rebuilt from scratch (no DB roundtrip).
 *
 * Tier 1 is the always-available fallback when Tier 2 (semantic) is
 * unreachable. The CombinedProvider in `index.ts` glues them together.
 */

interface IndexEntry {
  noteId: string;
  title: string;
  bodyLower: string;
  tags: Set<string>;
  links: Set<string>;
  folder: string;
}

let index: IndexEntry[] | null = null;

async function rebuild(): Promise<void> {
  const summaries = await listNotes();
  const entries: IndexEntry[] = [];
  for (const s of summaries) {
    const note = await getNote(s.id);
    if (!note) continue;
    entries.push({
      noteId: s.id,
      title: note.title,
      bodyLower: note.body.toLowerCase(),
      tags: new Set(parseTags(note.body)),
      links: new Set(parseLinks(note.body)),
      folder: s.id.includes("/") ? s.id.slice(0, s.id.lastIndexOf("/")) : "",
    });
  }
  index = entries;
}

async function ensure(): Promise<IndexEntry[]> {
  if (!index) await rebuild();
  return index ?? [];
}

function snippet(body: string, query: string, span = 80): string | undefined {
  if (!query) return undefined;
  const i = body.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return undefined;
  const start = Math.max(0, i - span / 2);
  const end = Math.min(body.length, i + query.length + span / 2);
  return (start > 0 ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
}

export class Tier1Provider implements MemoryProvider {
  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const entries = await ensure();
    const limit = opts.limit ?? 25;
    const fields = opts.fields ?? ["title", "body", "tags"];

    // Tokenize query — words ≥2 chars, lowercased, deduped, max 10 tokens.
    // Multi-token search: each token scored independently, scores summed.
    // This way "deploy coolify" returns notes matching either word.
    const tokens = [
      ...new Set(
        query
          .toLowerCase()
          .split(/[\s,;:!?]+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2),
      ),
    ].slice(0, 10);

    const hits: SearchHit[] = [];
    for (const e of entries) {
      if (opts.tagFilter && !opts.tagFilter.every((t) => e.tags.has(t))) continue;
      if (opts.folderPrefix && !e.noteId.startsWith(opts.folderPrefix)) continue;
      if (opts.wikilinkTarget && !e.links.has(opts.wikilinkTarget)) continue;

      let score = 0;
      let bestSnippetToken = "";
      if (tokens.length > 0) {
        const titleLc = e.title.toLowerCase();
        for (const tok of tokens) {
          if (fields.includes("title") && titleLc.includes(tok)) score += 10;
          if (fields.includes("body") && e.bodyLower.includes(tok)) {
            score += 3;
            if (!bestSnippetToken) bestSnippetToken = tok;
          }
          if (
            fields.includes("tags") &&
            [...e.tags].some((t) => t.toLowerCase().includes(tok))
          ) {
            score += 5;
          }
        }
        // Bonus: all-tokens-match-in-title is a strong signal
        if (
          fields.includes("title") &&
          tokens.every((tok) => titleLc.includes(tok))
        ) {
          score += 5;
        }
      } else {
        score = 1; // filter-only query, return all matching
      }

      if (score > 0) {
        hits.push({
          noteId: e.noteId,
          title: e.title,
          snippet: bestSnippetToken ? snippet(e.bodyLower, bestSnippetToken) : undefined,
          score,
          tier: "t1",
        });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async relatedNotes(noteId: string, opts: RelatedOpts = {}): Promise<SearchHit[]> {
    const entries = await ensure();
    const me = entries.find((e) => e.noteId === noteId);
    if (!me) return [];
    const limit = opts.limit ?? 5;
    // Structural relatedness: shared tags + shared wikilink targets + folder neighborhood.
    const hits: SearchHit[] = [];
    for (const e of entries) {
      if (e.noteId === noteId) continue;
      let score = 0;
      for (const t of e.tags) if (me.tags.has(t)) score += 2;
      for (const l of e.links) if (me.links.has(l)) score += 3;
      if (e.folder && e.folder === me.folder) score += 1;
      if (me.links.has(e.title)) score += 5;
      if (e.links.has(me.title)) score += 5;
      if (score > 0) {
        hits.push({ noteId: e.noteId, title: e.title, score, tier: "t1" });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async indexNote(_noteId: string): Promise<void> {
    index = null; // simplest correct path: rebuild on demand
  }

  async removeNote(_noteId: string): Promise<void> {
    index = null;
  }
}
