import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipeResult, SharePayload } from "@lokyy/shared";
import {
  coreConfig,
  generateUlid,
  getDateParts,
  getDefaultImportFolder,
  getLlmProviders,
  getTimezone,
  getVoiceDefaultsWithMeta,
  type DateParts,
  type VoiceDefaults,
} from "@lokyy/core";
import { config } from "../../config.js";

/**
 * Voice-Pipe (Whisper-compatible transcription).
 *
 * Ablauf:
 *   1. Route `/api/pipes/voice` empfaengt die Audio-Datei (multipart),
 *      validiert Groesse/MIME, committet sie via `gitService.saveBinary`
 *      nach `30_captures/voice/{YYYY-MM-DD}-{ULID}.{ext}` und ruft
 *      `enqueue('voice', { audioPath, language, title, targetFolder })`.
 *   2. Diese Funktion (`voiceHandler`) wird vom Pipe-Queue-Drain aufgerufen,
 *      liest die Audio-Bytes von Disk, postet sie an einen Whisper-Endpoint
 *      (OpenAI Cloud ODER self-hosted `whisper-asr-webservice`), baut eine
 *      Markdown-Notiz mit Frontmatter und gibt sie als `PipeResult` zurueck.
 *      Der Pipe-Queue committet die Notiz dann nach `30_captures/voice/`.
 *
 * Endpoint-Routing (siehe `resolveWhisperEndpoint`):
 *   - `WHISPER_BASE_URL` gesetzt -> self-hosted (OpenAI-API-kompatibel,
 *     z.B. `onerahmet/openai-whisper-asr-webservice`). Auth optional via
 *     `WHISPER_API_KEY`.
 *   - Sonst -> OpenAI Cloud mit Key aus `llm_providers`-Tabelle (legacy).
 *
 * Audio-Asset im Repo: Audio-Dateien landen direkt im Git-Working-Copy.
 * Bei vielen / langen Aufnahmen blaeht das Repo das Forgejo-Backup auf.
 * Falls das relevant wird, ist Git-LFS oder ein Object-Store ein eigenes
 * Follow-up — bewusst NICHT in dieser Story.
 */

const OPENAI_TRANSCRIBE_URL =
  "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIBE_PATH = "/v1/audio/transcriptions";
const WHISPER_MODEL = "whisper-1";

/** Resolved endpoint description: where to POST, how to auth, which mode we're in. */
interface WhisperEndpoint {
  url: string;
  authHeader: string | null;
  mode: "openai-cloud" | "self-hosted";
  /** Sanitized display URL (no credentials) used in error messages + logs. */
  displayUrl: string;
}

/**
 * Build the endpoint descriptor.
 *
 * - `WHISPER_BASE_URL` set -> self-hosted; auth iff `WHISPER_API_KEY` set.
 * - Empty -> OpenAI cloud; the caller must provide a key (loaded from
 *   `llm_providers` via `loadOpenaiKey`) and we reject early otherwise.
 *
 * Path tolerance: if the configured URL already ends with the
 * transcriptions path we use it as-is, otherwise we append it. This lets
 * operators paste either `http://whisper:9000` or the full
 * `https://whisper.example.com/v1/audio/transcriptions`.
 */
function resolveWhisperEndpoint(
  openaiKey: string | null,
): WhisperEndpoint | { error: string; userFacing: string } {
  const base = config.whisperBaseUrl.trim();

  if (base) {
    const trimmed = base.replace(/\/+$/, "");
    const url = trimmed.endsWith(TRANSCRIBE_PATH)
      ? trimmed
      : `${trimmed}${TRANSCRIBE_PATH}`;
    const key = config.whisperApiKey.trim();
    return {
      url,
      authHeader: key ? `Bearer ${key}` : null,
      mode: "self-hosted",
      displayUrl: url,
    };
  }

  if (!openaiKey) {
    return {
      error: "openai-key-missing",
      userFacing: "Add an OpenAI API key in Settings → AI Provider",
    };
  }
  return {
    url: OPENAI_TRANSCRIBE_URL,
    authHeader: `Bearer ${openaiKey}`,
    mode: "openai-cloud",
    displayUrl: OPENAI_TRANSCRIBE_URL,
  };
}

/**
 * Startup log: print which Whisper backend we're talking to.
 *
 * Triggered lazily on the first voice request (rather than at module
 * import) so it shows up even if the env var is changed via a hot
 * dev-restart. Logged exactly once per process. Never leaks keys.
 */
