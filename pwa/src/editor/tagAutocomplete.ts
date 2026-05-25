import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { api } from "../api.js";

/**
 * Tag-Autocomplete — Obsidian-Style `#tag`.
 *
 * Tippe `#` am Wort-Anfang (Zeilen-Start oder nach Whitespace) und ein
 * Fuzzy-Match-Menü aller bekannten Tags erscheint. Enter inserted den
 * Tag-Namen (ohne führendes `#`, da das bereits getippt ist) + ein
 * trailing space als Confirm-Marker.
 *
 * Tag-Liste wird gecached (30s TTL) — gleiches Pattern wie
 * `wikilinkAutocomplete.ts`. Auf Cache-Miss wird async geladen, danach
 * instant.
 */

interface TagEntry {
  tag: string;
  count: number;
}

const CACHE_TTL_MS = 30_000;
let cache: TagEntry[] | null = null;
let cacheAt = 0;
let inFlight: Promise<TagEntry[]> | null = null;

async function getTags(): Promise<TagEntry[]> {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const list = await api.listTags();
      cache = list.map((t) => ({ tag: t.tag, count: t.count }));
      cacheAt = Date.now();
      return cache;
    } catch {
      return cache ?? [];
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Eager prefetch — kick off the tag-list load so first `#` is instant. */
export function prefetchTags(): void {
  void getTags();
}

/** CM6 autocompletion source. Returns null if `#…` is not the trigger. */
export async function tagSource(
  ctx: CompletionContext,
): Promise<CompletionResult | null> {
  // Trigger nur, wenn `#` am Zeilen-Anfang oder nach Whitespace steht.
  // Erlaubt Buchstaben, Ziffern, Bindestrich, Unterstrich und Umlaute.
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = /(?:^|\s)#([\wÄÖÜäöüß-]*)$/.exec(before);
  if (!m) return null;

  const query = m[1];
  const tokenStart = ctx.pos - query.length;
  const tags = await getTags();

  // Fuzzy-rank: prefix=100, contains=50.
  const qLc = query.toLowerCase();
  const scored = tags
    .map((entry) => {
      const tLc = entry.tag.toLowerCase();
      let score = 0;
      if (qLc === "") score = 1;
      else if (tLc.startsWith(qLc)) score = 100;
      else if (tLc.includes(qLc)) score = 50;
      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-Breaker: häufiger benutzte Tags zuerst.
      return b.entry.count - a.entry.count;
    })
    .slice(0, 20);

  return {
    from: tokenStart,
    options: scored.map(({ entry }) => ({
      label: `#${entry.tag}`,
      detail: `${entry.count} note${entry.count === 1 ? "" : "s"}`,
      apply: `${entry.tag} `,
    })),
    validFor: /^[\wÄÖÜäöüß-]*$/,
  };
}
