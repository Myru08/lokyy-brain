import { useEffect, useRef, useState } from "react";
import type { Note, PipeJob } from "@lokyy/shared";
import {
  Mic,
  Square,
  Settings as SettingsIcon,
  X as XIcon,
  Check,
  AlertTriangle,
  ArrowUpRight,
} from "lucide-react";
import { C, FONT } from "./theme.js";
import { Spinner } from "./Spinner.js";

/**
 * VoiceQuickButton — first-class one-click voice capture from the top-bar.
 *
 * Why this exists: the full `VoiceRecorder` lives in the slide-over ImportPanel.
 * That's three clicks (Import → Sprachaufnahme → Mic) before a single word is
 * captured. This button collapses the happy path into one click: tap the mic,
 * speak, tap again to stop, the note appears.
 *
 * Defaults come from `GET /api/voice/settings` (mode/folder/title/language) so
 * there is never a per-click config dialog. Power users still have the full
 * recorder with mode-switch + audio preview inside ImportPanel.
 *
 * State machine (compressed — `error` is reachable from every active state):
 *
 *   idle --click--> requesting --grant--> recording(W) --stop--> uploading --202--> transcribing --done--> idle
 *      \                       \--grant--> listening(L) --stop--> live-saving                   --done--> idle
 *       \--denied/no-key--> error                                                                 \--err--> error
 *
 *   "W" = whisper-cloud / whisper-selfhosted   "L" = live (Web-Speech-API)
 *
 * The existing VoiceRecorder.tsx is the long-form companion — this component
 * deliberately duplicates the minimum recording/recognition glue rather than
 * importing it, so the two state machines stay independent and the button can
 * never get stuck waiting on a panel re-render.
 */

/* ── Backend contract (built in parallel by another agent) ─────────────── */

type VoiceMode = "live" | "whisper-cloud" | "whisper-selfhosted";

interface VoiceSettingsResponse {
  mode: VoiceMode;
  folder: string;
  titlePattern: string;
  language: string | null;
  /** Capability hints — surfaced so we can show targeted error toasts. */
  openAiKeyConfigured?: boolean;
  whisperSelfhostedUrl?: string | null;
}

const FALLBACK_SETTINGS: VoiceSettingsResponse = {
  mode: "live",
  folder: "30_captures/voice",
  titlePattern: "Voice-Notiz {YYYY-MM-DD HH:mm}",
  language: null,
  openAiKeyConfigured: false,
  whisperSelfhostedUrl: null,
};

