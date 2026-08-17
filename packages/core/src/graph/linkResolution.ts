import { isUlid } from "../notes/findByUlid.js";

/**
 * Wikilink-Auflösung — die EINE Stelle, an der entschieden wird, unter WELCHEN
 * Schreibweisen eine Notiz ansprechbar ist.
 *
 * Vorher lebte diese Regel in zwei Kopien nebeneinander (`buildGraph()` und
 * `findBrokenLinks()` in `graphService.ts`), plus einer dritten in der PWA
 * (`resolveWikilinkTarget()`). Drei Kopien derselben Regel driften
 * auseinander — und genau das ist passiert: das System vergibt einer Notiz
 * mehr Identitäten (ULID, Frontmatter-`title:`), als der Resolver kannte.
 * Folge: selbst erzeugte Links, die der Health-Check als „defekt" meldet,
 * obwohl das Ziel existiert.
 *
 * ── Auflösungsreihenfolge ──────────────────────────────────────────────────
 *   1. H1-Titel        (bzw. Dateiname, wenn keine H1 da ist)
 *   2. Alias           (frontmatter `aliases: [...]`)
 *   3. Basename        (`[[my-note]]` → irgendein `<ordner>/my-note.md`)
 *   4. Voll-ID         (Pfad ohne `.md`, exakt)
 *   5. Frontmatter-`title:`   ← NEU
 *   6. ULID            (frontmatter `id:`)   ← NEU
 *
 * Die beiden neuen Wege hängen bewusst HINTEN an: Schritt 1–4 sind
 * unverändert, also löst jeder Link, der vorher aufgelöst hat, weiterhin auf
 * dieselbe Notiz auf. Die neuen Wege greifen ausschließlich dort, wo vorher
 * gar nichts aufgelöst hat. Der Fix ist damit strikt additiv — er kann keine
 * bestehende Kante umbiegen, nur fehlende ergänzen.
 *
 * Vergessene Notizen (`forgotten`) kommen vom Aufrufer gar nicht erst in den
 * Index. Ein Link auf sie bleibt deshalb korrekt unauflösbar, auch über die
 * neuen Wege — die Cognee-`forget()`-Semantik bleibt unangetastet.
 */

/** Eine indexierbare Notiz. `id` ist der Pfad ohne `.md` (kanonische Identität). */
export interface ResolvableNote {
  /** Pfad ohne `.md` — kanonische Notiz-Identität im Graphen. */
  id: string;
  /** Angezeigter Titel: erste H1, sonst Dateiname. */
  title: string;
  /** Frontmatter `aliases: [...]`. */
  aliases: string[];
  /** Frontmatter `title:` — oft der einzige „echte" Titel bei Notizen ohne H1. */
  frontmatterTitle?: string;
  /** Frontmatter `id:` — die ULID, unter der `findByUlid()` die Notiz kennt. */
  ulid?: string;
}

/** Fertige Nachschlagetabellen. Alle Schlüssel sind lowercase (außer `byId`). */
export interface ResolutionIndex {
  byTitle: Map<string, string>;
  byAlias: Map<string, string>;
  byBasename: Map<string, string>;
  byFrontmatterTitle: Map<string, string>;
  byUlid: Map<string, string>;
  byId: Set<string>;
}

/** Basename einer Notiz-ID (`a/b/c` → `c`), lowercase. */
export function basenameOfId(id: string): string {
  return (id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id).toLowerCase();
}

/**
 * Index über alle auflösbaren Notizen bauen.
 *
 * First-write-wins bei Alias/Basename/Frontmatter-Titel, damit eine
 * deterministische Notiz den Namen besitzt, wenn zwei ihn beanspruchen.
 * `onBasenameConflict` meldet Doppeldeutigkeiten an den Aufrufer (buildGraph
 * loggt sie, findBrokenLinks nicht) — so bleibt dieses Modul frei von
 * Konsolen-Ausgaben.
 */
export function buildResolutionIndex(
  notes: Iterable<ResolvableNote>,
  onBasenameConflict?: (basename: string, kept: string, ignored: string) => void,
): ResolutionIndex {
  const index: ResolutionIndex = {
    byTitle: new Map(),
    byAlias: new Map(),
    byBasename: new Map(),
    byFrontmatterTitle: new Map(),
    byUlid: new Map(),
    byId: new Set(),
  };

  for (const n of notes) {
    index.byId.add(n.id);
    index.byTitle.set(n.title.toLowerCase(), n.id);

    for (const alias of n.aliases) {
      const key = alias.toLowerCase();
      if (!index.byAlias.has(key)) index.byAlias.set(key, n.id);
    }

    const basename = basenameOfId(n.id);
    const existing = index.byBasename.get(basename);
    if (existing === undefined) {
      index.byBasename.set(basename, n.id);
    } else if (existing !== n.id) {
      onBasenameConflict?.(basename, existing, n.id);
    }

    // Frontmatter-`title:` nur eintragen, wenn er etwas NEUES beisteuert —
    // deckt er sich mit der H1, ist der Weg über `byTitle` schon da.
    if (n.frontmatterTitle) {
      const key = n.frontmatterTitle.toLowerCase();
      if (key && !index.byFrontmatterTitle.has(key)) {
        index.byFrontmatterTitle.set(key, n.id);
      }
    }

    // ULIDs sind global eindeutig — eine Kollision hieße, zwei Notizen teilen
    // sich eine Identität. First-write-wins hält den Index in dem Fall stabil.
    if (n.ulid && isUlid(n.ulid) && !index.byUlid.has(n.ulid)) {
      index.byUlid.set(n.ulid, n.id);
    }
  }

  return index;
}

/**
 * Wikilink-Ziel auflösen. Liefert die Notiz-ID oder `null`, wenn der Link
 * auf nichts zeigt (= defekter Link).
 */
export function resolveWikilink(index: ResolutionIndex, link: string): string | null {
  const lc = link.toLowerCase();
  return (
    index.byTitle.get(lc) ??
    index.byAlias.get(lc) ??
    index.byBasename.get(lc) ??
    (index.byId.has(link) ? link : null) ??
    index.byFrontmatterTitle.get(lc) ??
    // ULIDs sind case-sensitiv (Crockford-base32, immer Großbuchstaben).
    index.byUlid.get(link) ??
    null
  );
}
