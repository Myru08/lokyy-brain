import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipeResult, SharePayload } from "@lokyy/shared";
import {
  coreConfig,
  generateUlid,
  getDefaultImportFolder,
  getLlmProviders,
} from "@lokyy/core";

/**
 * Voice-Pipe (OpenAI Whisper).
 *
 * Ablauf:
 *   1. Route `/api/pipes/voice` empfaengt die Audio-Datei (multipart),
 *      validiert Groesse/MIME, committet sie via `gitService.saveBinary`
 *      nach `30_captures/voice/{YYYY-MM-DD}-{ULID}.{ext}` und ruft
 *      `enqueue('voice', { audioPath, language, title, targetFolder })`.
 *   2. Diese Funktion (`voiceHandler`) wird vom Pipe-Queue-Drain aufgerufen,
 *      liest die Audio-Bytes von Disk, postet sie an `whisper-1`, baut eine
 *      Markdown-Notiz mit Frontmatter und gibt sie als `PipeResult` zurueck.
 *      Der Pipe-Queue committet die Notiz dann nach `30_captures/voice/`.
 *
 * Audio-Asset im Repo: Audio-Dateien landen direkt im Git-Working-Copy.
 * Bei vielen / langen Aufnahmen blaeht das Repo das Forgejo-Backup auf.
 * Falls das relevant wird, ist Git-LFS oder ein Object-Store ein eigenes
 * Follow-up — bewusst NICHT in dieser Story.
 */

const OPENAI_TRANSCRIBE_URL =
  "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL = "whisper-1";

interface WhisperResponse {
  /** plain transcript */
  text?: string;
  /** verbose_json: language ISO 639-1 detected */
  language?: string;
  /** verbose_json: duration in seconds */
  duration?: number;
}

/** Custom error class so the queue surface stays readable. */
class VoiceHandlerError extends Error {
  constructor(
    message: string,
    readonly userFacing?: string,
  ) {
    super(message);
    this.name = "VoiceHandlerError";
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "voice"
  );
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Hallo das ist Satz eins. Satz zwei." -> "Hallo das ist Satz eins" */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  // grab everything up to first ./!/? followed by whitespace OR end of string
  const m = trimmed.match(/^([^.!?\n]{1,120})(?:[.!?]|$)/);
  const sentence = (m ? m[1] : trimmed).trim();
  return sentence.slice(0, 120);
}

/**
 * Read the configured OpenAI API key. Returns null if no enabled openai
 * provider with apiKey exists — the caller surfaces a user-facing hint.
 */
async function loadOpenaiKey(): Promise<string | null> {
  const providers = await getLlmProviders();
  const openai = providers.find(
    (p) => p.name === "openai" && p.enabled && !!p.apiKey,
  );
  return openai?.apiKey?.trim() || null;
}

/** Whisper POST, with one retry on 429. Throws VoiceHandlerError on real failure. */
async function postWhisper(
  apiKey: string,
  audioBytes: Uint8Array,
  audioFilename: string,
  audioMime: string,
  language: string | undefined,
): Promise<WhisperResponse> {
  const doPost = async (): Promise<Response> => {
    const form = new FormData();
    // FormData accepts a Blob; use that to set MIME explicitly. The
    // explicit ArrayBuffer copy keeps TS happy (Node's Uint8Array can be
    // backed by SharedArrayBuffer; the Blob constructor refuses that
    // shape).
    const ab = new ArrayBuffer(audioBytes.byteLength);
    new Uint8Array(ab).set(audioBytes);
    const blob = new Blob([ab], { type: audioMime || "audio/webm" });
    form.append("file", blob, audioFilename);
    form.append("model", WHISPER_MODEL);
    form.append("response_format", "verbose_json");
    if (language) form.append("language", language);
    return fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  };

  let res = await doPost();
  if (res.status === 429) {
    // single retry with 5s backoff
    await new Promise((r) => setTimeout(r, 5000));
    res = await doPost();
  }

  if (res.status === 401) {
    throw new VoiceHandlerError(
      "whisper-401",
      "OpenAI-API-Key ungültig oder ohne Whisper-Zugriff",
    );
  }
  if (res.status === 429) {
    throw new VoiceHandlerError(
      "whisper-429",
      "OpenAI-Whisper-Rate-Limit erreicht — bitte später erneut versuchen",
    );
  }
  if (res.status >= 500) {
    throw new VoiceHandlerError(
      `whisper-${res.status}`,
      "OpenAI-Whisper antwortet gerade nicht — bitte später erneut versuchen",
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      // ignore
    }
    throw new VoiceHandlerError(
      `whisper-${res.status}: ${detail}`,
      `Whisper-Fehler (${res.status})`,
    );
  }

  const data = (await res.json()) as WhisperResponse;
  if (!data || typeof data.text !== "string" || !data.text.trim()) {
    throw new VoiceHandlerError("whisper-empty", "Leeres Transkript von Whisper");
  }
  return data;
}

