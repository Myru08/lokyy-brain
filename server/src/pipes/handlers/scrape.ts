import type { PipeResult, SharePayload } from "@lokyy/shared";
import { getSupadataApiKey, getDefaultImportFolder } from "@lokyy/core";

/**
 * Web-Scrape-Pipe.
 *
 * Holt eine Website über Supadata und gibt sie als Markdown-Notiz zurück.
 * Zwei Modi, gleiche Handler-Signatur:
 *   - `scrapeHandler` — eine einzelne Seite (Pipe-Typ "url")
 *   - `crawlHandler`  — eine ganze Website, Seiten zu einer Notiz gebündelt
 *                       (Pipe-Typ "crawl")
 *
 * Aufbau bewusst parallel zum youtube-Handler — ein neuer Pipe ist immer
 * dasselbe Muster: Quelle holen, zu Markdown formen, PipeResult zurück.
 *
 * Auth + Ziel-Ordner kommen aus den Integration-Settings (system_config
 * KV via @lokyy/core).
 */

const SUPADATA_BASE = "https://api.supadata.ai/v1";

interface SupadataScrape {
  content?: string;
  markdown?: string;
  title?: string;
  url?: string;
}

function extractUrl(payload: SharePayload): string {
  const candidate = payload.url ?? payload.text ?? "";
  const m = candidate.match(/https?:\/\/\S+/);
  if (!m) throw new Error("Keine URL im Payload gefunden.");
  return m[0];
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "import"
  );
}

async function requireKey(): Promise<string> {
  const key = await getSupadataApiKey();
  if (!key) {
    throw new Error("Supadata API key not configured — set it in Settings");
  }
  return key;
}

function noteFrom(
  title: string,
  url: string,
  content: string,
  extraTag: string,
  folder: string,
  subfolder: string,
): PipeResult {
  const now = new Date().toISOString();
  const body = [
    "---",
    `title: "${title.replace(/"/g, "'")}"`,
    `source: ${url}`,
    `created: ${now}`,
    `tags: [inbox, ${extraTag}]`,
    "---",
    "",
    `# ${title}`,
    "",
    `> Automatisch erzeugt aus einer ${extraTag}-Pipe — via Supadata.`,
    "",
    `**Quelle:** ${url}`,
    "",
    content,
    "",
  ].join("\n");
  return { path: `${folder}/${subfolder}/${slugify(title)}.md`, body };
}

/**
 * Per-Job-Override gewinnt vor dem globalen `default_import_folder`.
 * Die Route hat `payload.targetFolder` bereits saniert; hier prüfen wir
 * nur, dass das Feld nicht leer ist.
 */
async function resolveFolder(payload: SharePayload): Promise<string> {
  const override = payload.targetFolder?.trim();
  if (override) return override.replace(/^\/+|\/+$/g, "");
  return getDefaultImportFolder();
}

/** Einzelne Seite scrapen. */
export async function scrapeHandler(
  payload: SharePayload,
): Promise<PipeResult> {
  const key = await requireKey();
  const folder = await resolveFolder(payload);
  const url = extractUrl(payload);

  // Endpoint/Parameter gegen die aktuelle Supadata-Doku prüfen — defensiv geparst.
  const res = await fetch(
    `${SUPADATA_BASE}/web/scrape?url=${encodeURIComponent(url)}`,
    { headers: { "x-api-key": key } },
  );
  if (!res.ok) throw new Error(`Supadata antwortete mit ${res.status}`);
  const data = (await res.json()) as SupadataScrape;

  const content = data.markdown ?? data.content ?? "";
  if (!content.trim()) throw new Error("Leerer Scrape von Supadata.");
  const title = payload.title?.trim() || data.title?.trim() || url;

  return noteFrom(title, url, content, "website", folder, "urls");
}

/** Ganze Website crawlen, Ergebnis zu einer Notiz bündeln. */
export async function crawlHandler(payload: SharePayload): Promise<PipeResult> {
  const key = await requireKey();
  const folder = await resolveFolder(payload);
  const url = extractUrl(payload);

  const res = await fetch(`${SUPADATA_BASE}/web/crawl`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`Supadata antwortete mit ${res.status}`);
  const data = (await res.json()) as {
    pages?: { url: string; title?: string; content?: string }[];
  };

  const pages = data.pages ?? [];
  if (pages.length === 0) throw new Error("Crawl lieferte keine Seiten.");

  const content = pages
    .map((p) => `## ${p.title ?? p.url}\n\n${p.content ?? ""}`)
    .join("\n\n---\n\n");
  const title = payload.title?.trim() || `Crawl: ${url}`;

  return noteFrom(title, url, content, "crawl", folder, "urls");
}