let endpointLogged = false;
function logEndpointOnce(endpoint: WhisperEndpoint): void {
  if (endpointLogged) return;
  endpointLogged = true;
  if (endpoint.mode === "self-hosted") {
    const auth = endpoint.authHeader ? "with WHISPER_API_KEY" : "no auth";
    console.log(
      `[voice] Whisper endpoint: self-hosted ${endpoint.displayUrl} (${auth})`,
    );
  } else {
    console.log(`[voice] Whisper endpoint: OpenAI cloud (${endpoint.displayUrl})`);
  }
}

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

// Date-parts for `titlePattern` token substitution come from `getDateParts`
// in @lokyy/core, which honors the global timezone setting. With
// `timezone = "UTC"` the output is byte-identical to the legacy UTC-only
// renderer, so existing deployments keep their current title shapes.

/**
 * First sentence OR first 80 chars of the transcript, used by the
 * `{transcript-first-words}` token in `titlePattern`.
 */
function transcriptFirstWords(transcript: string): string {
  const trimmed = transcript.trim();
  if (!trimmed) return "";
  const sentence = firstSentence(trimmed);
  if (sentence) return sentence.slice(0, 80);
  return trimmed.slice(0, 80);
}

/**
 * Kebab-case of the first ~5 transcript words, capped at 40 chars. Used by
 * the `{slug}` token in `titlePattern`. Empty transcript → "voice".
 */
function transcriptSlug(transcript: string): string {
  const words = transcript.trim().split(/\s+/).slice(0, 5).join(" ");
  return slugify(words).slice(0, 40) || "voice";
}

/**
 * Render the configured `titlePattern` with token substitution. Date
 * tokens are evaluated in the configured display timezone (default `UTC`)
 * so the title matches what the user sees in their clock. With
 * `timezone = "UTC"` the output is byte-identical to the legacy renderer.
 * Supported tokens:
 *
 *   {YYYY-MM-DD HH:mm} — convenience composite (legacy default)
 *   {YYYY} {MM} {DD} {HH} {mm}
 *   {slug}                       — kebab-case, first 5 transcript words
 *   {transcript-first-words}     — first sentence or first 80 chars
 *
 * Unknown tokens are left as-is (forward-compat with future tokens).
 *
 * `parts` is pre-computed once per job (not per token) — the caller does
 * one `Intl.DateTimeFormat` call inside `voiceHandler` and threads the
 * result through here.
 */
function renderTitlePattern(
  pattern: string,
  parts: DateParts,
  transcript: string,
): string {
  return pattern
    // Legacy composite tokens first so partial matches don't eat them.
    .replace(/\{YYYY-MM-DD HH:mm\}/g, `${parts.YYYY}-${parts.MM}-${parts.DD} ${parts.HH}:${parts.mm}`)
    .replace(/\{YYYY-MM-DD\}/g, `${parts.YYYY}-${parts.MM}-${parts.DD}`)
    .replace(/\{HH:mm\}/g, `${parts.HH}:${parts.mm}`)
    .replace(/\{YYYY\}/g, parts.YYYY)
    .replace(/\{MM\}/g, parts.MM)
    .replace(/\{DD\}/g, parts.DD)
    .replace(/\{HH\}/g, parts.HH)
    .replace(/\{mm\}/g, parts.mm)
    .replace(/\{transcript-first-words\}/g, transcriptFirstWords(transcript))
    .replace(/\{slug\}/g, transcriptSlug(transcript))
    .trim();
}

/**
 * Derive the final title from (in order): explicit payload override > pattern
 * rendered with transcript context > timestamp fallback. The fallback always
 * succeeds even if the rendered pattern collapses to an empty string.
 */
function deriveTitle(
  payloadTitle: string | undefined,
  defaults: VoiceDefaults,
  parts: DateParts,
  now: Date,
  transcript: string,
): string {
  const explicit = payloadTitle?.trim();
  if (explicit) return explicit;
  const rendered = renderTitlePattern(defaults.titlePattern, parts, transcript).trim();
  if (rendered) return rendered;
  return `Voice-Notiz ${fmtDateTime(now)}`;
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

/**
 * Heuristic: did this fetch failure look like the endpoint being
 * unreachable (DNS, connection refused, network timeout)? Node's
 * `fetch` wraps these in a `TypeError: fetch failed` with the real
 * cause attached. We don't have access to `undici` error codes
 * directly without a runtime import — message-sniffing on the cause
 * is good enough for the user-facing message.
 */
function isUnreachableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  const causeMsg =
    cause instanceof Error
      ? cause.message.toLowerCase()
      : typeof cause === "string"
        ? cause.toLowerCase()
        : "";
  const msg = err.message.toLowerCase();
  return (
    /econn(refused|reset)|enotfound|eai_again|etimedout|undici|fetch failed/.test(
      msg,
    ) ||
    /econn(refused|reset)|enotfound|eai_again|etimedout|connect/.test(causeMsg)
  );
}