/** Per-Job-Override gewinnt vor dem globalen `default_import_folder`. */
async function resolveFolder(payload: SharePayload): Promise<string> {
  const override = payload.targetFolder?.trim();
  if (override) return override.replace(/^\/+|\/+$/g, "");
  return getDefaultImportFolder();
}

export async function voiceHandler(
  payload: SharePayload,
): Promise<PipeResult> {
  const audioPath = payload.audioPath?.trim();
  if (!audioPath) {
    throw new VoiceHandlerError(
      "no-audio-path",
      "Voice-Pipe: kein audioPath im Payload",
    );
  }

  const apiKey = await loadOpenaiKey();
  if (!apiKey) {
    // Rich error so the UI can route the user to settings.
    throw new VoiceHandlerError(
      "openai-key-missing",
      "Add an OpenAI API key in Settings → AI Provider",
    );
  }

  // Read the audio bytes that the route already committed.
  const cfg = coreConfig();
  const audioAbs = join(cfg.vaultDir, ...audioPath.split("/"));
  let audioBytes: Buffer;
  try {
    audioBytes = await readFile(audioAbs);
  } catch (err) {
    throw new VoiceHandlerError(
      `audio-read-failed: ${err instanceof Error ? err.message : String(err)}`,
      "Audio-Datei konnte nicht gelesen werden",
    );
  }

  const audioFilename = audioPath.split("/").pop() ?? "audio.webm";
  const audioMime = mimeFromExt(audioFilename);

  // Whisper call (incl. 429 retry).
  const whisper = await postWhisper(
    apiKey,
    audioBytes,
    audioFilename,
    audioMime,
    payload.language?.trim() || undefined,
  );

  const transcript = whisper.text!.trim();
  const detectedLanguage =
    payload.language?.trim() || whisper.language?.trim() || "auto";
  const durationSec = Math.round(whisper.duration ?? 0);

  // Derive title: explicit > first sentence > timestamped fallback.
  const now = new Date();
  const explicitTitle = payload.title?.trim();
  const derivedFromTranscript = firstSentence(transcript);
  const title =
    explicitTitle ||
    derivedFromTranscript ||
    `Voice-Notiz ${fmtDateTime(now)}`;

  // SPEC-valid frontmatter (matches packages/core/src/frontmatter/schemas/capture.json):
  // id + type + title + created + updated are mandatory; the pre-commit
  // hook on the vault rejects writes that miss any of these.
  const noteUlid = generateUlid();
  const nowIso = now.toISOString();
  const folder = await resolveFolder(payload);

  // Wikilink target for the audio file: gray-matter / wikilink parsers
  // treat the bracketed path as the link target. We keep the full vault-
  // relative path so the editor can locate the asset without extra glue.
  const body = [
    "---",
    `id: ${noteUlid}`,
    `type: capture`,
    `title: "${title.replace(/"/g, "'")}"`,
    `source: voice`,
    `source_type: voice`,
    `captured_at: ${nowIso}`,
    `created: ${nowIso}`,
    `updated: ${nowIso}`,
    `audio_path: ${audioPath}`,
    `language: ${detectedLanguage}`,
    `duration_seconds: ${durationSec}`,
    `tags: [inbox, voice]`,
    "---",
    "",
    `# ${title}`,
    "",
    transcript,
    "",
    "---",
    "",
    `**Audio:** [[${audioPath}]]`,
    `**Sprache:** ${detectedLanguage}`,
    `**Dauer:** ${durationSec}s`,
    "",
  ].join("\n");

  // Path inside the folder. Collide-safe via UNIX-ms suffix (the dispatcher
  // can fire multiple jobs in the same second on rapid retries).
  const slug = slugify(title);
  const baseName = `${fmtDate(now)}-${slug}`;
  const path = `${folder}/voice/${baseName}-${Date.now()}.md`;

  return { path, body };
}

/**
 * Map the audio file extension to a MIME type. Whisper's docs accept
 * webm, ogg, mp3, mp4, m4a, wav, mpeg, mpga, flac, oga — we only need a
 * plausible content-type on the multipart part.
 */
function mimeFromExt(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
  if (lower.endsWith(".mp3") || lower.endsWith(".mpga")) return "audio/mpeg";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".flac")) return "audio/flac";
  return "application/octet-stream";
}
