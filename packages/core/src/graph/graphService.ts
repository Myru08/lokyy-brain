import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { GraphData, GraphEdge, GraphNode } from "@lokyy/shared";
import { coreConfig } from "../util/coreConfig.js";
import { pull } from "../git/gitService.js";

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
 */
export async function buildGraph(): Promise<GraphData> {
  await pull();
  const c = coreConfig();
  const files = await walk(c.vaultDir);

  const nodes: GraphNode[] = [];
  const byTitle = new Map<string, string>();
  // Alias lookup. First-write-wins so a deterministic note owns the alias
  // if two notes accidentally declare the same one. Title-collisions take
  // precedence over aliases by virtue of the resolution order below.
  const byAlias = new Map<string, string>();
  const byId = new Set<string>();
  // links = wikilink-targets (titles or ids); mdLinks = relative .md paths
  const raw: { id: string; folder: string; links: string[]; mdLinks: string[] }[] = [];

  for (const abs of files) {
    const relPath = relative(c.vaultDir, abs).split(sep).join("/");
    const id = relPath.replace(/\.md$/, "");
    const folder = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
    const body = await readFile(abs, "utf8");
    const title = parseTitle(body, relPath);
    nodes.push({ id, title, tags: parseTags(body) });
    byTitle.set(title.toLowerCase(), id);
    for (const alias of parseAliases(body)) {
      const key = alias.toLowerCase();
      if (!byAlias.has(key)) byAlias.set(key, id);
    }
    byId.add(id);
    raw.push({ id, folder, links: parseLinks(body), mdLinks: parseMdLinks(body) });
  }

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
    // Wikilinks resolve in priority order: title > alias > raw id.
    for (const link of links) {
      const lc = link.toLowerCase();
      const target =
        byTitle.get(lc) ??
        byAlias.get(lc) ??
        (byId.has(link) ? link : null);
      if (target) addEdge(id, target);
    }
    // Markdown-Links: resolve relative path → note id
    for (const md of mdLinks) {
      const targetId = resolveMdLink(md, folder);
      if (targetId && byId.has(targetId)) addEdge(id, targetId);
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