/* ── Web-Speech-API types (minimal surface, file-local — same pattern as
 * VoiceRecorder.tsx, deliberately kept private here so the file is
 * self-contained). ────────────────────────────────────────────────────── */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  item(idx: number): SpeechRecognitionAlternativeLike;
  [idx: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionResultListLike {
  readonly length: number;
  item(idx: number): SpeechRecognitionResultLike;
  [idx: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message?: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((ev: Event) => void) | null;
  onstart: ((ev: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === "function" ? ctor : null;
}

/* ── Misc helpers (lifted in spirit from VoiceRecorder; tiny enough to
 * keep duplicated rather than introduce a third file). ────────────── */

const MAX_DURATION_MS = 10 * 60 * 1000;
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
const POLL_INTERVAL_MS = 1500;
const TOAST_AUTO_DISMISS_MS = 5000;

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg",
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore unknown */
    }
  }
  return "";
}

function fmtTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function fmtDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slugify(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "voice";
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Tiny Mustache-light renderer for the title pattern. Supports the same
 * tokens documented in `Settings.tsx` (subset — `{slug}` and
 * `{transcript-first-words}` are best-effort because the button has no
 * transcript yet at title-generation time for whisper mode).
 */
function renderTitle(pattern: string, transcript: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    "YYYY-MM-DD": fmtDate(d),
    "YYYY-MM-DD HH:mm": fmtTimestamp(d),
    slug: slugify(transcript || "voice"),
    "transcript-first-words": (transcript || "").slice(0, 80).trim(),
  };
  let out = pattern || "Voice-Notiz {YYYY-MM-DD HH:mm}";
  for (const [k, v] of Object.entries(map)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return out.trim() || `Voice-Notiz ${fmtTimestamp(d)}`;
}

/**
 * Build a SPEC-valid `type: capture` body for live-mode notes (mirrors
 * `buildCaptureBody` from VoiceRecorder — kept duplicated because the
 * shape is small and the two files own their own save path).
 */
function buildCaptureBody(opts: {
  noteId: string;
  noteCreated: string;
  title: string;
  language: string;
  transcript: string;
}): string {
  const escape = (s: string) =>
    `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return [
    "---",
    `id: ${opts.noteId}`,
    "type: capture",
    `title: ${escape(opts.title)}`,
    `created: ${opts.noteCreated}`,
    `updated: ${new Date().toISOString()}`,
    "source: voice",
    `lang: ${opts.language}`,
    "tags: [voice, capture]",
    "---",
    "",
    opts.transcript.trim() || "(leeres Transkript)",
    "",
  ].join("\n");
}

/* ── State machine ─────────────────────────────────────────────────── */

type ButtonState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "recording-whisper"; startedAt: number; elapsedMs: number }
  | { kind: "listening-live"; startedAt: number; elapsedMs: number }
  | { kind: "uploading" }
  | { kind: "transcribing"; jobId: string }
  | { kind: "saving-live" }
  | { kind: "done"; noteId: string; notePath: string }
  | { kind: "error"; message: string; settingsHint?: boolean };

interface VoiceQuickButtonProps {
  /** Fired once a note is successfully created. Caller opens it in the editor. */
  onImported: (noteId: string) => void;
  /** Used by the "Settings" link in the recording banner. */
  onOpenSettings: () => void;
  /** Touch-target sizing on mobile — matches the rest of the top-bar. */
  isMobile?: boolean;
}

export function VoiceQuickButton({
  onImported,
  onOpenSettings,
  isMobile = false,
}: VoiceQuickButtonProps) {
  const [state, setState] = useState<ButtonState>({ kind: "idle" });
  const [settings, setSettings] = useState<VoiceSettingsResponse>(
    FALLBACK_SETTINGS,
  );

  // Recording-mode infra (whisper).
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recMimeRef = useRef<string>("");
  const tickRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);

  // Live-mode infra (Web-Speech-API).
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const userStoppedRef = useRef<boolean>(false);
  const finalTextRef = useRef<string>("");
  const liveStartedAtRef = useRef<number>(0);
  const liveTickRef = useRef<number | null>(null);

  // Toast auto-dismiss timer (only used on `done`).
  const doneTimerRef = useRef<number | null>(null);

  // Effective mode after capability checks — set once recording starts.
  const effectiveModeRef = useRef<VoiceMode>("live");

  /* ── Settings fetch (mount + every click) ─────────────────────────
   * Refetching on every click is cheap and means Settings changes pick
   * up immediately without a Pulse round-trip. A 404 / network error
   * falls through to FALLBACK_SETTINGS — the button never breaks.
   * ───────────────────────────────────────────────────────────────── */
  async function loadSettings(): Promise<VoiceSettingsResponse> {
    try {
      const r = await fetch("/api/voice/settings", { credentials: "include" });
      if (!r.ok) {
        return FALLBACK_SETTINGS;
      }
      const data = (await r.json()) as Partial<VoiceSettingsResponse>;
      // Merge over fallback so missing keys don't break anything.
      const merged: VoiceSettingsResponse = {
        ...FALLBACK_SETTINGS,
        ...data,
        mode: (data.mode ?? FALLBACK_SETTINGS.mode) as VoiceMode,
      };
      setSettings(merged);
      return merged;
    } catch {
      return FALLBACK_SETTINGS;
    }
  }

  useEffect(() => {
    void loadSettings();
    return () => {
      // Full teardown on unmount.
      hardReset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Teardown helpers ─────────────────────────────────────────── */

  const stopTick = () => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  const stopPoll = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const stopLiveTick = () => {
    if (liveTickRef.current !== null) {
      window.clearInterval(liveTickRef.current);
      liveTickRef.current = null;
    }
  };

  const teardownStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  };

  const teardownRecognition = () => {
    const r = recognitionRef.current;
    if (r) {
      userStoppedRef.current = true;
      try {
        r.onresult = null;
        r.onerror = null;
        r.onend = null;
        r.onstart = null;
        r.abort();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    }
    stopLiveTick();
    finalTextRef.current = "";
  };

  const hardReset = () => {
    stopTick();
    stopPoll();
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch {
      /* ignore */
    }
    teardownStream();
    teardownRecognition();
    if (doneTimerRef.current !== null) {
      window.clearTimeout(doneTimerRef.current);
      doneTimerRef.current = null;
    }
  };

  /* ── Whisper-mode flow ────────────────────────────────────────── */

  async function startWhisperRecording(): Promise<void> {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function" ||
      typeof MediaRecorder === "undefined"
    ) {
      setState({
        kind: "error",
        message:
          "Browser unterstützt keine Sprachaufnahme. Bitte aktuellen Chrome/Edge/Firefox oder iOS Safari ≥ 14.5 über HTTPS verwenden.",
      });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const e = err as DOMException;
      const denied =
        e?.name === "NotAllowedError" || e?.name === "SecurityError";
      setState({
        kind: "error",
        message: denied
          ? "Mikrofon-Zugriff verweigert. Erlaube ihn in den Browser-Einstellungen."
          : `Aufnahme nicht möglich: ${e?.message ?? "unbekannter Fehler"}`,
      });
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];

    const mimeType = pickMimeType();
    recMimeRef.current = mimeType;
    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      teardownStream();
      setState({
        kind: "error",
        message: `MediaRecorder konnte nicht gestartet werden: ${
          (err as Error).message ?? err
        }`,
      });
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };

    recorder.onstop = () => {
      stopTick();
      const blobType =
        chunksRef.current[0]?.type ?? recMimeRef.current ?? "audio/webm";
      const blob = new Blob(chunksRef.current, { type: blobType });
      teardownStream();

      if (blob.size === 0) {
        setState({
          kind: "error",
          message: "Aufnahme leer — Mikrofon hat keine Daten geliefert.",
        });
        return;
      }
      if (blob.size > WHISPER_MAX_BYTES) {
        setState({
          kind: "error",
          message: `Aufnahme zu groß (${(blob.size / 1024 / 1024).toFixed(
            1,
          )} MB > 25 MB Whisper-Limit). Bitte kürzer aufnehmen.`,
        });
        return;
      }

      void uploadWhisperBlob(blob, blobType);
    };

    recorder.onerror = (ev) => {
      stopTick();
      teardownStream();
      const msg =
        (ev as unknown as { error?: DOMException }).error?.message ??
        "MediaRecorder-Fehler";
      setState({ kind: "error", message: msg });
    };

    try {
      recorder.start(1000);
    } catch (err) {
      teardownStream();
      setState({
        kind: "error",
        message: `Aufnahme konnte nicht gestartet werden: ${
          (err as Error).message ?? err
        }`,
      });
      return;
    }

    const startedAt = Date.now();
    setState({ kind: "recording-whisper", startedAt, elapsedMs: 0 });

    tickRef.current = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= MAX_DURATION_MS) {
        try {
          recorderRef.current?.stop();
        } catch {
          /* ignore */
        }
        return;
      }
      setState((prev) =>
        prev.kind === "recording-whisper" ? { ...prev, elapsedMs } : prev,
      );
    }, 250);
  }

  async function uploadWhisperBlob(blob: Blob, mimeType: string) {
    setState({ kind: "uploading" });

    const ext = mimeType.includes("mp4")
      ? "m4a"
      : mimeType.includes("mpeg")
        ? "mp3"
        : mimeType.includes("ogg")
          ? "ogg"
          : "webm";
    const file = new File([blob], `voice-${Date.now()}.${ext}`, {
      type: mimeType || "audio/webm",
    });

    const form = new FormData();
    form.append("audio", file);
    form.append("title", renderTitle(settings.titlePattern, ""));
    form.append("language", settings.language ?? "");
    // Hint the server which whisper backend to use — endpoint is the same
    // (`/api/pipes/voice`) and the server already routes by env. Sending
    // the mode as a form-field is forward-compat with a future router.
    form.append("mode", effectiveModeRef.current);

    let jobId: string;
    try {
      const res = await fetch("/api/pipes/voice", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        const errBody = await res
          .json()
          .catch(() => ({ error: res.statusText }));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { jobId?: string; id?: string };
      jobId = data.jobId ?? data.id ?? "";
      if (!jobId) throw new Error("Server lieferte keine jobId zurück.");
    } catch (err) {
      setState({
        kind: "error",
        message: `Upload fehlgeschlagen: ${(err as Error).message ?? err}`,
      });
      return;
    }

    setState({ kind: "transcribing", jobId });

    stopPoll();
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const r = await fetch("/api/pipes", { credentials: "include" });
          if (!r.ok) return;
          const jobs = (await r.json()) as PipeJob[];
          const job = jobs.find((j) => j.id === jobId);
          if (!job) return;
          if (job.status === "done") {
            stopPoll();
            const noteId = job.resultNoteId ?? "";
            finishDone(noteId, noteId ? `${noteId}.md` : "(unbekannt)");
          } else if (job.status === "error") {
            stopPoll();
            setState({
              kind: "error",
              message: `Transkription fehlgeschlagen: ${
                job.error ?? "unbekannter Fehler"
              }`,
            });
          }
        } catch {
          /* keep polling */
        }
      })();
    }, POLL_INTERVAL_MS);
  }

  /* ── Live-mode flow (Web-Speech-API) ──────────────────────────── */

  function startLiveListening(): void {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      // Spec says: silently fall back to whisper-cloud (but only if a key
      // is configured; otherwise surface the missing-key error).
      if (!settings.openAiKeyConfigured) {
        setState({
          kind: "error",
          settingsHint: true,
          message:
            "OpenAI-Key fehlt — Settings → AI Provider. (Web-Speech wäre die Live-Alternative, dein Browser unterstützt sie aber nicht.)",
        });
        return;
      }
      console.warn(
        "[VoiceQuickButton] SpeechRecognition not supported — silently falling back to whisper-cloud",
      );
      effectiveModeRef.current = "whisper-cloud";
      void startWhisperRecording();
      return;
    }

    teardownRecognition();
    userStoppedRef.current = false;
    finalTextRef.current = "";

    const bcp47Map: Record<string, string> = {
      de: "de-DE",
      en: "en-US",
      fr: "fr-FR",
      es: "es-ES",
      it: "it-IT",
    };
    const langKey = (settings.language ?? "de").toLowerCase();
    const bcp47 = bcp47Map[langKey] ?? "de-DE";

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Ctor();
    } catch (err) {
      setState({
        kind: "error",
        message: `SpeechRecognition init failed: ${
          (err as Error).message ?? err
        }`,
      });
      return;
    }
    recognition.lang = bcp47;
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (ev: SpeechRecognitionEventLike) => {
      let appended = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res) continue;
        const alt = res[0];
        if (!alt) continue;
        if (res.isFinal) appended += alt.transcript;
      }
      if (appended) {
        const sep =
          finalTextRef.current && !finalTextRef.current.endsWith(" ") ? " " : "";
        finalTextRef.current = finalTextRef.current + sep + appended.trim();
      }
    };

    recognition.onerror = (ev: SpeechRecognitionErrorEventLike) => {
      if (ev.error === "aborted" && userStoppedRef.current) return;
      if (ev.error === "no-speech" && !userStoppedRef.current) return;
      const msgMap: Record<string, string> = {
        "audio-capture":
          "Kein Mikrofon verfügbar. Prüfe das Eingabegerät in den System-Einstellungen.",
        "not-allowed":
          "Mikrofon-Zugriff verweigert. Erlaube ihn in den Browser-Einstellungen.",
        network:
          "Netzwerk-Fehler bei der Spracherkennung. Live-Modus braucht Internet.",
        "service-not-allowed":
          "Spracherkennungs-Dienst nicht erlaubt — Browser blockiert ihn.",
        "language-not-supported": `Sprache "${bcp47}" wird von diesem Browser nicht unterstützt.`,
      };
      const userMsg =
        msgMap[ev.error] ??
        `Spracherkennungs-Fehler: ${ev.error}${
          ev.message ? ` (${ev.message})` : ""
        }`;
      teardownRecognition();
      setState({ kind: "error", message: userMsg });
    };

    recognition.onend = () => {
      if (userStoppedRef.current) return;
      const r = recognitionRef.current;
      if (!r) return;
      try {
        r.start();
      } catch {
        window.setTimeout(() => {
          if (userStoppedRef.current) return;
          try {
            recognitionRef.current?.start();
          } catch {
            /* give up silently */
          }
        }, 250);
      }
    };

    try {
      recognition.start();
    } catch (err) {
      setState({
        kind: "error",
        message: `Live-Aufnahme konnte nicht gestartet werden: ${
          (err as Error).message ?? err
        }`,
      });
      return;
    }
    recognitionRef.current = recognition;

    const startedAt = Date.now();
    liveStartedAtRef.current = startedAt;
    setState({ kind: "listening-live", startedAt, elapsedMs: 0 });

    stopLiveTick();
    liveTickRef.current = window.setInterval(() => {
      setState((prev) =>
        prev.kind === "listening-live"
          ? { ...prev, elapsedMs: Date.now() - startedAt }
          : prev,
      );
    }, 250);
  }

  async function stopLiveAndSave() {
    if (state.kind !== "listening-live") return;
    const transcript = finalTextRef.current.trim();

    userStoppedRef.current = true;
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
    stopLiveTick();
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
    }

    if (!transcript) {
      teardownRecognition();
      setState({
        kind: "error",
        message: "Transkript ist leer — nichts zu speichern.",
      });
      return;
    }

    setState({ kind: "saving-live" });

    const finalTitle = renderTitle(settings.titlePattern, transcript);
    const folder = (settings.folder || "30_captures/voice").replace(/\/+$/, "");
    const slug = slugify(finalTitle);
    const path = `${folder}/${fmtDate()}-${slug}`;

    // Step 1: create the empty note.
    let created: Note;
    try {
      const res = await fetch("/api/vault/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, body: "" }),
        credentials: "include",
      });
      if (!res.ok) {
        const errBody = await res
          .json()
          .catch(() => ({ error: res.statusText }));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      created = (await res.json()) as Note;
    } catch (err) {
      teardownRecognition();
      setState({
        kind: "error",
        message: `Notiz konnte nicht angelegt werden: ${
          (err as Error).message ?? err
        }`,
      });
      return;
    }

    // Step 2: parse id/created from the newly written frontmatter so the
    // PUT round-trips identity correctly (mirrors VoiceRecorder.saveLive).
    let noteId = "";
    let noteCreated = new Date().toISOString();
    try {
      const r = await fetch(
        `/api/notes/${encodeURIComponent(created.id)}`,
        { credentials: "include" },
      );
      if (r.ok) {
        const note = (await r.json()) as Note & { body: string };
        const fm = note.body.split(/\n---\n/)[0] ?? "";
        const idMatch = fm.match(/\bid:\s*([0-9A-HJKMNP-TV-Z]{26})/);
        const createdMatch = fm.match(/\bcreated:\s*([^\n]+)/);
        if (idMatch) noteId = idMatch[1] ?? "";
        if (createdMatch) noteCreated = (createdMatch[1] ?? "").trim();
      }
    } catch {
      /* non-fatal */
    }

    const captureBody = buildCaptureBody({
      noteId: noteId || "00000000000000000000000000",
      noteCreated,
      title: finalTitle,
      language: settings.language ?? "auto",
      transcript,
    });

    try {
      const res = await fetch(
        `/api/notes/${encodeURIComponent(created.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: captureBody }),
          credentials: "include",
        },
      );
      if (!res.ok) {
        const errBody = await res
          .json()
          .catch(() => ({ error: res.statusText }));
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      teardownRecognition();
      setState({
        kind: "error",
        message: `Notiz erstellt (${created.path}) aber Transkript konnte nicht gespeichert werden: ${
          (err as Error).message ?? err
        }`,
      });
      return;
    }

    teardownRecognition();
    finishDone(created.id, created.path);
  }

  /* ── Done bookkeeping ─────────────────────────────────────────── */

  function finishDone(noteId: string, notePath: string) {
    setState({ kind: "done", noteId, notePath });
    if (doneTimerRef.current !== null) {
      window.clearTimeout(doneTimerRef.current);
    }
    doneTimerRef.current = window.setTimeout(() => {
      doneTimerRef.current = null;
      // Only collapse to idle if we're still on the same `done` toast.
      setState((prev) => (prev.kind === "done" ? { kind: "idle" } : prev));
    }, TOAST_AUTO_DISMISS_MS);
  }

  function dismissDone() {
    if (doneTimerRef.current !== null) {
      window.clearTimeout(doneTimerRef.current);
      doneTimerRef.current = null;
    }
    setState({ kind: "idle" });
  }

  /* ── Click handler ────────────────────────────────────────────── */

  async function handleClick() {
    // Active stop paths.
    if (state.kind === "recording-whisper") {
      try {
        recorderRef.current?.stop();
      } catch {
        /* onstop fires anyway */
      }
      stopTick();
      return;
    }
    if (state.kind === "listening-live") {
      void stopLiveAndSave();
      return;
    }
    // While uploading / transcribing / saving the button is a no-op (the
    // mini-toast shows a spinner instead). Errors and done states reset.
    if (
      state.kind === "uploading" ||
      state.kind === "transcribing" ||
      state.kind === "saving-live"
    ) {
      return;
    }
    if (state.kind === "error" || state.kind === "done") {
      dismissDone();
      // fall through into a fresh start? No — spec says click toggles, so
      // we go back to idle and the user clicks again to re-start.
      return;
    }

    // Idle → refetch settings, validate, start.
    setState({ kind: "requesting" });
    const fresh = await loadSettings();
    const mode = fresh.mode;
    effectiveModeRef.current = mode;

    if (mode === "whisper-cloud" && !fresh.openAiKeyConfigured) {
      setState({
        kind: "error",
        settingsHint: true,
        message: "OpenAI-Key fehlt — Settings → AI Provider.",
      });
      return;
    }
    if (
      mode === "whisper-selfhosted" &&
      !fresh.whisperSelfhostedUrl
    ) {
      setState({
        kind: "error",
        message:
          "Self-Hosted Whisper nicht konfiguriert — siehe DEPLOY-LEAN.md Phase 1.3.",
      });
      return;
    }

    if (mode === "live") {
      startLiveListening();
    } else {
      void startWhisperRecording();
    }
  }

  /* ── Render ───────────────────────────────────────────────────── */

  const isRecording =
    state.kind === "recording-whisper" || state.kind === "listening-live";
  const isBusy =
    state.kind === "uploading" ||
    state.kind === "transcribing" ||
    state.kind === "saving-live" ||
    state.kind === "requesting";

  const tooltip = isRecording
    ? "Aufnahme läuft — klick zum Stoppen"
    : "Sprachaufnahme starten";

  const buttonSize = isMobile ? 44 : 36;

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        title={tooltip}
        aria-label={tooltip}
        aria-pressed={isRecording}
        disabled={isBusy}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          background: isRecording ? "rgba(239,68,68,0.18)" : C.elevated,
          border: `1px solid ${isRecording ? C.err : C.border}`,
          borderRadius: 7,
          padding: 0,
          width: buttonSize,
          height: buttonSize,
          minHeight: 36,
          cursor: isBusy ? "default" : "pointer",
          color: C.text,
          flexShrink: 0,
          // Pulse the border subtly while recording — same pattern the
          // full recorder uses for the inline indicator.
          animation: isRecording
            ? "lokyy-qbtn-pulse 1.4s ease-in-out infinite"
            : "none",
        }}
      >
        <style>{`
          @keyframes lokyy-qbtn-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.35); }
            50%      { box-shadow: 0 0 0 4px rgba(239,68,68,0); }
          }
        `}</style>
        {isBusy ? (
          <Spinner size={18} />
        ) : (
          <Mic
            size={isMobile ? 22 : 20}
            style={{ color: isRecording ? C.err : C.accent }}
          />
        )}
        {isRecording && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: C.err,
              boxShadow: "0 0 4px rgba(239,68,68,0.7)",
            }}
          />
        )}
      </button>

      {/* ── Inline toast / banner under the header ────────────────────
        * The button itself stays in the top-bar; everything below sits
        * in a fixed-position banner anchored to the top-right of the
        * viewport. We render only when there's something to show so
        * idle state costs zero DOM. */}
      {state.kind !== "idle" && <QuickToast
        state={state}
        elapsedMs={
          state.kind === "recording-whisper" || state.kind === "listening-live"
            ? state.elapsedMs
            : 0
        }
        onStop={() => void handleClick()}
        onOpenSettings={onOpenSettings}
        onOpenNote={(id) => {
          dismissDone();
          onImported(id);
        }}
        onDismiss={dismissDone}
      />}
    </>
  );
}

