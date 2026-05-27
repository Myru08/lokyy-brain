import { useEffect, useRef, useState } from "react";
import type { Note, PipeJob } from "@lokyy/shared";
import {
  Mic,
  Square,
  Trash2,
  Upload,
  Check,
  AlertTriangle,
  ArrowUpRight,
  Radio,
  Brain,
} from "lucide-react";
import { C, FONT } from "./theme.js";
import { Spinner } from "./Spinner.js";

/* ── Web-Speech-API types ─────────────────────────────────────────────
 * The Web-Speech-API is non-standard and not in @types/dom. We declare
 * the minimum surface we use here so the file remains self-contained
 * (no new npm deps, no global lib augmentation that leaks to the rest
 * of the PWA). All fields are typed loosely on purpose — different
 * vendors omit/rename pieces.
 * ─────────────────────────────────────────────────────────────────── */
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

/**
 * Voice-Recorder — Sprachaufnahme-Tab im ImportPanel.
 *
 * Pipeline:
 *   1. getUserMedia({ audio: true }) → MediaRecorder (audio/webm;codecs=opus)
 *   2. Stop → Blob; Vorschau via <audio controls>
 *   3. Upload via FormData → POST /api/pipes/voice → { jobId }
 *   4. Poll /api/pipes/{jobId} alle 1.5s bis status === "done" | "failed"
 *   5. Done → resultNoteId → Callback in ImportPanel → öffnet Notiz im Editor
 *
 * State-Maschine:
 *
 *      ┌──────┐ click ┌─────────────────────┐ grant ┌───────────┐ stop ┌─────────┐
 *      │ idle │──────▶│ requesting-permission│──────▶│ recording │─────▶│ stopped │
 *      └──────┘       └─────────────────────┘       └───────────┘       └─────────┘
 *         ▲                    │ deny                 │ auto-stop          │
 *         │                    ▼                      ▼                    │ upload
 *         │           ┌────────────────────┐   ┌──────────────┐            ▼
 *         │           │ permission-denied  │   │ (auto-stop @ │     ┌───────────┐
 *         │           └────────────────────┘   │  10 min)     │     │ uploading │
 *         │                                    └──────────────┘     └───────────┘
 *         │                                                               │
 *         │       ┌─────┐         ┌──────┐         ┌──────────────┐       │
 *         └───────│ done│◀────────│ error│◀────────│ transcribing │◀──────┘
 *         reset  └─────┘ retry   └──────┘ fail    └──────────────┘  202
 *
 * Hard limits:
 *   - 10 min hard auto-stop (Whisper API 25MB-Limit).
 *   - 9 min Warnung.
 *   - Blob > 25MB pre-upload → error, kein Network-Roundtrip.
 *
 * Browser-Compat: getUserMedia + MediaRecorder verlangen secure context
 * (https oder localhost). iOS Safari unterstützt MediaRecorder seit 14.5
 * (April 2021), aber NICHT audio/webm — wir fallen auf den Browser-Default
 * (audio/mp4) zurück, wenn webm/opus nicht supported ist.
 */

const MAX_DURATION_MS = 10 * 60 * 1000; // 10 min
const WARN_DURATION_MS = 9 * 60 * 1000; // 9 min
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
const POLL_INTERVAL_MS = 1500;

type State =
  | { kind: "idle" }
  | { kind: "requesting-permission" }
  | { kind: "permission-denied"; message: string }
  | { kind: "recording"; startedAt: number; elapsedMs: number; warned: boolean }
  | { kind: "stopped"; blob: Blob; mimeType: string; previewUrl: string; durationMs: number }
  | { kind: "uploading"; sizeBytes: number }
  | { kind: "transcribing"; jobId: string }
  | { kind: "done"; noteId: string; notePath: string }
  | { kind: "error"; message: string }
  /* ── Web-Speech live-mode states ────────────────────────────────
   * "live-listening": recognition is running, interim+final accumulating.
   * "live-stopped":  user stopped — transcript ready to edit + save.
   * "live-saving":   POSTing to /api/vault/note + PUTting frontmatter.
   * Other states ("permission-denied", "error", "done") are reused.
   *
   * `target` selects the destination for the finalized speech segments:
   *   "capture" — accumulate in finalText, save as capture-note on Stop
   *   "editor"  — stream each finalized segment to the parent's editor via
   *               onLiveEditorAppend, no per-segment local accumulation
   * ─────────────────────────────────────────────────────────────── */
  | { kind: "live-listening"; startedAt: number; elapsedMs: number; finalText: string; interimText: string; target: LiveTarget }
  | { kind: "live-stopped"; transcript: string; durationMs: number; target: LiveTarget }
  | { kind: "live-saving" }
  /** Editor-target Live recording finished — show a "Fertig" button that
   * just closes the panel via onTranscribed (parent treats it as "open
   * note", which it already did at start). */
  | { kind: "live-editor-finished"; noteId: string; notePath: string; durationMs: number };

type Mode = "live" | "whisper";

/** Live-mode destination for the finalized speech segments. */
type LiveTarget = "capture" | "editor";

interface VoiceRecorderProps {
  /** Called with the resulting note id when transcription finishes. */
  onTranscribed: (noteId: string) => void;
  /** Whether the parent panel is currently visible. Recorder auto-cancels when false. */
  active: boolean;
  /** Optional language hint for Whisper (ISO-639-1) — "" / "auto" = auto-detect. */
  defaultLanguage?: string;
  /**
   * Optional live-in-editor integration. When provided, a second target option
   * appears in Live mode: "Live in neuen Editor schreiben". Picking it makes
   * the recorder
   *   1. fire `onLiveEditorRequested(noteId, path)` once the empty note exists
   *      (parent opens it in the editor),
   *   2. fire `onLiveEditorAppend(segment)` for every finalized speech segment
   *      while recording (parent appends to the open editor's body),
   *   3. fire `onLiveEditorStopped()` when the user presses Stop.
   * If `onLiveEditorAppend` is NOT provided, the toggle is hidden and only
   * the standard capture-note path is offered.
   */
  onLiveEditorRequested?: (noteId: string, notePath: string) => void;
  onLiveEditorAppend?: (segment: string) => void;
  onLiveEditorStopped?: () => void;
  /**
   * Optional: parent reports whether the user has switched away from the
   * live-target note in the editor. The recorder uses this only to surface a
   * warning chip — it keeps appending (silently) to whatever the parent
   * decides the destination is.
   */
  liveEditorOffTarget?: boolean;
}

