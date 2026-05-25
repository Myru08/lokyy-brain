import type { PipeResult, SharePayload } from "@lokyy/shared";
import { getSupadataApiKey, getDefaultImportFolder } from "@lokyy/core";

/**
 * YouTube-Pipe — Referenz-Handler.
 *
 * Nimmt eine YouTube-URL, holt das Transkript über Supadata und gibt eine
 * fertige Markdown-Notiz mit Frontmatter zurück. Der Pipe-Queue-Code
 * committet sie anschließend in den Vault.
 *
 * Ein neuer Pipe (z.B. Whisper für Sprachnachrichten) ist genau diese
 * Signatur: (SharePayload) => Promise<PipeResult>.
 *
 * Auth + Ziel-Ordner kommen aus den Integration-Settings (system_config
 * KV via @lokyy/core). Server-Restart ist nach einer UI-Änderung NICHT
 * nötig — pipes ist kein hot-path.
 */

const SUPADATA_BASE = "https://api.supadata.ai/v1";

interface SupadataSegment {
  text?: string;
  content?: string;
  start?: number;
  duration?: number;
  end?: number;
  offset?: number;
}

interface SupadataTranscript {
  /** zusammengesetzter Volltext — kann String ODER Array<Segment> sein, je nach Endpoint-Version */
  content?: string | SupadataSegment[];
  /** alternativ: Segmente in eigenem Feld */
  transcript?: SupadataSegment[];
  /** weitere mögliche Felder aktueller API-Versionen */
  text?: string;
  segments?: SupadataSegment[];
  lang?: string;
}

/**
 * Normalisiert die Supadata-Antwort zu einem flachen Text-String.
 * Tolerant gegenüber API-Schema-Varianten:
 *   - `content` als String
 *   - `content`/`transcript`/`segments` als Array<{text}> oder Array<{content}> oder Array<string>
 */
function normalizeTranscript(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input
    .map((s): string => {
      if (typeof s === "string") return s;
      if (s && typeof s === "object") {
        const obj = s as SupadataSegment;
        return obj.text ?? obj.content ?? "";
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function extractUrl(payload: SharePayload): string {
  const candidate = payload.url ?? payload.text ?? "";
  const m = candidate.match(/https?:\/\/\S+/);
  if (!m) throw new Error("Keine URL im Share-Payload gefunden.");
  return m[0];
}

/** youtu.be/ID oder watch?v=ID -> ID */
function videoId(url: string): string {
  const m =
    url.match(/[?&]v=([\w-]{11})/) || url.match(/youtu\.be\/([\w-]{11})/);
  return m ? m[1] : url;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

export async function youtubeHandler(
  payload: SharePayload,
): Promise<PipeResult> {
  const apiKey = await getSupadataApiKey();
  if (!apiKey) {
    throw new Error("Supadata API key not configured — set it in Settings");
  }

  const url = extractUrl(payload);
  const id = videoId(url);

  // Hinweis: genauen Endpoint/Parameter gegen die aktuelle Supadata-Doku
  // pruefen — Struktur hier ist bewusst defensiv geparst.
  const res = await fetch(
    `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(url)}`,
    { headers: { "x-api-key": apiKey } },
  );
  if (!res.ok) {
    throw new Error(`Supadata antwortete mit ${res.status}`);
  }
  const data = (await res.json()) as SupadataTranscript;

  // Supadata API has multiple shapes across versions — try each defensively.
  // BUG-FIX 2026-05-25: content was being template-stringified as [object Object]
  // when the API returned an Array<{text,start,end}> instead of a String.
  const candidateBlocks = [data.content, data.text, data.transcript, data.segments];
  let transcript = "";
  for (const candidate of candidateBlocks) {
    transcript = normalizeTranscript(candidate).trim();
    if (transcript) break;
  }
  if (!transcript) throw new Error("Leeres Transkript von Supadata.");

  const title = payload.title?.trim() || `YouTube ${id}`;
  const now = new Date().toISOString();
  const body = [
    "---",
    `title: "${title.replace(/"/g, "'")}"`,
    `source: ${url}`,
    `created: ${now}`,
    "tags: [inbox, youtube]",
    "---",
    "",
    `# ${title}`,
    "",
    `> Automatisch erzeugt aus einer YouTube-Pipe — Transkript via Supadata.`,
    "",
    `**Quelle:** ${url}`,
    "",
    "## Transkript",
    "",
    transcript,
    "",
  ].join("\n");

  const folder = await resolveFolder(payload);
  return { path: `${folder}/youtube/${slugify(title)}.md`, body };
}

/**
 * Per-Job-Override gewinnt vor dem globalen `default_import_folder`.
 * Die Pipe-Route hat `targetFolder` bereits saniert; hier defensiv
 * Slash trimmen, falls der Override über `/share` reinkommt.
 */
async function resolveFolder(payload: SharePayload): Promise<string> {
  const override = payload.targetFolder?.trim();
  if (override) return override.replace(/^\/+|\/+$/g, "");
  return getDefaultImportFolder();
}
