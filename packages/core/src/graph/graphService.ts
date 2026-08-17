import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { GraphData, GraphEdge, GraphNode } from "@lokyy/shared";
import { coreConfig } from "../util/coreConfig.js";
import { pull } from "../git/gitService.js";
import { parseFrontmatter } from "../frontmatter/index.js";
import { isForgotten } from "../frontmatter/types.js";
import {
  buildResolutionIndex,
  resolveWikilink,
  type ResolvableNote,
} from "./linkResolution.js";

/** Re-exports — used by backlinks() below to traverse the vault. */

/**
 * Graph-Service. Der Wissensgraph wird vollständig aus den .md-Dateien
 * abgeleitet — kein separater Index, keine DB. Bei ein paar tausend Notizen
 * ist das rechnerisch trivial.
 *
 * Die drei `parse*`-Funktionen sind bewusst klein und pur, damit der
 * Notes-Service sie mitbenutzen kann (DRY mit der Wikilink-Logik der PWA).
 */

const WIKILINK = /\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g;
const TAG = /(?:^|\s)#([\wÄÖÜäöüß][\wÄÖÜäöüß-]*)/g;
const H1 = /^#\s+(.+)$/m;
// Markdown link to a .md target (relative path, no http/https/mailto).
const MDLINK = /\[[^\]]*\]\(([^)\s]+\.md)\)/g;

/** [[Ziel]] und [[Ziel|Alias]] -> ["Ziel", ...], dedupliziert. */
export function parseLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(WIKILINK)) out.add(m[1].trim());
  return [...out];
}

/**
 * Markdown-style `.md`-Links: `[text](relativer/pfad.md)` — als Edge-Quelle.
 * Externe URLs (http/https/mailto/anchor) werden gefiltert. Backticks
 * werden vom Pfad gestrippt damit `[BRAND](\`BRAND.md\`)` auch klappt.
 */
export function parseMdLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MDLINK)) {
    let raw = m[1].trim().replace(/^`+|`+$/g, "");
    if (/^(https?:|mailto:|#)/i.test(raw)) continue;
    out.add(raw);
  }
  return [...out];
}

/** #tag -> ["tag", ...], dedupliziert, ohne Raute. */
export function parseTags(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(TAG)) out.add(m[1]);
  return [...out];
}

/**
 * Frontmatter `aliases: [Foo, "Bar Baz"]` -> ["Foo", "Bar Baz"], dedupliziert.
 * Leeres Array, wenn kein Frontmatter-Block existiert oder `aliases` fehlt.
 *
 * Bewusst klein gehalten — derselbe inline-Regex-Stil wie bei den
 * frontmatter-Tags in `listTags()`. Für komplexes YAML (block scalars,
 * nested) ist die Autorität nach wie vor gray-matter + die pre-commit
 * hook im Vault; hier reicht die obsidian-kompatible Inline-Form.
 */
