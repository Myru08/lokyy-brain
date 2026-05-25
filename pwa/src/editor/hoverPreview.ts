import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import { resolveWikilinkTarget } from "./wikilinkAutocomplete.js";
import { logTrace } from "../api.js";

/**
 * Wikilink-Hover-Preview — Obsidian-Style.
 *
 * Hover über `[[Note Title]]` → kleine Tooltip-Karte mit Titel + ersten ~150
 * Zeichen des Ziel-Note-Bodys. Mirror der Embed-Card aus `embedPreview.ts`,
 * aber als Hover-Tooltip statt Inline-Widget.
 *
 * Architektur-Notiz:
 *   - Wikilink-Matching ist deckungsgleich mit `wikilink.ts` (gleiche
 *     `[[target|alias?]]`-Form), nur dass wir die `pos`-enthaltende Range
 *     pro Hover-Aufruf einzeln finden — kein viewport-weiter Scan.
 *   - Fetch ist async; Widget-DOM lebt unabhängig vom CM-Render-Zyklus
 *     (gleiches Muster wie `EmbedWidget`).
 *   - Race-Schutz: pro Tooltip ein `cancelled`-Flag, das in `destroy()`
 *     gesetzt wird. Späte Fetch-Antworten schreiben dann nicht mehr ins
 *     DOM. In-Memory-Cache (60s TTL) hält wiederholte Hover instant.
 */

// `[[Ziel]]` oder `[[Ziel|Alias]]` — kein /g, wir prüfen die ganze Zeile.
const WIKILINK_LINE = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;

const PREVIEW_CHARS = 150;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  title: string;
  preview: string;
  fetchedAt: number;
}

const previewCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

/**
 * Entfernt einen führenden YAML-Frontmatter-Block (`---\n...\n---\n`).
 * Identisches Mini-Stripper-Muster wie in `embedPreview.ts`.
 */