/** Pick the first supported audio mime-type — prefer opus for size + quality. */
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4", // iOS Safari fallback
    "audio/mpeg",
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // some browsers throw on unknown types
    }
  }
  return ""; // browser default
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LANGS: { value: string; label: string }[] = [
  { value: "", label: "Auto-Erkennung" },
  { value: "de", label: "Deutsch" },
  { value: "en", label: "Englisch" },
  { value: "fr", label: "Französisch" },
  { value: "es", label: "Spanisch" },
];

/**
 * Live-mode languages. Web-Speech needs a BCP-47 region tag (de-DE not
 * just `de`), and "auto-detect" isn't a thing in the spec — most browsers
 * silently fall back to the OS default. We force a pick so the user knows
 * what they're getting. Maps the dropdown value to a BCP-47 tag.
 */
const LIVE_LANGS: { value: string; bcp47: string; label: string }[] = [
  { value: "de", bcp47: "de-DE", label: "Deutsch" },
  { value: "en", bcp47: "en-US", label: "Englisch" },
  { value: "fr", bcp47: "fr-FR", label: "Französisch" },
  { value: "es", bcp47: "es-ES", label: "Spanisch" },
];

/** YYYY-MM-DD for vault paths. */
function fmtDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Filesystem-safe slug for vault paths — kebab-case, ASCII-only, max 48 chars. */
function slugify(input: string): string {
  const base = input
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "voice";
}

