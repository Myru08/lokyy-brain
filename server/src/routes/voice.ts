import { Hono } from "hono";
import { ulid } from "ulid";
import { enqueue, saveBinary } from "@lokyy/core";
import type { SharePayload } from "@lokyy/shared";
import { resolveDefaultImportFolder } from "../settings/importDefaults.js";

/**
 * `/api/pipes/voice` — multipart upload endpoint fuer Sprachnotizen.
 *
 * Flow:
 *   1. PWA POSTet `audio` (File) + optional `language` + optional `title`.
 *   2. Wir validieren Groesse + MIME, committen die Audio-Bytes via
 *      `gitService.saveBinary` nach `30_captures/voice/{YYYY-MM-DD}-{ULID}.{ext}`,
 *      und legen einen Pipe-Job vom Typ `voice` an.
 *   3. Der `voiceHandler` (server/pipes/handlers/voiceHandler.ts) liest die
 *      Audio-Datei, schickt sie an OpenAI Whisper, baut die Markdown-Notiz
 *      und gibt sie an die Pipe-Queue zurueck, die sie ebenfalls ueber
 *      `gitService.save` committet.
 *
 * Job-Status-Polling laeuft ueber das bestehende `GET /api/pipes` bzw. den
 * neu geschaffenen Pipe-Status (s. pipesRoutes).
 */

export const voiceRoutes = new Hono();

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Whisper hard limit per OpenAI docs

const ALLOWED_MIME_PREFIXES = [
  "audio/",
  // some browsers report video/* for webm with the opus track — accept it
  "video/webm",
];

/** Extract a sane file extension from MIME or filename. Defaults to "webm". */
function extFromUpload(mime: string, name: string): string {
  // Filename wins if it has a real extension.
  const fileExtMatch = name.match(/\.([a-zA-Z0-9]{1,5})$/);
  if (fileExtMatch) return fileExtMatch[1].toLowerCase();

  const lower = mime.toLowerCase();
  if (lower.includes("webm")) return "webm";
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("mpeg") || lower === "audio/mp3") return "mp3";
  if (lower.includes("mp4") || lower.includes("m4a")) return "m4a";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("flac")) return "flac";
  return "webm";
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * POST /api/pipes/voice — multipart/form-data
 *
 * Fields:
 *   audio    (File, required)   webm/ogg/wav/mp3 audio, max 25 MB
 *   language (string, optional) ISO 639-1 code; auto-detect when absent
 *   title    (string, optional) user-supplied note title
 *
 * Responses:
 *   202 { jobId }                accepted, transcription queued
 *   400 { error, message }       upload missing / corrupt / wrong MIME
 *   413 { error, message }       audio over 25 MB
 *   500 { error, message }       internal error before enqueue
 */
voiceRoutes.post("/", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json(
      { error: "bad-content-type", message: "multipart/form-data erforderlich" },
      400,
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    return c.json(
      {
        error: "multipart-parse-failed",
        message: err instanceof Error ? err.message : "multipart parse failed",
      },
      400,
    );
  }

  const audio = form.get("audio");
  if (!(audio instanceof File)) {
    return c.json(
      { error: "missing-audio", message: "Feld 'audio' fehlt oder ist keine Datei" },
      400,
    );
  }

  // Size check — File.size is bytes.
  if (audio.size === 0) {
    return c.json({ error: "empty-audio", message: "Audio-Datei ist leer" }, 400);
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return c.json(
      {
        error: "audio-too-large",
        message: `Audio-Datei zu gross (${audio.size} bytes). Whisper-Limit: ${MAX_AUDIO_BYTES} bytes.`,
      },
      413,
    );
  }

  const mime = (audio.type || "").toLowerCase();
  if (mime && !ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p))) {
    return c.json(
      {
        error: "unsupported-mime",
        message: `MIME '${mime}' wird nicht akzeptiert. Erlaubt: audio/*, video/webm`,
      },
      400,
    );
  }

  const language = (() => {
    const raw = form.get("language");
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    // ISO 639-1 codes are 2 letters; tolerate region suffixes like "de-DE"
    // by taking the leading 2-letter prefix.
    if (!/^[a-zA-Z]{2}([-_][a-zA-Z]{2,4})?$/.test(trimmed)) return undefined;
    return trimmed.slice(0, 2).toLowerCase();
  })();

  const titleRaw = form.get("title");
  const title = typeof titleRaw === "string" ? titleRaw.trim() : undefined;

  // ── Vault-Commit der Audio-Bytes ─────────────────────────────────────
  const now = new Date();
  const ext = extFromUpload(audio.type, audio.name);
  const id = ulid();
  // Audio always lives under 30_captures/voice/ — the note that
  // references the asset uses the per-job targetFolder for ITS own
  // location (so the user-pick of "default import folder" still applies
  // to where the note lands).
  const audioPath = `30_captures/voice/${fmtDate(now)}-${id}.${ext}`;
  let audioBytes: Buffer;
  try {
    audioBytes = Buffer.from(await audio.arrayBuffer());
  } catch (err) {
    return c.json(
      {
        error: "audio-read-failed",
        message: err instanceof Error ? err.message : "audio-read-failed",
      },
      400,
    );
  }

  try {
    await saveBinary(
      audioPath,
      audioBytes,
      `pipe(voice): upload ${audioPath}`,
    );
  } catch (err) {
    return c.json(
      {
        error: "vault-commit-failed",
        message: err instanceof Error ? err.message : "vault commit failed",
      },
      500,
    );
  }

  // ── Pipe-Job enqueue ─────────────────────────────────────────────────
  const targetFolder = await resolveDefaultImportFolder();
  const payload: SharePayload = {
    title,
    language,
    audioPath,
    targetFolder,
  };
  const job = enqueue(payload, "voice");
  return c.json({ jobId: job.id, audioPath }, 202);
});