function stripFrontmatter(body: string): string {
  return body.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, PREVIEW_CHARS)}…`;
}

async function fetchPreview(
  fetchKey: string,
  displayTitle: string,
): Promise<CacheEntry> {
  const cached = previewCache.get(fetchKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  // Coalesce parallel hovers auf dasselbe Ziel — kein doppelter Roundtrip.
  const pending = inFlight.get(fetchKey);
  if (pending) return pending;

  const promise = (async (): Promise<CacheEntry> => {
    const res = await fetch(`/api/notes/${encodeURIComponent(fetchKey)}`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const note = (await res.json()) as { body?: string; title?: string };
    const raw = note.body ?? "";
    const stripped = stripFrontmatter(raw);
    const entry: CacheEntry = {
      title: note.title ?? displayTitle,
      preview: truncate(stripped) || "(empty)",
      fetchedAt: Date.now(),
    };
    previewCache.set(fetchKey, entry);
    // Phase A Wave A1 / Story 3 — Retrieval-Trace-Log.
    // Logged only when an actual network fetch occurred (cache hits
    // skip this branch entirely), so the trace count tracks real
    // hover-driven retrieval, not idle re-hovers of the same target.
    logTrace({ noteId: fetchKey, source: "hover" });
    return entry;
  })();

  inFlight.set(fetchKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(fetchKey);
  }
}

interface WikilinkMatch {
  from: number;
  to: number;
  target: string;
}

/**
 * Sucht den `[[...]]`-Span, der `pos` enthält (auf der gleichen Zeile).
 * Gibt `null` zurück, wenn `pos` nicht innerhalb eines Wikilinks steht.
 */
function findWikilinkAt(view: EditorView, pos: number): WikilinkMatch | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  // Neue Regex-Instanz pro Aufruf — globale `lastIndex` ist sonst stateful.
  const regex = new RegExp(WIKILINK_LINE.source, "g");
  for (const m of text.matchAll(regex)) {
    const start = line.from + (m.index ?? 0);
    const end = start + m[0].length;
    if (pos >= start && pos <= end) {
      return { from: start, to: end, target: m[1].trim() };
    }
  }
  return null;
}

/**
 * Hover-Tooltip-Extension. Im `extensions`-Array des Editors zusammen mit
 * `hoverPreviewTheme` einhängen.
 */
export const wikilinkHoverExtension = hoverTooltip(
  (view: EditorView, pos: number, _side: -1 | 1): Tooltip | null => {
    const hit = findWikilinkAt(view, pos);
    if (!hit) return null;

    const target = hit.target;
    const resolved = resolveWikilinkTarget(target);
    const displayTitle = resolved?.title ?? target;
    const fetchKey = resolved?.id ?? target;

    return {
      pos: hit.from,
      end: hit.to,
      above: true,
      create: (_v: EditorView) => {
        const dom = document.createElement("div");
        dom.className = "cm-hover-preview";

        const titleEl = document.createElement("div");
        titleEl.className = "cm-hover-title";
        titleEl.textContent = displayTitle;
        dom.appendChild(titleEl);

        const body = document.createElement("div");
        body.className = "cm-hover-body";
        dom.appendChild(body);

        // Race-Guard: wenn der Tooltip schon weg ist, wenn der Fetch
        // landet, NICHT mehr ins DOM schreiben — sonst flackert ein
        // freshes Result über einen längst weggehoverten Link.
        let cancelled = false;

        // Wenn der Link gar nicht aufgelöst werden konnte UND auch kein
        // ID-Fallback möglich ist (resolveWikilinkTarget === null und der
        // Server ID-fallback funktioniert i.d.R. nur, wenn target === id),
        // versuchen wir's trotzdem — der Server akzeptiert beides. Bei
        // 404 zeigen wir "Unresolved link" statt "Note not found".
        const cached = previewCache.get(fetchKey);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          body.textContent = cached.preview;
          titleEl.textContent = cached.title;
        } else {
          body.textContent = "…loading…";
          void fetchPreview(fetchKey, displayTitle)
            .then((entry) => {
              if (cancelled) return;
              titleEl.textContent = entry.title;
              body.textContent = entry.preview;
            })
            .catch(() => {
              if (cancelled) return;
              // resolved === null → klar ein nicht-existentes Ziel.
              // resolved !== null aber Fetch fehlgeschlagen → "Not found".
              body.remove();
              const err = document.createElement("div");
              err.className = "cm-hover-error";
              err.textContent =
                resolved === null
                  ? "⚠ Unresolved link"
                  : "⚠ Note not found";
              dom.appendChild(err);
            });
        }

        return {
          dom,
          destroy: () => {
            cancelled = true;
          },
        };
      },
    };
  },
  {
    // Tooltip schließen, sobald der Doc sich ändert oder die Selection
    // wandert — sonst hängt eine veraltete Karte über frischen Edits.
    // Mouse-leave / out-of-range handhabt `hoverTooltip` selbst.
    hideOnChange: true,
    hoverTime: 300,
  },
);

/**
 * CSS-Theme für die Hover-Karte. Tokens entstammen `theme.ts`
 * (Terrakotta-Akzent, warmes Dunkel).
 */
export const hoverPreviewTheme = EditorView.theme({
  ".cm-hover-preview": {
    background: "#1A1F26",
    border: "1px solid #2A323D",
    borderRadius: "6px",
    padding: "10px 14px",
    maxWidth: "360px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    color: "#FFFFFF",
    fontFamily: "'Fraunces', Georgia, serif",
    fontSize: "14px",
    lineHeight: "1.5",
  },
  ".cm-hover-title": {
    fontWeight: "600",
    color: "#F97316",
    marginBottom: "6px",
    fontSize: "0.95em",
  },
  ".cm-hover-body": {
    color: "#8B9099",
    fontSize: "0.92em",
  },
  ".cm-hover-error": {
    color: "#EF4444",
    fontStyle: "italic",
  },
});
