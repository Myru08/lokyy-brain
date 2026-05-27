import { useEffect, useRef, useState } from "react";
import type { PipeJob } from "@lokyy/shared";
import {
  Mic,
  Square,
  Trash2,
  Upload,
  Check,
  AlertTriangle,
  ArrowUpRight,
} from "lucide-react";
import { C, FONT } from "./theme.js";
import { Spinner } from "./Spinner.js";

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
  | { kind: "error"; message: string };

interface VoiceRecorderProps {
  /** Called with the resulting note id when transcription finishes. */
  onTranscribed: (noteId: string) => void;
  /** Whether the parent panel is currently visible. Recorder auto-cancels when false. */
  active: boolean;
  /** Optional language hint for Whisper (ISO-639-1) — "" / "auto" = auto-detect. */
  defaultLanguage?: string;
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

export function VoiceRecorder({
  onTranscribed,
  active,
  defaultLanguage = "",
}: VoiceRecorderProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [title, setTitle] = useState<string>(`Voice-Notiz ${fmtTimestamp()}`);
  const [language, setLanguage] = useState<string>(defaultLanguage);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);
  // The current preview URL — kept on the side so cleanup can revoke it
  // even after the state has moved on (e.g. discard while playing).
  const previewUrlRef = useRef<string | null>(null);

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
    setState({ kind: "idle" });
    setTitle(`Voice-Notiz ${fmtTimestamp()}`);
  };

  /* ── Lifecycle: cancel on unmount or panel-close ──────────────────── */

  useEffect(() => {
    if (!active) {
      // Panel closed — drop any in-flight recording / upload.
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
          <p
            style={{
              margin: 0,
              fontSize: 11.5,
              color: C.textDim,
              lineHeight: 1.5,
            }}
          >
            Sprachaufnahme — wird per Whisper transkribiert und als Capture in{" "}
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
