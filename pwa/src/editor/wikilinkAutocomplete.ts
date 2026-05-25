import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { api } from "../api.js";

/**
 * Wikilink-Autocomplete — Obsidian-Style.
 *
 * Tippe `[[` und ein Fuzzy-Match-Menü aller Note-Titles erscheint.
 * Enter inserted `[[Title]]` und positioniert Cursor dahinter.
 *
 * Note-Liste wird gecached (30s TTL) damit nicht jeder Tastendruck eine
 * API-Roundtrip auslöst. Cache wird async refreshed — beim ersten `[[`
 * werden notes geladen (fast, weil server-side index), danach instant.
 */

interface NoteRef {
  id: string;
  title: string;
  /** Obsidian-style alternative names from `aliases: [Foo, Bar]` frontmatter. */
  aliases: string[];
}

const CACHE_TTL_MS = 30_000;
let cache: NoteRef[] | null = null;
let cacheAt = 0;
let inFlight: Promise<NoteRef[]> | null = null;

async function getNotes(): Promise<NoteRef[]> {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const list = await api.listNotes();
      cache = list.map((n) => ({
        id: n.id,
        title: n.title,
        // Defensive: backward-compat with servers that haven't shipped the
        // alias field yet (older builds, offline-queue stubs).
        aliases: Array.isArray(n.aliases) ? n.aliases : [],
      }));
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

/** Basename of an id ("10_projects/foo/bar" → "bar"), lowercased. */
function basenameOf(id: string): string {
  const slash = id.lastIndexOf("/");
  return (slash === -1 ? id : id.slice(slash + 1)).toLowerCase();
}

/** External helper for the wikilink-decoration extension to query existence. */
export function isKnownWikilinkTarget(targetLowercase: string): boolean {
  if (!cache) return true; // optimistic: not loaded yet — don't flag
  return cache.some(
    (n) =>
      n.title.toLowerCase() === targetLowercase ||
      n.aliases.some((a) => a.toLowerCase() === targetLowercase) ||
      basenameOf(n.id) === targetLowercase ||
      n.id.toLowerCase() === targetLowercase,
  );
}

/**
 * Resolve a wikilink target (title, alias, basename, OR full id;
 * case-insensitive) to the canonical { id, title } pair of the owning note.
 * Returns null if the target is unknown or the note-list cache hasn't
 * loaded yet — callers should fall back to passing the raw target to the
 * API (works when target already IS an id).
 *
 * Resolution priority — title > alias > basename > full-id — mirrors
 * `buildGraph()` in `@lokyy/core`, so the PWA preview and the server-built
 * graph agree. Basename match is first-write-wins on conflicts.
 */
export function resolveWikilinkTarget(
  target: string,
): { id: string; title: string } | null {
  if (!cache) return null;
  const lc = target.toLowerCase();
  const byTitle = cache.find((n) => n.title.toLowerCase() === lc);
  if (byTitle) return { id: byTitle.id, title: byTitle.title };
  const byAlias = cache.find((n) =>
    n.aliases.some((a) => a.toLowerCase() === lc),
  );
  if (byAlias) return { id: byAlias.id, title: byAlias.title };
  const byBase = cache.find((n) => basenameOf(n.id) === lc);
  if (byBase) return { id: byBase.id, title: byBase.title };
  const byId = cache.find((n) => n.id.toLowerCase() === lc);
  if (byId) return { id: byId.id, title: byId.title };
  return null;
}

/** Eager prefetch — kick off the note-list load so first `[[` is instant. */
export function prefetchWikilinkTargets(): void {
  void getNotes();
}

/** CM6 autocompletion source. Returns null if `[[` is not the trigger. */
export async function wikilinkSource(
  ctx: CompletionContext,
): Promise<CompletionResult | null> {
  // Match `[[<query>` with the query NOT yet closed by `]]`.
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = /\[\[([^\]\n|]*)$/.exec(before);
  if (!m) return null;

  const query = m[1];
  const tokenStart = ctx.pos - query.length;
  const notes = await getNotes();

  /**
   * Build the candidate set: one row per title PLUS one row per alias.
   * The owning note is carried through both so `detail` can always show
   * the resolved title and the inserted literal stays the user-chosen
   * label.
   */
  interface Candidate {
    /** What the user sees in the menu. Title for title-rows, alias for alias-rows, basename for base-rows. */
    label: string;
    /** Literal text inserted into the wikilink (`[[<insertCore>]]`). */
    insertCore: string;
    /** Right-column detail string. Alias/basename rows show context. */
    detail: string;
    /** Score for fuzzy ranking. */
    score: number;
    /** Tie-breaker: title (0) > alias (1) > basename (2) for the same note. */
    kind: 0 | 1 | 2;
    /** Owning note id, used to dedupe and as a stable key. */
    noteId: string;
  }

  const qLc = query.toLowerCase();

  function rank(text: string): number {
    const tLc = text.toLowerCase();
    if (qLc === "") return 1; // empty query shows everything
    if (tLc.startsWith(qLc)) return 100;
    if (tLc.includes(qLc)) return 60;
    return 0;
  }

  const candidates: Candidate[] = [];
  for (const n of notes) {
    // Title row
    const titleScore = rank(n.title);
    const idScore = qLc === "" ? 0 : n.id.toLowerCase().includes(qLc) ? 30 : 0;
    const tScore = Math.max(titleScore, idScore);
    if (tScore > 0) {
      candidates.push({
        label: n.title,
        insertCore: n.title,
        detail: n.id,
        score: tScore,
        kind: 0,
        noteId: n.id,
      });
    }
    // Alias rows — one per alias, ranked the same way as titles.
    const titleLc = n.title.toLowerCase();
    for (const alias of n.aliases) {
      // Suppress aliases that just re-state the title (case-insensitive)
      // so the menu doesn't show duplicate rows for the same note.
      if (alias.toLowerCase() === titleLc) continue;
      const aScore = rank(alias);
      if (aScore > 0) {
        candidates.push({
          label: alias,
          insertCore: alias,
          detail: `→ ${n.title}`,
          score: aScore,
          kind: 1,
          noteId: n.id,
        });
      }
    }
    // Basename row — `[[my-note]]` style, when basename differs from title.
    // Lets Obsidian/Roam-style id writing surface in autocomplete even
    // though the visible title is something else (e.g. "Task: Coolify …").
    const baseLc = basenameOf(n.id);
    if (baseLc && baseLc !== titleLc) {
      const bScore = rank(baseLc);
      if (bScore > 0) {
        candidates.push({
          label: baseLc,
          insertCore: baseLc,
          detail: `by basename: ${n.title}`,
          score: bScore,
          kind: 2,
          noteId: n.id,
        });
      }
    }
  }

  const scored = candidates
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.kind - b.kind ||
        a.label.localeCompare(b.label),
    )
    .slice(0, 20);

  return {
    from: tokenStart,
    options: scored.map((c) => ({
      label: c.label,
      detail: c.detail,
      apply: (view, _completion, from, to) => {
        // If user already has `]]` right after the query, replace through them.
        // Otherwise add closing brackets ourselves.
        const after = view.state.sliceDoc(to, to + 2);
        const insertCore = c.insertCore;
        const insert = after === "]]" ? insertCore : `${insertCore}]]`;
        const finalTo = after === "]]" ? to + 2 : to;
        view.dispatch({
          changes: { from, to: finalTo, insert },
          selection: { anchor: from + insertCore.length + 2 }, // after the closing ]]
        });
      },
    })),
    validFor: /^[^\]\n|]*$/,
  };
}