/** Whisper POST, with one retry on 429. Throws VoiceHandlerError on real failure. */
async function postWhisper(
  endpoint: WhisperEndpoint,
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
    // OpenAI requires model=whisper-1. whisper-asr-webservice ignores the
    // field (it uses whatever model was loaded at container start via the
    // ASR_MODEL env on the whisper container). Sending it always keeps
    // both backends happy.
    form.append("model", WHISPER_MODEL);
    form.append("response_format", "verbose_json");
    if (language) form.append("language", language);
    const headers: Record<string, string> = {};
    if (endpoint.authHeader) headers.Authorization = endpoint.authHeader;
    return fetch(endpoint.url, {
      method: "POST",
      headers,
      body: form,
    });
  };

  let res: Response;
  try {
    res = await doPost();
    if (res.status === 429) {
      // single retry with 5s backoff
      await new Promise((r) => setTimeout(r, 5000));
      res = await doPost();
    }
  } catch (err) {
    if (endpoint.mode === "self-hosted" && isUnreachableError(err)) {
      throw new VoiceHandlerError(
        `whisper-unreachable: ${err instanceof Error ? err.message : String(err)}`,
        `Whisper-Endpoint (${endpoint.displayUrl}) nicht erreichbar — Coolify-Resource läuft?`,
      );
    }
    throw new VoiceHandlerError(
      `whisper-fetch-failed: ${err instanceof Error ? err.message : String(err)}`,
      "Whisper-Endpoint nicht erreichbar",
    );
  }

  if (res.status === 401) {
    if (endpoint.mode === "self-hosted") {
      throw new VoiceHandlerError(
        "whisper-401",
        "Whisper-Endpoint braucht Auth (WHISPER_API_KEY) oder Endpoint falsch",
      );
    }
    throw new VoiceHandlerError(
      "whisper-401",
      "OpenAI-API-Key ungültig oder ohne Whisper-Zugriff",
    );
  }
  if (res.status === 429) {
    throw new VoiceHandlerError(
      "whisper-429",
      endpoint.mode === "self-hosted"
        ? "Whisper-Endpoint-Rate-Limit erreicht — bitte später erneut versuchen"
        : "OpenAI-Whisper-Rate-Limit erreicht — bitte später erneut versuchen",
    );
  }
  if (res.status >= 500) {
    throw new VoiceHandlerError(
      `whisper-${res.status}`,
      endpoint.mode === "self-hosted"
        ? `Whisper-Endpoint (${endpoint.displayUrl}) antwortet gerade nicht — bitte später erneut versuchen`
        : "OpenAI-Whisper antwortet gerade nicht — bitte später erneut versuchen",
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

/**
 * Resolved note-target folder for the voice handler.
 *
 *   - `folder`        vault-relative target dir, no leading/trailing slash
 *   - `appendVoiceSubdir` true if the legacy `/voice/` subdir should be
 *                     suffixed by the caller (kept for backwards-compat).
 *
 * Path-shape contract:
 *   1. Per-job `payload.targetFolder` — pointed at the IMPORT root (e.g.
 *      `30_captures`). The voice handler historically appended `/voice/`
 *      on top to keep audio + note co-located. `appendVoiceSubdir=true`.
 *   2. `voice_defaults.folder` — the user-configured COMPLETE folder
 *      (`30_captures/voice` by default). Used as-is.
 *      `appendVoiceSubdir=false`.
 *   3. Legacy `default_import_folder` — same shape as (1).
 *      `appendVoiceSubdir=true`.
 *
 * Result: existing deployments without a `voice_defaults` row keep writing
 * to `${default_import_folder}/voice/...`, exactly like today.
 */
interface ResolvedVoiceFolder {
  folder: string;
  appendVoiceSubdir: boolean;
}

async function resolveFolder(
  payload: SharePayload,
  defaults: VoiceDefaults,
  defaultsRowExists: boolean,
): Promise<ResolvedVoiceFolder> {
  const override = payload.targetFolder?.trim();
  if (override) {
    return {
      folder: override.replace(/^\/+|\/+$/g, ""),
      appendVoiceSubdir: true,
    };
  }
  if (defaultsRowExists && defaults.folder?.trim()) {
    return {
      folder: defaults.folder.trim().replace(/^\/+|\/+$/g, ""),
      appendVoiceSubdir: false,
    };
  }
  return {
    folder: await getDefaultImportFolder(),
    appendVoiceSubdir: true,
  };
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

  // Load persisted defaults BEFORE the Whisper call so the language hint
  // can fall back to defaults.language. Read failure (DB not initialised
  // yet, etc.) gracefully degrades to hardcoded defaults — voice never
  // breaks because the settings row is missing.
  let voiceDefaults: VoiceDefaults;
  let defaultsRowExists = false;
  try {
    const meta = await getVoiceDefaultsWithMeta();
    voiceDefaults = meta.defaults;
    defaultsRowExists = meta.rowExists;
  } catch (err) {
    console.warn(
      `[voice] getVoiceDefaults failed, using hardcoded defaults — ${err instanceof Error ? err.message : String(err)}`,
    );
    voiceDefaults = {
      mode: "live",
      folder: "30_captures/voice",
      titlePattern: "Voice-Notiz {YYYY-MM-DD HH:mm}",
      language: null,
      aiTitle: false,
    };
    defaultsRowExists = false;
  }

  // Endpoint routing: self-hosted (WHISPER_BASE_URL) wins; fall back to
  // OpenAI cloud with the key from `llm_providers`. We only consult the
  // DB when no self-hosted endpoint is configured, so a self-hosted
  // setup needs zero OpenAI provider config.
  const selfHosted = !!config.whisperBaseUrl.trim();
  const apiKey = selfHosted ? null : await loadOpenaiKey();
  const endpointOrError = resolveWhisperEndpoint(apiKey);
  if ("error" in endpointOrError) {
    throw new VoiceHandlerError(
      endpointOrError.error,
      endpointOrError.userFacing,
    );
  }
  const endpoint = endpointOrError;
  logEndpointOnce(endpoint);

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

  // Language hint priority: per-job payload > persisted default > none
  // (Whisper auto-detect). Defaults that store `"de-DE"` keep the region
  // for display but only the 2-letter prefix gets sent to Whisper — the
  // upload route already enforces the same shape on the payload field.
  const payloadLanguage = payload.language?.trim();
  const defaultLanguage = voiceDefaults.language?.trim();
  const languageHint =
    payloadLanguage || defaultLanguage || undefined;
  const whisperLanguage = languageHint
    ? languageHint.slice(0, 2).toLowerCase()
    : undefined;

  // Whisper call (incl. 429 retry).
  const whisper = await postWhisper(
    endpoint,
    audioBytes,
    audioFilename,
    audioMime,
    whisperLanguage,
  );

  const transcript = whisper.text!.trim();
  const detectedLanguage =
    languageHint || whisper.language?.trim() || "auto";
  const durationSec = Math.round(whisper.duration ?? 0);

  // Derive title: explicit > rendered titlePattern (defaults) > fallback.
  // Date-parts are evaluated in the configured display timezone (default
  // `UTC`) — cached once per job so token substitution stays a pure string
  // op. Read failure (DB not initialised, corrupt row) silently falls back
  // to UTC: title rendering must never block a voice transcription.
  const now = new Date();
  let displayTimezone = "UTC";
  try {
    displayTimezone = await getTimezone();
  } catch (err) {
    console.warn(
      `[voice] getTimezone failed, falling back to UTC — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const dateParts = getDateParts(now, displayTimezone);
  const title = deriveTitle(payload.title, voiceDefaults, dateParts, now, transcript);

  // SPEC-valid frontmatter (matches packages/core/src/frontmatter/schemas/capture.json):
  // id + type + title + created + updated are mandatory; the pre-commit
  // hook on the vault rejects writes that miss any of these.
  const noteUlid = generateUlid();
  const nowIso = now.toISOString();
  const resolvedFolder = await resolveFolder(
    payload,
    voiceDefaults,
    defaultsRowExists,
  );

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
  //
  // Folder shape:
  //   - voice_defaults.folder (explicit user setting) → use AS-IS, no extra
  //     `/voice/` suffix. The user's configured path is the complete target.
  //   - payload.targetFolder / default_import_folder (legacy fallbacks) →
  //     append `/voice/` so old deployments keep writing to the same place.
  const slug = slugify(title);
  const baseName = `${fmtDate(now)}-${slug}`;
  const targetDir = resolvedFolder.appendVoiceSubdir
    ? `${resolvedFolder.folder}/voice`
    : resolvedFolder.folder;
  const path = `${targetDir}/${baseName}-${Date.now()}.md`;

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