/* ── Toast / banner component ─────────────────────────────────────── */

interface QuickToastProps {
  state: ButtonState;
  elapsedMs: number;
  onStop: () => void;
  onOpenSettings: () => void;
  onOpenNote: (id: string) => void;
  onDismiss: () => void;
}

function QuickToast({
  state,
  elapsedMs,
  onStop,
  onOpenSettings,
  onOpenNote,
  onDismiss,
}: QuickToastProps) {
  const baseStyle: React.CSSProperties = {
    position: "fixed",
    top: 56,
    right: 14,
    zIndex: 60,
    minWidth: 260,
    maxWidth: 380,
    padding: "10px 12px",
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontFamily: FONT.ui,
    fontSize: 12.5,
    color: C.text,
  };

  if (
    state.kind === "recording-whisper" ||
    state.kind === "listening-live"
  ) {
    const label =
      state.kind === "listening-live"
        ? "Live-Aufnahme läuft…"
        : "Aufnahme läuft…";
    return (
      <div role="status" aria-live="polite" style={{ ...baseStyle, borderColor: C.err }}>
        <span
          aria-hidden="true"
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: C.err,
            flexShrink: 0,
            animation: "lokyy-qbtn-dot 1.2s ease-in-out infinite",
          }}
        />
        <style>{`
          @keyframes lokyy-qbtn-dot {
            0%, 100% { opacity: 1; }
            50%      { opacity: 0.45; }
          }
        `}</style>
        <span style={{ flex: 1 }}>
          {label}{" "}
          <span
            style={{
              fontFamily: FONT.mono,
              color: C.textDim,
              fontVariantNumeric: "tabular-nums",
              fontSize: 11,
            }}
          >
            {fmtDuration(elapsedMs)}
          </span>
        </span>
        <button
          type="button"
          onClick={onStop}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: C.accent,
            color: "#1a1110",
            border: "none",
            borderRadius: 6,
            padding: "5px 9px",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: 12,
            fontFamily: FONT.ui,
          }}
        >
          <Square size={11} fill="currentColor" />
          Stop
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          title="Einstellungen → Voice"
          aria-label="Einstellungen"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            width: 28,
            height: 28,
            cursor: "pointer",
            color: C.textDim,
          }}
        >
          <SettingsIcon size={14} />
        </button>
      </div>
    );
  }

  if (state.kind === "requesting") {
    return (
      <div role="status" aria-live="polite" style={baseStyle}>
        <Spinner size={14} />
        <span style={{ flex: 1 }}>Mikro-Zugriff…</span>
      </div>
    );
  }

  if (state.kind === "uploading") {
    return (
      <div role="status" aria-live="polite" style={baseStyle}>
        <Spinner size={14} />
        <span style={{ flex: 1 }}>Lade hoch…</span>
      </div>
    );
  }

  if (state.kind === "transcribing") {
    return (
      <div role="status" aria-live="polite" style={baseStyle}>
        <Spinner size={14} />
        <span style={{ flex: 1 }}>Whisper transkribiert…</span>
      </div>
    );
  }

  if (state.kind === "saving-live") {
    return (
      <div role="status" aria-live="polite" style={baseStyle}>
        <Spinner size={14} />
        <span style={{ flex: 1 }}>Speichere Notiz im Vault…</span>
      </div>
    );
  }

  if (state.kind === "done") {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          ...baseStyle,
          borderColor: C.ok,
          background: "rgba(127,163,122,0.10)",
        }}
      >
        <Check size={16} style={{ color: C.ok, flexShrink: 0 }} />
        <span style={{ flex: 1, color: C.text, wordBreak: "break-all" }}>
          Notiz erstellt:{" "}
          <code
            style={{
              fontFamily: FONT.mono,
              color: C.gold,
              fontSize: 11.5,
            }}
          >
            {state.notePath}
          </code>
        </span>
        {state.noteId && (
          <button
            type="button"
            onClick={() => onOpenNote(state.noteId)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: C.accent,
              color: "#1a1110",
              border: "none",
              borderRadius: 6,
              padding: "5px 9px",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 12,
              fontFamily: FONT.ui,
            }}
          >
            Öffnen <ArrowUpRight size={11} />
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Schließen"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: C.textDim,
            padding: 2,
          }}
        >
          <XIcon size={14} />
        </button>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div
        role="alert"
        style={{
          ...baseStyle,
          borderColor: C.err,
          background: "rgba(239,68,68,0.08)",
          alignItems: "flex-start",
        }}
      >
        <AlertTriangle
          size={16}
          style={{ color: C.err, flexShrink: 0, marginTop: 1 }}
        />
        <span style={{ flex: 1, color: C.text, lineHeight: 1.45 }}>
          {state.message}
        </span>
        {state.settingsHint && (
          <button
            type="button"
            onClick={onOpenSettings}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: C.elevated,
              color: C.text,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: "5px 9px",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 12,
              fontFamily: FONT.ui,
            }}
          >
            Settings
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Schließen"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: C.textDim,
            padding: 2,
          }}
        >
          <XIcon size={14} />
        </button>
      </div>
    );
  }

  return null;
}

export default VoiceQuickButton;