export function parseAliases(body: string): string[] {
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(body);
  if (!fmMatch) return [];
  const line = /^aliases:\s*\[([^\]]*)\]/m.exec(fmMatch[1]);
  if (!line) return [];
  const out = new Set<string>();
  for (const part of line[1].split(",")) {
    const v = part.trim().replace(/^["']|["']$/g, "");
    if (v) out.add(v);
  }
  return [...out];
}

/** Titel = erste H1, sonst Dateiname ohne Endung. */
export function parseTitle(body: string, relPath: string): string {
  const h1 = body.match(H1);
  if (h1) return h1[1].trim();
  const base = relPath.split(sep).pop() ?? relPath;
  return base.replace(/\.md$/, "");
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

/**
 * Kompletten Graphen bauen. Wikilinks zeigen meist auf Titel — wir lösen
 * sowohl gegen Titel als auch gegen die id auf, damit beide Schreibweisen
 * funktionieren.
 *
 * Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive: notes whose
 * frontmatter has `forgotten: true` (or an ISO-timestamp string) are
 * skipped entirely. They produce neither a node nor an outgoing edge, and
 * incoming edges from non-forgotten notes pointing at them are dropped
 * via the `byId` membership check below. PPR/spreading-activation
 * therefore behaves as if forgotten notes never existed.
 */
export async function buildGraph(): Promise<GraphData> {
  await pull();
  const c = coreConfig();
  const files = await walk(c.vaultDir);

  const nodes: GraphNode[] = [];
  const resolvable: ResolvableNote[] = [];
  // links = wikilink-targets (titles or ids); mdLinks = relative .md paths
  const raw: { id: string; folder: string; links: string[]; mdLinks: string[] }[] = [];

  for (const abs of files) {
    const relPath = relative(c.vaultDir, abs).split(sep).join("/");
    const id = relPath.replace(/\.md$/, "");
    const folder = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
    const body = await readFile(abs, "utf8");

    // Cognee `forget()` — skip forgotten notes before they touch any lookup
    // map. Errors during frontmatter parse fall through as "not forgotten"
    // so a malformed file never silently disappears from the graph.
    let data: Record<string, unknown> = {};
    let forgotten = false;
    try {
      data = parseFrontmatter(body).data;
      forgotten = isForgotten(data);
    } catch {
      forgotten = false;
    }
    if (forgotten) continue;

    const title = parseTitle(body, relPath);
    nodes.push({ id, title, tags: parseTags(body) });
    resolvable.push({
      id,
      title,
      aliases: parseAliases(body),
      frontmatterTitle: typeof data.title === "string" ? data.title : undefined,
      ulid: typeof data.id === "string" ? data.id : undefined,
    });
    raw.push({ id, folder, links: parseLinks(body), mdLinks: parseMdLinks(body) });
  }

  // Basename-Konflikte werden geloggt, damit der Autor disambiguieren kann
  // (voller Pfad oder eindeutiger Titel).
  const index = buildResolutionIndex(resolvable, (basename, kept, ignored) => {
    console.warn(
      `[graphService] basename conflict for "${basename}": keeping "${kept}", ignoring "${ignored}"`,
    );
  });
  const { byBasename, byId } = index;

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  function addEdge(source: string, target: string) {
    if (target === source) return;
    const k = `${source}→${target}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ source, target });
  }

  for (const { id, folder, links, mdLinks } of raw) {
    // Wikilinks resolve via the shared index (title > alias > basename >
    // full-id > frontmatter-title > ULID). Die PWA spiegelt die ersten vier
    // Wege in `resolveWikilinkTarget()`; ihr fehlen mangels ULID/Frontmatter-
    // Titel im Notes-Cache noch die beiden neuen — Vorschau kann also weniger
    // auflösen als der Server, nie mehr.
    for (const link of links) {
      const target = resolveWikilink(index, link);
      if (target) addEdge(id, target);
    }
    // Markdown-Links: resolve relative path → note id, with basename
    // fallback so `[text](my-note.md)` resolves even when the .md sits in
    // a different folder than the linking note.
    for (const md of mdLinks) {
      const targetId = resolveMdLink(md, folder);
      if (targetId && byId.has(targetId)) {
        addEdge(id, targetId);
        continue;
      }
      // Strip path + extension, try basename map.
      const base = md.replace(/\.md$/, "");
      const baseName = (base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base).toLowerCase();
      const baseHit = byBasename.get(baseName);
      if (baseHit) addEdge(id, baseHit);
    }
  }

  return { nodes, edges };
}

/** Resolve `[text](../foo/bar.md)` relative to the linking note's folder. */
function resolveMdLink(href: string, fromFolder: string): string | null {
  if (!href.endsWith(".md")) return null;
  const stripped = href.replace(/\.md$/, "");
  // Normalise `./x`, `../x`, `foo/x` against the linking note's folder.
  const parts = fromFolder ? fromFolder.split("/") : [];
  for (const seg of stripped.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Backlinks für eine Notiz — welche anderen Notes verlinken auf diese?
 * Resolved via Titel UND id (wikilinks `[[Title]]` ODER `[[path/id]]`).
 * Liefert Backlink-Note mit kurzem context-Snippet rund um den link.
 */
export interface Backlink {
  noteId: string;
  title: string;
  context: string;
}

/**
 * Aggregate aller Tags im Vault — frontmatter `tags: [...]` UND inline `#tag`.
 * Sortiert nach count desc. Inkl. noteIds pro Tag (für Tag-Click-Filter).
 */
export interface TagSummary {
  tag: string;
  count: number;
  noteIds: string[];
}

export async function listTags(): Promise<TagSummary[]> {
  await pull();
  const c = coreConfig();
  const files = await walk(c.vaultDir);
  const tagMap = new Map<string, Set<string>>();
  for (const abs of files) {
    const relPath = relative(c.vaultDir, abs).split(sep).join("/");
    const id = relPath.replace(/\.md$/, "");
    const body = await readFile(abs, "utf8");
    // Inline #tag
    for (const t of parseTags(body)) {
      if (!tagMap.has(t)) tagMap.set(t, new Set());
      tagMap.get(t)!.add(id);
    }
    // Frontmatter tags: [foo, bar]
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(body);
    if (fmMatch) {
      const tagsLine = /^tags:\s*\[([^\]]*)\]/m.exec(fmMatch[1]);
      if (tagsLine) {
        const items = tagsLine[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        for (const t of items) {
          if (!tagMap.has(t)) tagMap.set(t, new Set());
          tagMap.get(t)!.add(id);
        }
      }
    }
  }
  return [...tagMap.entries()]
    .map(([tag, ids]) => ({ tag, count: ids.size, noteIds: [...ids] }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function backlinks(targetNoteId: string): Promise<Backlink[]> {
  await pull();
  const c = coreConfig();
  const files = await walk(c.vaultDir);

  // Resolve target's title once.
  let targetTitle = "";
  const targetAbs = files.find(
    (f) => relative(c.vaultDir, f).replace(/\.md$/, "").split(sep).join("/") === targetNoteId,
  );
  if (targetAbs) {
    const body = await readFile(targetAbs, "utf8");
    targetTitle = parseTitle(body, relative(c.vaultDir, targetAbs));
  }

  const out: Backlink[] = [];
  for (const abs of files) {
    const relPath = relative(c.vaultDir, abs).split(sep).join("/");
    const id = relPath.replace(/\.md$/, "");
    if (id === targetNoteId) continue;
    const body = await readFile(abs, "utf8");
    const links = parseLinks(body);
    const matches = links.some(
      (l) => l === targetNoteId || (targetTitle && l.toLowerCase() === targetTitle.toLowerCase()),
    );
    if (!matches) continue;

    const title = parseTitle(body, relPath);
    // grab first matching wikilink context (80 chars window)
    const wikilinkRe = new RegExp(
      `\\[\\[(${escapeRe(targetNoteId)}|${escapeRe(targetTitle)})(?:\\|[^\\]\\n]+)?\\]\\]`,
      "i",
    );
    const m = wikilinkRe.exec(body);
    let context = "";
    if (m) {
      const idx = m.index;
      const start = Math.max(0, idx - 40);
      const end = Math.min(body.length, idx + m[0].length + 40);
      context = (start > 0 ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
    }
    out.push({ noteId: id, title, context });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ein kaputter Wikilink: ein `[[ziel]]` in `sourceId`, dessen Ziel sich
 * NICHT auf eine existierende Notiz auflösen lässt.
 *
 * `linkText` ist das rohe Link-Ziel wie geschrieben (Titel, Basename oder
 * id — ohne `[[ ]]`, ohne Alias-Teil). `sourceTitle` ist der H1/Dateiname
 * der linkenden Notiz, damit der Aufrufer (MCP / UI) nicht nochmal
 * auflösen muss.
 */
export interface BrokenLink {
  sourceId: string;
  sourceTitle: string;
  linkText: string;
}

/**
 * Ordner, deren Dateien KEINE echten Notizen sind und deren ausgehende Links
 * daher nicht geprüft werden.
 *
 * `00_meta/templates/` enthält Vorlagen mit ABSICHTLICHEN Platzhaltern
 * (`[[Wikilink]]`, `[[ ]]`) — sie zeigen dem Autor, wo ein Link hingehört.
 * Als Link-ZIEL bleiben Vorlagen auflösbar (sie stehen weiter im Index);
 * ausgenommen ist nur ihre Rolle als Quelle.
 */
const LINK_AUDIT_EXEMPT_PREFIXES = ["00_meta/templates/"] as const;

/** Ist diese Notiz-ID von der Link-Prüfung als QUELLE ausgenommen? */
function isLinkAuditExempt(id: string): boolean {
  return LINK_AUDIT_EXEMPT_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Vault-weiter Scan: liefert jeden Wikilink, dessen Ziel ins Leere zeigt.
 *
 * Die Auflösung ist 1:1 dieselbe wie in {@link buildGraph} — beide teilen sich
 * dafür {@link buildResolutionIndex} / {@link resolveWikilink}, damit die
 * Regel nicht in zwei Kopien auseinanderlaufen kann. Ein Link ist genau dann
 * „kaputt“, wenn KEINER der Wege (Titel → Alias → Basename → id →
 * Frontmatter-`title:` → ULID) greift.
 *
 * `forgotten`-Notizen (Cognee `forget()`) sind weder Quelle (ihre Links
 * werden nicht geprüft) noch gültiges Ziel (sie kommen gar nicht erst in den
 * Index) — exakt wie der Graph sie behandelt. Vorlagen unter
 * `00_meta/templates/` sind als Quelle ausgenommen (s. o.). Markdown-`.md`-
 * Links sind nicht Teil dieses Checks; geprüft werden ausschließlich
 * Wikilinks (`[[ ]]`), wie in den Acceptance Criteria gefordert.
 */
export async function findBrokenLinks(): Promise<BrokenLink[]> {
  await pull();
  const c = coreConfig();
  const files = await walk(c.vaultDir);

  // ── Pass 1: derselbe Index, den auch buildGraph benutzt ─────────────────
  // forgotten notes never enter the index, so a link pointing at one is
  // (correctly) reported as broken.
  const resolvable: ResolvableNote[] = [];
  // Sources we still need to scan: id, title, and its wikilink targets.
  const sources: { id: string; title: string; links: string[] }[] = [];

  for (const abs of files) {
    const relPath = relative(c.vaultDir, abs).split(sep).join("/");
    const id = relPath.replace(/\.md$/, "");
    const body = await readFile(abs, "utf8");

    let data: Record<string, unknown> = {};
    let forgotten = false;
    try {
      data = parseFrontmatter(body).data;
      forgotten = isForgotten(data);
    } catch {
      forgotten = false;
    }
    if (forgotten) continue;

    const title = parseTitle(body, relPath);
    resolvable.push({
      id,
      title,
      aliases: parseAliases(body),
      frontmatterTitle: typeof data.title === "string" ? data.title : undefined,
      ulid: typeof data.id === "string" ? data.id : undefined,
    });
    // Vorlagen zählen als Ziel, aber nicht als Quelle.
    if (isLinkAuditExempt(id)) continue;
    sources.push({ id, title, links: parseLinks(body) });
  }

  const index = buildResolutionIndex(resolvable);

  // ── Pass 2: every wikilink target that resolves to nothing is broken ────
  const out: BrokenLink[] = [];
  for (const { id, title, links } of sources) {
    for (const link of links) {
      if (resolveWikilink(index, link)) continue; // auflösbar → nicht kaputt
      out.push({ sourceId: id, sourceTitle: title, linkText: link });
    }
  }

  return out.sort(
    (a, b) => a.sourceId.localeCompare(b.sourceId) || a.linkText.localeCompare(b.linkText),
  );
}