/**
 * Build a SPEC-valid capture frontmatter block plus body. The note id and
 * created-timestamp come from the freshly created note so we don't fight
 * the server over identity (frontmatter lifecycle rule: id/created are
 * immutable once a note exists, type/title/extra fields are taken from
 * the incoming PUT body).
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
  const lines = [
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
  ];
  return lines.join("\n");
}

export function VoiceRecorder({
  onTranscribed,
  active,
  defaultLanguage = "",
  onLiveEditorRequested,
  onLiveEditorAppend,
  onLiveEditorStopped,
  liveEditorOffTarget = false,
}: VoiceRecorderProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [title, setTitle] = useState<string>(`Voice-Notiz ${fmtTimestamp()}`);
  const [language, setLanguage] = useState<string>(defaultLanguage);
  /**
   * Live-mode destination preference (per-session — spec says no
   * persistence needed). Only meaningful when `onLiveEditorAppend` is wired
   * up; otherwise the toggle is hidden and the value is ignored.
   */
  const liveEditorAvailable = typeof onLiveEditorAppend === "function";
  const [liveTarget, setLiveTarget] = useState<LiveTarget>("capture");
  /** Stable ref the recognition onresult reads (no re-binding per render). */
  const liveTargetRef = useRef<LiveTarget>("capture");
  liveTargetRef.current = liveTarget;
  const onLiveEditorAppendRef = useRef<typeof onLiveEditorAppend>(onLiveEditorAppend);
  onLiveEditorAppendRef.current = onLiveEditorAppend;
  /** Note id created up-front for editor-target Live recordings (for the
   *  "Fertig" screen + so we can echo it back as onTranscribed). */
  const liveEditorNoteRef = useRef<{ id: string; path: string } | null>(null);

  /* ── Mode switch ──────────────────────────────────────────────────
   * `hasWebSpeech` is determined once at mount; if the browser doesn't
   * expose SpeechRecognition we hide the Live pill entirely and force
   * Whisper. Otherwise Live is the default (cheap + private).
   * ─────────────────────────────────────────────────────────────── */
  const [hasWebSpeech, setHasWebSpeech] = useState<boolean>(false);
  const [mode, setMode] = useState<Mode>("whisper");
  // For Live mode the dropdown can't be "" (auto) — pick a sane default.
  const [liveLang, setLiveLang] = useState<string>(
    defaultLanguage && LIVE_LANGS.some((l) => l.value === defaultLanguage)
      ? defaultLanguage
      : "de",
  );

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);
  // The current preview URL — kept on the side so cleanup can revoke it
  // even after the state has moved on (e.g. discard while playing).
  const previewUrlRef = useRef<string | null>(null);

  /* ── Live-mode refs ───────────────────────────────────────────────
   * The SpeechRecognition instance, plus a `userStoppedRef` flag we
   * flip BEFORE calling `recognition.stop()` so the `onend` handler
   * knows not to auto-restart. Without this flag we'd loop forever
   * because some browsers (Chrome on long sessions) end the
   * recognizer themselves after a silence window or a fixed timeout.
   * `liveTickRef` runs the elapsed-time counter.
   * ─────────────────────────────────────────────────────────────── */
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const userStoppedRef = useRef<boolean>(false);
  const liveTickRef = useRef<number | null>(null);
  const finalTextRef = useRef<string>("");
  const liveStartedAtRef = useRef<number>(0);

  /* ── Web-Speech availability check (mount-only) ────────────────── */
  useEffect(() => {
    const supported = getSpeechRecognitionCtor() !== null;
    setHasWebSpeech(supported);
    setMode(supported ? "live" : "whisper");
  }, []);

  /* ── Cleanup helpers ──────────────────────────────────────────────── */

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

  const teardownStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  };

  const revokePreview = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  };

  const stopLiveTick = () => {
    if (liveTickRef.current !== null) {
      window.clearInterval(liveTickRef.current);
      liveTickRef.current = null;
    }
  };

  /**
   * Tear down the SpeechRecognition instance. Flips `userStoppedRef`
   * BEFORE calling stop/abort so the `onend` handler returns early
   * instead of restarting. Also nukes the event handlers so a late
   * `onresult` from the browser can't mutate state after teardown.
   */
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
        // ignore — some browsers throw if already stopped
      }
      recognitionRef.current = null;
    }
    stopLiveTick();
    finalTextRef.current = "";
  };

  /** Hard reset back to idle — releases every resource the recorder holds. */
  const resetAll = () => {
    stopTick();
    stopPoll();
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch {
      // ignore — recorder may already be stopped
    }
    teardownStream();
    revokePreview();
    teardownRecognition();
    setState({ kind: "idle" });
    setTitle(`Voice-Notiz ${fmtTimestamp()}`);
  };

  /* ── Lifecycle: cancel on unmount or panel-close ──────────────────── */

  useEffect(() => {
    if (!active) {
      // Panel closed — drop any in-flight recording / upload / live session.
      stopTick();
      stopPoll();
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      teardownStream();
      revokePreview();
      teardownRecognition();
    }
  }, [active]);

  useEffect(() => {
    return () => {
      stopTick();
      stopPoll();
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      teardownStream();
      revokePreview();
      teardownRecognition();
    };
  }, []);

  /* ── State transitions ───────────────────────────────────────────── */

  async function startRecording() {
    // Capability check up front — secure-context errors are cryptic from
    // getUserMedia, so we surface our own message.
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function" ||
      typeof MediaRecorder === "undefined"
    ) {
      setState({
        kind: "error",
        message:
          "Browser unterstützt keine Sprachaufnahme (MediaRecorder fehlt). " +
          "Aufnahme braucht einen aktuellen Chrome/Edge/Firefox oder iOS Safari ≥ 14.5 über HTTPS.",
      });
      return;
    }

    setState({ kind: "requesting-permission" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const e = err as DOMException;
      const denied =
        e?.name === "NotAllowedError" || e?.name === "SecurityError";
      setState({
        kind: denied ? "permission-denied" : "error",
        message: denied
          ? "Mikrofon-Zugriff verweigert. Erlaube ihn in den Browser-Einstellungen und lade die Seite neu."
          : `Aufnahme nicht möglich: ${e?.message ?? "unbekannter Fehler"}`,
      });
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      teardownStream();
      setState({
        kind: "error",
        message: `MediaRecorder konnte nicht gestartet werden: ${(err as Error).message ?? err}`,
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
        chunksRef.current[0]?.type ?? mimeType ?? "audio/webm";
      const blob = new Blob(chunksRef.current, { type: blobType });
      teardownStream();

      // Empty / failed recording.
      if (blob.size === 0) {
        setState({
          kind: "error",
          message: "Aufnahme leer — Mikrofon hat keine Daten geliefert.",
        });
        return;
      }

      // Pre-flight size check — Whisper hard limit 25MB.
      if (blob.size > WHISPER_MAX_BYTES) {
        setState({
          kind: "error",
          message: `Aufnahme zu lang/groß (${fmtSize(blob.size)} > 25 MB). Whisper-Limit. Bitte kürzer aufnehmen.`,
        });
        return;
      }

      revokePreview();
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;

      // Pull elapsed from current state — we still have it in flight.
      let elapsedMs = 0;
      setState((prev) => {
        if (prev.kind === "recording") elapsedMs = prev.elapsedMs;
        return {
          kind: "stopped",
          blob,
          mimeType: blobType,
          previewUrl: url,
          durationMs: elapsedMs,
        };
      });
    };

    recorder.onerror = (ev) => {
      // MediaRecorderErrorEvent is non-standard; fall back to a generic msg.
      const msg =
        (ev as unknown as { error?: DOMException }).error?.message ??
        "MediaRecorder-Fehler";
      stopTick();
      teardownStream();
      setState({ kind: "error", message: msg });
    };

    // 1-second timeslice → reliable ondataavailable on iOS Safari.
    try {
      recorder.start(1000);
    } catch (err) {
      teardownStream();
      setState({
        kind: "error",
        message: `Aufnahme konnte nicht gestartet werden: ${(err as Error).message ?? err}`,
      });
      return;
    }

    const startedAt = Date.now();
    setState({ kind: "recording", startedAt, elapsedMs: 0, warned: false });

    // Tick — 250ms ist flüssig genug für die mm:ss-Anzeige und billig.
    tickRef.current = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;

      // Hard-stop at 10 min.
      if (elapsedMs >= MAX_DURATION_MS) {
        try {
          recorderRef.current?.stop();
        } catch {
          // ignore — onstop wird trotzdem firen
        }
        return;
      }

      setState((prev) =>
        prev.kind === "recording"
          ? {
              ...prev,
              elapsedMs,
              warned: prev.warned || elapsedMs >= WARN_DURATION_MS,
            }
          : prev,
      );
    }, 250);
  }

  function stopRecording() {
    try {
      recorderRef.current?.stop();
    } catch {
      // onstop fires anyway
    }
    stopTick();
  }

  function cancelRecording() {
    stopTick();
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        // Detach onstop so we don't transition into "stopped" with a half-recording.
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
    } catch {
      // ignore
    }
    teardownStream();
    revokePreview();
    setState({ kind: "idle" });
  }

  function discardStopped() {
    revokePreview();
    setState({ kind: "idle" });
    setTitle(`Voice-Notiz ${fmtTimestamp()}`);
  }

  async function uploadStopped() {
    if (state.kind !== "stopped") return;
    const { blob, mimeType } = state;

    if (blob.size > WHISPER_MAX_BYTES) {
      setState({
        kind: "error",
        message: `Aufnahme zu lang/groß (${fmtSize(blob.size)} > 25 MB). Whisper-Limit.`,
      });
      return;
    }

    setState({ kind: "uploading", sizeBytes: blob.size });

    // File extension derived from mime — backend uses this to pick the
    // right Whisper decoder.
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
    form.append("title", title.trim() || `Voice-Notiz ${fmtTimestamp()}`);
    form.append("language", language);

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
      revokePreview();
      setState({
        kind: "error",
        message: `Upload fehlgeschlagen: ${(err as Error).message ?? err}`,
      });
      return;
    }

    revokePreview();
    setState({ kind: "transcribing", jobId });

    // Poll the pipe-queue endpoint. We use the existing list endpoint
    // and filter by id — there's no dedicated `/api/pipes/{id}` route.
    stopPoll();
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const r = await fetch("/api/pipes", { credentials: "include" });
          if (!r.ok) return; // transient — keep polling
          const jobs = (await r.json()) as PipeJob[];
          const job = jobs.find((j) => j.id === jobId);
          if (!job) return; // not yet visible — keep polling
          if (job.status === "done") {
            stopPoll();
            const noteId = job.resultNoteId ?? "";
            setState({
              kind: "done",
              noteId,
              notePath: noteId ? `${noteId}.md` : "(unbekannt)",
            });
          } else if (job.status === "error") {
            stopPoll();
            setState({
              kind: "error",
              message: `Transkription fehlgeschlagen: ${job.error ?? "unbekannter Fehler"}`,
            });
          }
        } catch {
          // network blip — keep polling
        }
      })();
    }, POLL_INTERVAL_MS);
  }

  /* ── Live mode (Web-Speech-API) ───────────────────────────────────
   * No audio upload, no API key — the browser does ASR locally
   * (Chrome routes to Google's cloud under the hood, Safari uses
   * on-device Siri ASR; either way: no work for us).
   * ─────────────────────────────────────────────────────────────── */

  /**
   * Start a Live-mode session. `target` decides where finalized speech
   * segments go:
   *   "capture" — accumulate locally (finalTextRef), save once on Stop
   *   "editor"  — POST/PUT an empty note up-front, ask the parent to open
   *               it, then stream each segment via onLiveEditorAppend
   *               (App.tsx appends to the open editor's body)
   */
  async function startLive(target: LiveTarget = liveTarget) {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setState({
        kind: "error",
        message:
          "Live-Modus nicht unterstützt — dein Browser hat keine SpeechRecognition. " +
          "Chrome/Edge oder iOS Safari 14.5+ probieren.",
      });
      return;
    }

    // Belt-and-suspenders: kill any previous recognizer before starting.
    teardownRecognition();
    userStoppedRef.current = false;
    finalTextRef.current = "";
    liveEditorNoteRef.current = null;

    // ── Editor-target pre-recording: create the empty note FIRST so it's
    // open in the editor before the user says a word. We deliberately
    // serialize the two HTTP calls (POST + PUT capture frontmatter) here
    // — speech recognition won't start until the note exists. The user
    // sees a brief "Bereite Notiz vor…" state via live-saving spinner.
    if (target === "editor") {
      if (!liveEditorAvailable) {
        setState({
          kind: "error",
          message:
            "Live-in-Editor nicht verfügbar — parent component hat keinen onLiveEditorAppend-Callback registriert.",
        });
        return;
      }
      setState({ kind: "live-saving" });
      const finalTitle = title.trim() || `Voice-Notiz ${fmtTimestamp()}`;
      const slug = slugify(finalTitle);
      const path = `30_captures/voice/${fmtDate()}-${slug}`;

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
        setState({
          kind: "error",
          message: `Notiz konnte nicht angelegt werden: ${
            (err as Error).message ?? err
          }`,
        });
        return;
      }

      // Step 2: PUT capture frontmatter so the file is SPEC-valid before
      // the user starts typing/speaking. Body is empty for now — segments
      // are appended into the open editor by the parent, and the regular
      // 5s save-debounce in App.tsx persists them.
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
        language: liveLang,
        transcript: "",
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
        setState({
          kind: "error",
          message: `Notiz erstellt (${created.path}) aber Frontmatter konnte nicht geschrieben werden: ${
            (err as Error).message ?? err
          }`,
        });
        return;
      }

      liveEditorNoteRef.current = { id: created.id, path: created.path };
      // Tell the parent to open the note in the editor BEFORE we start
      // recognition. We wait one paint cycle so the editor mounts with the
      // new note's body before the first onresult fires.
      onLiveEditorRequested?.(created.id, created.path);
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, 60),
      );
    }
    // Fall through into the regular live-recognition setup below.

    const bcp47 =
      LIVE_LANGS.find((l) => l.value === liveLang)?.bcp47 ?? "de-DE";

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Ctor();
    } catch (err) {
      setState({
        kind: "error",
        message: `SpeechRecognition konnte nicht initialisiert werden: ${
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
      let interim = "";
      let appended = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res) continue;
        const alt = res[0];
        if (!alt) continue;
        if (res.isFinal) {
          appended += alt.transcript;
        } else {
          interim += alt.transcript;
        }
      }
      const trimmed = appended.trim();
      if (trimmed) {
        if (liveTargetRef.current === "editor") {
          // Editor mode: each finalized segment is shipped to the parent
          // exactly once. We do NOT accumulate locally (the editor is the
          // source of truth now). The parent decides spacing/paragraphing.
          //
          // Note on flooding: the Web-Speech-API fires `onresult` once per
          // grammar-segment, NOT per character. A natural sentence pause
          // yields one event with `isFinal: true` and the full sentence.
          // Interim results stream more frequently but are discarded here
          // (only the floating ghost-text panel below uses them). No
          // batching/debouncing needed — typical rate is < 1/s.
          try {
            onLiveEditorAppendRef.current?.(trimmed);
          } catch {
            /* swallow — parent log; recognition must keep going */
          }
        } else {
          // Capture mode: accumulate locally; saved on Stop.
          const sep =
            finalTextRef.current && !finalTextRef.current.endsWith(" ")
              ? " "
              : "";
          finalTextRef.current = finalTextRef.current + sep + trimmed;
        }
      }
      setState((prev) =>
        prev.kind === "live-listening"
          ? {
              ...prev,
              // For editor-target the local finalText stays empty (parent
              // owns it); for capture it mirrors the ref so the on-screen
              // transcript box updates.
              finalText:
                prev.target === "editor" ? "" : finalTextRef.current,
              interimText: interim,
            }
          : prev,
      );
    };

    recognition.onerror = (ev: SpeechRecognitionErrorEventLike) => {
      // `no-speech` and `aborted` are routine — silence, or our own stop().
      // For the latter we already flipped `userStoppedRef`, so swallow it.
      if (ev.error === "aborted" && userStoppedRef.current) return;

      const msgMap: Record<string, string> = {
        "no-speech":
          "Keine Sprache erkannt. Mikro lauter stellen oder näher dran sprechen.",
        "audio-capture":
          "Kein Mikrofon verfügbar. Prüfe das Eingabegerät in den System-Einstellungen.",
        "not-allowed":
          "Mikrofon-Zugriff verweigert. Erlaube ihn in den Browser-Einstellungen.",
        network:
          "Netzwerk-Fehler bei der Spracherkennung. Live-Modus braucht für viele Browser eine Internet-Verbindung.",
        "service-not-allowed":
          "Spracherkennungs-Dienst nicht erlaubt — Browser blockiert ihn.",
        "language-not-supported": `Sprache "${bcp47}" wird von diesem Browser nicht unterstützt. Andere Sprache wählen.`,
        "bad-grammar": "Grammatik-Fehler in der Spracherkennung.",
      };
      const userMsg =
        msgMap[ev.error] ??
        `Spracherkennungs-Fehler: ${ev.error}${
          ev.message ? ` (${ev.message})` : ""
        }`;

      // `no-speech` while still listening: don't kill the session — let
      // onend auto-restart so the recognizer picks up again when the user
      // resumes talking. For everything else: bail with an error state.
      if (ev.error === "no-speech" && !userStoppedRef.current) return;

      teardownRecognition();
      setState({ kind: "error", message: userMsg });
    };

    recognition.onend = () => {
      // Auto-restart unless the user pressed Stop.
      //
      // WHY: Chrome and most Chromium-based browsers terminate the
      // recognizer after ~60 s of audio or after a silence window,
      // regardless of `continuous: true`. Without auto-restart the
      // session would silently die mid-thought. The `userStoppedRef`
      // flag is set in `stopLive()` BEFORE calling stop(), so we know
      // here whether the end was intentional.
      if (userStoppedRef.current) return;
      const r = recognitionRef.current;
      if (!r) return;
      try {
        r.start();
      } catch {
        // Some browsers throw "InvalidStateError" if start() is called
        // too quickly after end. One retry on the next tick is enough.
        window.setTimeout(() => {
          if (userStoppedRef.current) return;
          try {
            recognitionRef.current?.start();
          } catch {
            // give up silently — user can hit Stop and start again
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
    setState({
      kind: "live-listening",
      startedAt,
      elapsedMs: 0,
      finalText: "",
      interimText: "",
      target,
    });

    stopLiveTick();
    liveTickRef.current = window.setInterval(() => {
      setState((prev) =>
        prev.kind === "live-listening"
          ? { ...prev, elapsedMs: Date.now() - startedAt }
          : prev,
      );
    }, 250);
  }

  function stopLive() {
    if (state.kind !== "live-listening") return;
    const durationMs = Date.now() - liveStartedAtRef.current;
    const transcript = finalTextRef.current.trim();
    const target = state.target;
    // Flush any remaining interim text as a final segment for editor mode
    // — most browsers do emit a closing final on .stop(), but some (notably
    // Safari) drop the mid-sentence interim text on stop. We capture it
    // here so the user doesn't lose the last half-sentence.
    const interimRemainder =
      state.kind === "live-listening" ? state.interimText.trim() : "";

    // Flip the guard BEFORE calling stop so onend doesn't restart.
    userStoppedRef.current = true;
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
    stopLiveTick();
    // Don't teardown yet — we want a clean stop event; teardown happens
    // on discard/save/reset. (Defensive: nuke handlers so a late onresult
    // doesn't flip us back into live-listening.)
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
    }

    if (target === "editor") {
      // Ship the trailing interim text (if any) as a final segment.
      if (interimRemainder) {
        try {
          onLiveEditorAppendRef.current?.(interimRemainder);
        } catch {
          /* swallow */
        }
      }
      onLiveEditorStopped?.();
      const noteInfo = liveEditorNoteRef.current;
      setState({
        kind: "live-editor-finished",
        noteId: noteInfo?.id ?? "",
        notePath: noteInfo?.path ?? "(unbekannt)",
        durationMs,
      });
      return;
    }

    setState({ kind: "live-stopped", transcript, durationMs, target });
  }

  function discardLive() {
    teardownRecognition();
    setState({ kind: "idle" });
    setTitle(`Voice-Notiz ${fmtTimestamp()}`);
  }

  /**
   * Persist the live transcript as a SPEC-valid `type: capture` note
   * under `30_captures/voice/{date}-{slug}`.
   *
   * Two-step write because the public POST /api/vault/note hard-codes
   * `type: note` server-side (it's a thin wrapper around createNote).
   * To get `type: capture` into the frontmatter we:
   *   1. POST a blank note at the target path → server generates id +
   *      created timestamp, validates as `type: note`.
   *   2. PUT a body containing the full capture frontmatter — saveNote
   *      merges incoming frontmatter, preserves id/created, and writes
   *      `type: capture` (validated against capture.json schema).
   */
  async function saveLive() {
    if (state.kind !== "live-stopped") return;
    const transcript = state.transcript.trim();
    if (!transcript) {
      setState({
        kind: "error",
        message: "Transkript ist leer — nichts zu speichern.",
      });
      return;
    }

    const finalTitle = title.trim() || `Voice-Notiz ${fmtTimestamp()}`;
    const slug = slugify(finalTitle);
    const path = `30_captures/voice/${fmtDate()}-${slug}`;

    setState({ kind: "live-saving" });

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
      setState({
        kind: "error",
        message: `Notiz konnte nicht angelegt werden: ${
          (err as Error).message ?? err
        }`,
      });
      return;
    }

    // Server returns the parsed Note — we need the ULID + created stamp
    // out of the frontmatter for step 2. Re-fetch to get the frontmatter
    // verbatim (the Note shape only exposes a subset).
    let noteId = "";
    let noteCreated = new Date().toISOString();
    try {
      const r = await fetch(
        `/api/notes/${encodeURIComponent(created.id)}`,
        { credentials: "include" },
      );
      if (r.ok) {
        const note = (await r.json()) as Note & { body: string };
        // Pull `id:` and `created:` lines out of the YAML frontmatter.
        const fm = note.body.split(/\n---\n/)[0] ?? "";
        const idMatch = fm.match(/\bid:\s*([0-9A-HJKMNP-TV-Z]{26})/);
        const createdMatch = fm.match(/\bcreated:\s*([^\n]+)/);
        if (idMatch) noteId = idMatch[1] ?? "";
        if (createdMatch) noteCreated = (createdMatch[1] ?? "").trim();
      }
    } catch {
      // Non-fatal — saveNote will preserve whatever's on disk for id/created,
      // and our PUT body only needs them to round-trip the schema.
    }

    // Step 2: PUT the body with capture frontmatter.
    const captureBody = buildCaptureBody({
      noteId: noteId || "00000000000000000000000000",
      noteCreated,
      title: finalTitle,
      language: liveLang,
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
      // Note was created but content failed to land — surface clearly so
      // the user knows to open it and fix it manually.
      setState({
        kind: "error",
        message: `Notiz erstellt (${created.path}) aber Transkript konnte nicht gespeichert werden: ${
          (err as Error).message ?? err
        }`,
      });
      return;
    }

    teardownRecognition();
    setState({
      kind: "done",
      noteId: created.id,
      notePath: created.path,
    });
  }

  /* ── Render ──────────────────────────────────────────────────────── */

  return (
    <div
      style={{
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        color: C.text,
        fontFamily: FONT.ui,
        fontSize: 13,
      }}
    >
      {state.kind === "idle" && (
        <>
          {/* ── Mode switch (Live vs Whisper) ──────────────────────
            * Two pill-style buttons. Hidden entirely when the browser
            * lacks SpeechRecognition — in that case Whisper is the
            * only option and we just show the original UI plus a small
            * compat note.
            * ──────────────────────────────────────────────────── */}
          {hasWebSpeech ? (
            <div
              role="tablist"
              aria-label="Aufnahme-Modus"
              style={{
                display: "flex",
                gap: 6,
                padding: 3,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 999,
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "live"}
                onClick={() => setMode("live")}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "8px 10px",
                  borderRadius: 999,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: FONT.ui,
                  background: mode === "live" ? C.accent : "transparent",
                  color: mode === "live" ? "#1a1110" : C.textDim,
                }}
              >
                <Radio size={13} />
                Live (Browser, kostenlos)
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "whisper"}
                onClick={() => setMode("whisper")}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "8px 10px",
                  borderRadius: 999,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: FONT.ui,
                  background: mode === "whisper" ? C.accent : "transparent",
                  color: mode === "whisper" ? "#1a1110" : C.textDim,
                }}
              >
                <Brain size={13} />
                Hochwertig (Whisper)
              </button>
            </div>
          ) : (
            <div
              style={{
                padding: "8px 10px",
                background: C.elevated,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                color: C.textFaint,
                fontSize: 10.5,
                lineHeight: 1.5,
              }}
            >
              Live-Modus nicht unterstützt — dein Browser hat keine
              SpeechRecognition. Chrome/Edge oder iOS Safari 14.5+ probieren.
            </div>
          )}

          {mode === "live" && hasWebSpeech ? (
            <>
              <p
                style={{
                  margin: 0,
                  fontSize: 11.5,
                  color: C.textDim,
                  lineHeight: 1.5,
                }}
              >
                Live-Transkription im Browser — kein Upload, kein API-Key.
                Wähle die Sprache und sprich los; das Transkript baut sich in
                Echtzeit auf.
              </p>

              {/* Live-target chooser: capture-note vs. live-editor.
                * Only rendered when the parent registered the editor sink
                * (onLiveEditorAppend); otherwise the capture-note path is
                * the only sane option and we don't pretend otherwise. */}
              {liveEditorAvailable && (
                <fieldset
                  style={{
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                    padding: "8px 10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    background: C.bg,
                  }}
                >
                  <legend
                    style={{
                      padding: "0 6px",
                      fontSize: 11,
                      color: C.textDim,
                    }}
                  >
                    Ziel
                  </legend>
                  <label
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      cursor: "pointer",
                      fontSize: 12,
                      color: C.text,
                      lineHeight: 1.4,
                    }}
                  >
                    <input
                      type="radio"
                      name="live-target"
                      value="capture"
                      checked={liveTarget === "capture"}
                      onChange={() => setLiveTarget("capture")}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      In Capture-Note speichern{" "}
                      <span style={{ color: C.textFaint, fontSize: 11 }}>
                        (Standard — Notiz wird nach Stop angelegt)
                      </span>
                    </span>
                  </label>
                  <label
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      cursor: "pointer",
                      fontSize: 12,
                      color: C.text,
                      lineHeight: 1.4,
                    }}
                  >
                    <input
                      type="radio"
                      name="live-target"
                      value="editor"
                      checked={liveTarget === "editor"}
                      onChange={() => setLiveTarget("editor")}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      Live in neuen Editor schreiben{" "}
                      <span style={{ color: C.textFaint, fontSize: 11 }}>
                        (Notiz wird sofort angelegt, Text erscheint während du sprichst)
                      </span>
                    </span>
                  </label>
                </fieldset>
              )}

              <label style={{ fontSize: 11, color: C.textDim }}>
                Titel
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginTop: 4,
                    background: C.bg,
                    border: `1px solid ${C.border}`,
                    borderRadius: 7,
                    color: C.text,
                    fontSize: 13,
                    fontFamily: FONT.ui,
                    padding: "8px 10px",
                    outline: "none",
                  }}
                />
              </label>
              <label style={{ fontSize: 11, color: C.textDim }}>
                Sprache
                <select
                  value={liveLang}
                  onChange={(e) => setLiveLang(e.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginTop: 4,
                    background: C.bg,
                    border: `1px solid ${C.border}`,
                    borderRadius: 7,
                    color: C.text,
                    fontSize: 13,
                    fontFamily: FONT.ui,
                    padding: "8px 10px",
                    outline: "none",
                  }}
                >
                  {LIVE_LANGS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void startLive(liveTarget)}
                aria-label="Live-Aufnahme starten"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "16px 0",
                  borderRadius: 10,
                  border: "none",
                  cursor: "pointer",
                  background: C.err,
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: FONT.ui,
                }}
              >
                <Mic size={20} />
                Aufnahme starten
              </button>
              <small style={{ color: C.textFaint, fontSize: 10.5 }}>
                Keine Längen-Begrenzung · läuft komplett im Browser
              </small>
            </>
          ) : (
            <>
              <p
                style={{
                  margin: 0,
                  fontSize: 11.5,
                  color: C.textDim,
                  lineHeight: 1.5,
                }}
              >
                Sprachaufnahme — wird per Whisper transkribiert und als
                Capture in{" "}
                <code style={{ fontFamily: FONT.mono, color: C.gold }}>
                  30_captures/voice/
                </code>{" "}
                abgelegt.
              </p>
              <button
                type="button"
                onClick={() => void startRecording()}
                aria-label="Aufnahme starten"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "16px 0",
                  borderRadius: 10,
                  border: "none",
                  cursor: "pointer",
                  background: C.err,
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 600,
                  fontFamily: FONT.ui,
                }}
              >
                <Mic size={20} />
                Aufnahme starten
              </button>
              <small style={{ color: C.textFaint, fontSize: 10.5 }}>
                Max. 10 Minuten · Whisper-Limit 25 MB
              </small>
            </>
          )}
        </>
      )}

      {state.kind === "requesting-permission" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            color: C.textDim,
          }}
        >
          <Spinner size={16} />
          <span>Browser fragt nach Mikro-Zugriff…</span>
        </div>
      )}

      {state.kind === "permission-denied" && (
        <>
          <div
            style={{
              display: "flex",
              gap: 10,
              padding: "12px 14px",
              background: "rgba(239,68,68,0.08)",
              border: `1px solid ${C.err}`,
              borderRadius: 8,
              color: C.err,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{state.message}</span>
          </div>
          <button
            type="button"
            onClick={resetAll}
            style={{
              padding: "8px 0",
              borderRadius: 7,
              border: `1px solid ${C.border}`,
              background: C.elevated,
              color: C.text,
              cursor: "pointer",
              fontSize: 12.5,
            }}
          >
            Zurück
          </button>
        </>
      )}

      {state.kind === "recording" && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "14px 16px",
              background: C.elevated,
              border: `1px solid ${C.err}`,
              borderRadius: 10,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: C.err,
                animation: "lokyy-rec-pulse 1.2s ease-in-out infinite",
                flexShrink: 0,
              }}
            />
            <style>{`
              @keyframes lokyy-rec-pulse {
                0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(239,68,68,0.5); }
                50%      { opacity: 0.55; box-shadow: 0 0 0 6px rgba(239,68,68,0); }
              }
            `}</style>
            <span style={{ color: C.err, fontWeight: 600, fontSize: 13 }}>
              Aufnahme läuft
            </span>
            <span style={{ flex: 1 }} />
            <span
              style={{
                fontFamily: FONT.mono,
                fontSize: 15,
                color: C.text,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {fmtDuration(state.elapsedMs)}
            </span>
          </div>

          {state.warned && (
            <div
              style={{
                padding: "8px 12px",
                background: "rgba(255,169,77,0.10)",
                border: `1px solid ${C.gold}`,
                borderRadius: 7,
                color: C.gold,
                fontSize: 11.5,
              }}
            >
              Noch &lt; 1 Minute bis zum Auto-Stop (10 min Limit).
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={stopRecording}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "10px 0",
                borderRadius: 8,
                border: "none",
                background: C.accent,
                color: "#1a1110",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <Square size={14} fill="currentColor" />
              Stop
            </button>
            <button
              type="button"
              onClick={cancelRecording}
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.elevated,
                color: C.textDim,
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              Abbrechen
            </button>
          </div>
        </>
      )}

      {state.kind === "stopped" && (
        <>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "10px 12px",
              background: C.elevated,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
            }}
          >
            <audio
              controls
              src={state.previewUrl}
              style={{ width: "100%", display: "block" }}
            />
            <div
              style={{
                display: "flex",
                gap: 10,
                fontSize: 10.5,
                color: C.textFaint,
                fontFamily: FONT.mono,
              }}
            >
              <span>{fmtDuration(state.durationMs)}</span>
              <span>·</span>
              <span>{fmtSize(state.blob.size)}</span>
              <span>·</span>
              <span>{state.mimeType || "audio/webm"}</span>
            </div>
          </div>

          <label style={{ fontSize: 11, color: C.textDim }}>
            Titel
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginTop: 4,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                color: C.text,
                fontSize: 13,
                fontFamily: FONT.ui,
                padding: "8px 10px",
                outline: "none",
              }}
            />
          </label>

          <label style={{ fontSize: 11, color: C.textDim }}>
            Sprache
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginTop: 4,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                color: C.text,
                fontSize: 13,
                fontFamily: FONT.ui,
                padding: "8px 10px",
                outline: "none",
              }}
            >
              {LANGS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => void uploadStopped()}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "10px 0",
                borderRadius: 8,
                border: "none",
                background: C.accent,
                color: "#1a1110",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <Upload size={14} />
              Hochladen &amp; transkribieren
            </button>
            <button
              type="button"
              onClick={discardStopped}
              aria-label="Verwerfen"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "10px 12px",
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.elevated,
                color: C.textDim,
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              <Trash2 size={13} />
              Verwerfen
            </button>
          </div>
        </>
      )}

      {state.kind === "uploading" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            color: C.textDim,
          }}
        >
          <Spinner size={16} />
          <span>Lade hoch… ({fmtSize(state.sizeBytes)})</span>
        </div>
      )}

      {state.kind === "transcribing" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            color: C.textDim,
          }}
        >
          <Spinner size={16} />
          <span>Whisper transkribiert…</span>
        </div>
      )}

      {state.kind === "done" && (
        <>
          <div
            style={{
              display: "flex",
              gap: 10,
              padding: "12px 14px",
              background: "rgba(127,163,122,0.10)",
              border: `1px solid ${C.ok}`,
              borderRadius: 8,
              color: C.ok,
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            <Check size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              Notiz erstellt:{" "}
              <code
                style={{
                  fontFamily: FONT.mono,
                  color: C.text,
                  wordBreak: "break-all",
                }}
              >
                {state.notePath}
              </code>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              disabled={!state.noteId}
              onClick={() => state.noteId && onTranscribed(state.noteId)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "10px 0",
                borderRadius: 8,
                border: "none",
                background: state.noteId ? C.accent : C.elevated,
                color: state.noteId ? "#1a1110" : C.textFaint,
                fontWeight: 600,
                fontSize: 13,
                cursor: state.noteId ? "pointer" : "default",
              }}
            >
              Notiz öffnen <ArrowUpRight size={14} />
            </button>
            <button
              type="button"
              onClick={resetAll}
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.elevated,
                color: C.textDim,
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              Neu
            </button>
          </div>
        </>
      )}

      {state.kind === "live-listening" && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "14px 16px",
              background: C.elevated,
              border: `1px solid ${C.err}`,
              borderRadius: 10,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: C.err,
                animation: "lokyy-rec-pulse 1.2s ease-in-out infinite",
                flexShrink: 0,
              }}
            />
            <style>{`
              @keyframes lokyy-rec-pulse {
                0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(239,68,68,0.5); }
                50%      { opacity: 0.55; box-shadow: 0 0 0 6px rgba(239,68,68,0); }
              }
            `}</style>
            <span style={{ color: C.err, fontWeight: 600, fontSize: 13 }}>
              {state.target === "editor"
                ? "Live → Editor läuft"
                : "Live-Modus läuft"}
            </span>
            <span style={{ flex: 1 }} />
            <span
              style={{
                fontFamily: FONT.mono,
                fontSize: 15,
                color: C.text,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {fmtDuration(state.elapsedMs)}
            </span>
          </div>

          {state.target === "editor" && liveEditorOffTarget && (
            <div
              role="alert"
              style={{
                display: "flex",
                gap: 8,
                padding: "8px 12px",
                background: "rgba(255,169,77,0.10)",
                border: `1px solid ${C.gold}`,
                borderRadius: 7,
                color: C.gold,
                fontSize: 11.5,
                lineHeight: 1.45,
              }}
            >
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                Du hast die Notiz gewechselt — Text geht weiter in die
                ursprüngliche Live-Notiz.
              </span>
            </div>
          )}

          {state.target === "editor" ? (
            /* Editor-target: just show the interim ghost text. The
             * finalized text already lives in the open editor; mirroring
             * it here would be noise and risks drift. */
            <div
              aria-live="polite"
              style={{
                minHeight: 64,
                maxHeight: 160,
                overflowY: "auto",
                padding: "10px 12px",
                background: C.bg,
                border: `1px dashed ${C.border}`,
                borderRadius: 8,
                color: C.textDim,
                fontSize: 12.5,
                lineHeight: 1.5,
                fontFamily: FONT.ui,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontStyle: "italic",
              }}
            >
              {state.interimText ? (
                state.interimText
              ) : (
                <span style={{ color: C.textFaint }}>
                  Sprich los — finalisierte Sätze landen direkt im Editor…
                </span>
              )}
            </div>
          ) : (
            <div
              aria-live="polite"
              style={{
                minHeight: 120,
                maxHeight: 240,
                overflowY: "auto",
                padding: "10px 12px",
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                color: C.text,
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: FONT.ui,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {state.finalText ||
                (!state.interimText && (
                  <span style={{ color: C.textFaint, fontStyle: "italic" }}>
                    Beginn mit Sprechen — das Transkript erscheint hier…
                  </span>
                ))}
              {state.interimText && (
                <span style={{ color: C.textDim, fontStyle: "italic" }}>
                  {state.finalText ? " " : ""}
                  {state.interimText}
                </span>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={stopLive}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "10px 0",
                borderRadius: 8,
                border: "none",
                background: C.accent,
                color: "#1a1110",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <Square size={14} fill="currentColor" />
              Stop
            </button>
            <button
              type="button"
              onClick={discardLive}
              style={{
                padding: "10px 14px",
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.elevated,
                color: C.textDim,
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              Abbrechen
            </button>
          </div>
        </>
      )}

      {state.kind === "live-stopped" && (
        <>
          <div
            style={{
              display: "flex",
              gap: 10,
              fontSize: 10.5,
              color: C.textFaint,
              fontFamily: FONT.mono,
              padding: "6px 2px",
            }}
          >
            <span>Live-Transkript</span>
            <span>·</span>
            <span>{fmtDuration(state.durationMs)}</span>
          </div>

          <label style={{ fontSize: 11, color: C.textDim }}>
            Transkript (editierbar)
            <textarea
              value={state.transcript}
              onChange={(e) =>
                setState({
                  kind: "live-stopped",
                  transcript: e.target.value,
                  durationMs: state.durationMs,
                  target: state.target,
                })
              }
              rows={8}
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginTop: 4,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                color: C.text,
                fontSize: 13,
                fontFamily: FONT.ui,
                padding: "8px 10px",
                outline: "none",
                resize: "vertical",
                lineHeight: 1.55,
              }}
            />
          </label>

          <label style={{ fontSize: 11, color: C.textDim }}>
            Titel
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginTop: 4,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                color: C.text,
                fontSize: 13,
                fontFamily: FONT.ui,
                padding: "8px 10px",
                outline: "none",
              }}
            />
          </label>

          <label style={{ fontSize: 11, color: C.textDim }}>
            Sprache
            <select
              value={liveLang}
              onChange={(e) => setLiveLang(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginTop: 4,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                color: C.text,
                fontSize: 13,
                fontFamily: FONT.ui,
                padding: "8px 10px",
                outline: "none",
              }}
            >
              {LIVE_LANGS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => void saveLive()}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "10px 0",
                borderRadius: 8,
                border: "none",
                background: C.accent,
                color: "#1a1110",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <Check size={14} />
              Notiz speichern
            </button>
            <button
              type="button"
              onClick={discardLive}
              aria-label="Verwerfen"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "10px 12px",
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.elevated,
                color: C.textDim,
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              <Trash2 size={13} />
              Verwerfen
            </button>
          </div>
        </>
      )}

      {state.kind === "live-saving" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            background: C.elevated,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            color: C.textDim,
          }}
        >
          <Spinner size={16} />
          <span>Speichere Notiz im Vault…</span>
        </div>
      )}

      {state.kind === "live-editor-finished" && (
        <>
          <div
            style={{
              display: "flex",
              gap: 10,
              padding: "12px 14px",
              background: "rgba(127,163,122,0.10)",
              border: `1px solid ${C.ok}`,
              borderRadius: 8,
              color: C.ok,
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            <Check size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              Live-Aufnahme beendet — Text steht im Editor.{" "}
              <code
                style={{
                  fontFamily: FONT.mono,
                  color: C.text,
                  wordBreak: "break-all",
                }}
              >
                {state.notePath}
              </code>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: C.textDim,
                  fontFamily: FONT.mono,
                }}
              >
                {fmtDuration(state.durationMs)} aufgenommen
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={resetAll}
            style={{
              padding: "10px 0",
              borderRadius: 8,
              border: "none",
              background: C.accent,
              color: "#1a1110",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Fertig
          </button>
        </>
      )}

      {state.kind === "error" && (
        <>
          <div
            style={{
              display: "flex",
              gap: 10,
              padding: "12px 14px",
              background: "rgba(239,68,68,0.08)",
              border: `1px solid ${C.err}`,
              borderRadius: 8,
              color: C.err,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{state.message}</span>
          </div>
          <button
            type="button"
            onClick={resetAll}
            style={{
              padding: "10px 0",
              borderRadius: 8,
              border: "none",
              background: C.accent,
              color: "#1a1110",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Erneut versuchen
          </button>
        </>
      )}
    </div>
  );
}

export default VoiceRecorder;
