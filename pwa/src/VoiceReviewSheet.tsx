import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Mic, Square, Trash2, Check, AlertTriangle, Loader2 } from "lucide-react";
import { C, FONT } from "./theme.js";
import { TOUCH_TARGET_MIN } from "./responsive.js";
import { mergeTranscript } from "./lib/transcriptMerge.js";

/* ── Web-Speech-API types ─────────────────────────────────────────────
 * The Web-Speech-API is non-standard and not in @types/dom. We declare the
 * minimum surface we use here so the file stays self-contained (mirrors the
 * loosely-typed decls already in VoiceRecorder.tsx). All fields are typed
 * loosely on purpose — vendors omit/rename pieces.
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

const LIVE_LANGS: { value: string; bcp47: string; label: string }[] = [
  { value: "de", bcp47: "de-DE", label: "Deutsch" },
  { value: "en", bcp47: "en-US", label: "Englisch" },
  { value: "fr", bcp47: "fr-FR", label: "Französisch" },
  { value: "es", bcp47: "es-ES", label: "Spanisch" },
];

export interface VoiceReviewSheetProps {
  /** Whether the sheet is open. Closing aborts any in-flight recognition. */
  open: boolean;
  /** Close the sheet (backdrop / X / after a successful insert). */
  onClose: () => void;
  /**
   * Insert the (possibly user-edited) transcript. App.tsx decides where it
   * lands: into the currently-open note via the save path, or — when no note
   * is open — by creating a capture note in `opts.folderPath` with `opts.title`.
   * The `opts` argument is only meaningful for the new-note case (no note
   * open); when a note IS open it is ignored and the text appends to it.
   * Resolves on success; rejects with an Error whose `.message` is surfaced.
   */
  onInsert: (
    transcript: string,
    opts?: { folderPath?: string; title?: string },
  ) => Promise<void>;
  /** Title of the note the transcript will be inserted into (display hint). */
  targetTitle?: string | null;
  /**
   * Vault folder paths (recursive) for the new-note folder picker. Only used
   * when no note is open. Default selection is `30_captures/voice`.
   */
  folders?: string[];
  /** Default BCP-47 short language code ("de" | "en" | …). */
  defaultLang?: string;
}

const DEFAULT_VOICE_FOLDER = "30_captures/voice";

type Phase =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "stopped" }
  | { kind: "inserting" }
  | { kind: "error"; message: string };

/**
 * VoiceReviewSheet — Record → editable transcript → insert/discard.
 *
 * Replaces the old "live voice writes directly into the CM6 editor" flow that
 * produced the Android black-screen crash. Here the transcript accumulates in
 * LOCAL state (a textarea the user can edit), and only lands in a note when
 * the user explicitly taps "In Notiz einfügen" — no live editor mutation, no
 * `setActive({...null})` race.
 *
 * ── STT dedup (the Android triple-render fix) ──────────────────────────
 * Android Chrome re-emits `resultIndex = 0` on a fresh recognition turn and
 * re-delivers results that were ALREADY final, which the naive
 * "append everything from resultIndex onward" loop counts two or three times.
 *
 * We track committed final segments OURSELVES, keyed by result index, in
 * `finalSegmentsRef` (a Map<number, string>). On every `onresult`:
 *   - for each FINAL result we OVERWRITE the map entry at its index (so a
 *     re-emitted index 0 replaces, never appends);
 *   - committed text is the map's values joined in ascending index order;
 *   - interim (non-final) text is collected separately and shown greyed,
 *     never committed.
 * Because we key by index and overwrite, the same finalized sentence can be
 * re-emitted any number of times and still appears exactly once. When the
 * recognizer auto-restarts (Chrome ends turns after a silence window), we
 * "rebase" — snapshot the current committed text into a stable prefix and
 * clear the per-turn map so the next turn's index 0 starts a fresh segment
 * rather than clobbering the prior turn's text.
 */
export function VoiceReviewSheet({
  open,
  onClose,
  onInsert,
  targetTitle,
  folders,
  defaultLang = "de",
}: VoiceReviewSheetProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [transcript, setTranscript] = useState<string>("");
  const [interim, setInterim] = useState<string>("");
  const [lang, setLang] = useState<string>(
    LIVE_LANGS.some((l) => l.value === defaultLang) ? defaultLang : "de",
  );
  const [hasWebSpeech, setHasWebSpeech] = useState<boolean>(false);
  // New-note metadata (only relevant when no note is open). Folder defaults to
  // the historical voice-capture folder; title is optional.
  const [folderPath, setFolderPath] = useState<string>(DEFAULT_VOICE_FOLDER);
  const [titleInput, setTitleInput] = useState<string>("");

  // When a note is open, inserting appends to it — the folder/title picker is
  // irrelevant and hidden. Otherwise we're creating a new note.
  const isNewNote = !targetTitle;

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // The transcript textarea — used for the near-bottom auto-scroll guard.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // True while the view is at/near the bottom; gates auto-scroll so we don't
  // yank the user back down if they scrolled up to edit mid-recording.
  const atBottomRef = useRef<boolean>(true);
  const userStoppedRef = useRef<boolean>(false);
  // Per-turn final segments, keyed by SpeechRecognition result index. Keying
  // by index + overwriting is what kills the Android resultIndex=0 re-emit
  // triple-render: re-delivering index N replaces, never appends.
  const finalSegmentsRef = useRef<Map<number, string>>(new Map());
  // Committed text from PRIOR recognition turns (auto-restart rebases here).
  const committedPrefixRef = useRef<string>("");
  // Mirror the live transcript so we don't re-bind onresult per keystroke and
  // so the user's manual textarea edits are preserved across recognizer turns.
  const transcriptRef = useRef<string>("");
  transcriptRef.current = transcript;

  /* ── Web-Speech availability check (mount-only) ──────────────────── */
  useEffect(() => {
    setHasWebSpeech(getSpeechRecognitionCtor() !== null);
  }, []);

  /**
   * Join committed prefix + current-turn final map (index order).
   *
   * Two levels of {@link mergeTranscript} folding:
   *
   * 1. WITHIN the turn: Android Chrome can deliver the growing phrase as
   *    CUMULATIVE final results at increasing indices inside ONE turn
   *    (`{0:"okay", 1:"okay ich", 2:"okay ich bin", …}`). A plain `.join(" ")`
   *    of those reproduces the stutter ("okay okay ich okay ich bin …") before
   *    the prefix-merge ever runs. So we `reduce` the sorted per-turn segments
   *    through `mergeTranscript`, collapsing each superset/overlap into the
   *    longest coherent form. Distinct non-overlapping finals (the normal
   *    desktop case) hit k=0 and just append with a single space — unchanged.
   *
   * 2. BETWEEN turns: the resulting turn-text folds into the committed prefix
   *    via the same merge, so the Android re-delivery (where a restarted turn
   *    restates the growing phrase from the start) collapses on the word-level
   *    overlap instead of cumulatively re-appending.
   */
  function buildCommitted(): string {
    const turn = [...finalSegmentsRef.current.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => t.trim())
      .filter(Boolean)
      .reduce((acc, seg) => mergeTranscript(acc, seg), "");
    const prefix = committedPrefixRef.current.trim();
    return mergeTranscript(prefix, turn);
  }

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
  };

  /* ── Lifecycle: abort recognition when the sheet closes / unmounts ── */
  useEffect(() => {
    if (!open) {
      teardownRecognition();
    }
    return () => {
      teardownRecognition();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset the recorder state each time the sheet is freshly opened so a stale
  // transcript from a previous session doesn't linger.
  useEffect(() => {
    if (open) {
      setPhase({ kind: "idle" });
      setTranscript("");
      setInterim("");
      setTitleInput("");
      setFolderPath(DEFAULT_VOICE_FOLDER);
      finalSegmentsRef.current = new Map();
      committedPrefixRef.current = "";
      transcriptRef.current = "";
      atBottomRef.current = true;
    }
  }, [open]);

  // Distance (px) from the bottom still counted as "at the bottom". A small
  // slack absorbs sub-pixel rounding and the line-height of the freshly
  // appended word so streaming text keeps following without a hard equality.
  const NEAR_BOTTOM_PX = 24;

  function recomputeAtBottom(el: HTMLTextAreaElement) {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distance <= NEAR_BOTTOM_PX;
  }

  // Auto-scroll the transcript to the bottom as text streams in WHILE
  // recording — but ONLY when the view is already at/near the bottom. If the
  // user scrolled up to edit, `atBottomRef` is false and we leave them be.
  // After Stop (`phase` !== listening) we never force-scroll, honouring AC #2.
  const listening = phase.kind === "listening";
  useEffect(() => {
    if (!listening) return;
    const el = textareaRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcript, interim, listening]);

  function startListening() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setPhase({
        kind: "error",
        message:
          "Live-Spracherkennung nicht unterstützt — dein Browser hat keine " +
          "SpeechRecognition. Chrome/Edge oder iOS Safari 14.5+ probieren.",
      });
      return;
    }
    teardownRecognition();
    userStoppedRef.current = false;
    finalSegmentsRef.current = new Map();
    // Fresh recording → follow the stream from the bottom until the user
    // deliberately scrolls up (the onScroll handler then flips this off).
    atBottomRef.current = true;
    // Rebase onto whatever is already in the textarea (user may have edited or
    // recorded a prior burst) so a new recording continues from there.
    committedPrefixRef.current = transcriptRef.current.trim();
    setInterim("");

    const bcp47 = LIVE_LANGS.find((l) => l.value === lang)?.bcp47 ?? "de-DE";
    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Ctor();
    } catch (err) {
      setPhase({
        kind: "error",
        message: `SpeechRecognition konnte nicht gestartet werden: ${
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
      let interimText = "";
      // Walk the WHOLE results list, not just from resultIndex. Android resets
      // resultIndex to 0 on a re-emit, so trusting it alone double-counts.
      // Keying finals by absolute index + overwriting de-dupes regardless.
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res) continue;
        const alt = res[0];
        if (!alt) continue;
        if (res.isFinal) {
          // Overwrite (NOT append) — re-emitted index N replaces its entry.
          finalSegmentsRef.current.set(i, alt.transcript);
        } else {
          interimText += alt.transcript;
        }
      }
      setTranscript(buildCommitted());
      setInterim(interimText.trim());
    };

    recognition.onerror = (ev: SpeechRecognitionErrorEventLike) => {
      // `aborted` after our own stop() is routine — swallow it.
      if (ev.error === "aborted" && userStoppedRef.current) return;
      // `no-speech` while still listening: let onend auto-restart instead of
      // killing the session, so a pause doesn't end the recording.
      if (ev.error === "no-speech" && !userStoppedRef.current) return;

      const msgMap: Record<string, string> = {
        "no-speech": "Keine Sprache erkannt. Lauter / näher am Mikro sprechen.",
        "audio-capture": "Kein Mikrofon verfügbar. Eingabegerät prüfen.",
        "not-allowed":
          "Mikrofon-Zugriff verweigert. In den Browser-Einstellungen erlauben.",
        network:
          "Netzwerk-Fehler bei der Spracherkennung. Live-Modus braucht oft eine Internet-Verbindung.",
        "service-not-allowed":
          "Spracherkennungs-Dienst nicht erlaubt — Browser blockiert ihn.",
        "language-not-supported": `Sprache "${bcp47}" wird hier nicht unterstützt.`,
      };
      const message =
        msgMap[ev.error] ??
        `Spracherkennungs-Fehler: ${ev.error}${
          ev.message ? ` (${ev.message})` : ""
        }`;
      teardownRecognition();
      setPhase({ kind: "error", message });
    };

    recognition.onend = () => {
      // Chrome ends turns after a silence window even with continuous:true.
      // Auto-restart unless the user pressed Stop. Before restarting we REBASE:
      // fold the current turn's finals into the stable prefix and clear the
      // per-turn map so the next turn's index 0 starts fresh (no clobber).
      //
      // `buildCommitted()` runs the prefix↔turn join through mergeTranscript,
      // so when Android re-delivers the growing phrase FROM THE START on the
      // next restart, the overlap (the entire prior phrase) is dropped and only
      // genuinely-new words survive — killing the cumulative stutter
      // ("okay okay okay ich okay ich bin …").
      if (userStoppedRef.current) return;
      committedPrefixRef.current = buildCommitted();
      finalSegmentsRef.current = new Map();
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
            // give up silently — user can hit Stop and start again
          }
        }, 250);
      }
    };

    try {
      recognition.start();
    } catch (err) {
      setPhase({
        kind: "error",
        message: `Aufnahme konnte nicht gestartet werden: ${
          (err as Error).message ?? err
        }`,
      });
      return;
    }
    recognitionRef.current = recognition;
    setPhase({ kind: "listening" });
  }

  function stopListening() {
    if (phase.kind !== "listening") return;
    userStoppedRef.current = true;
    // Fold any trailing interim into the committed transcript so "what you see
    // is what gets inserted" — the recognizer may not have finalized the last
    // word inside its ~1s confidence window when the user taps Stop. Use
    // mergeTranscript so an interim tail that restates already-committed words
    // (common on the seam) overlaps-away instead of duplicating.
    const tail = interim.trim();
    const committed = mergeTranscript(buildCommitted(), tail);
    try {
      recognitionRef.current?.stop();
    } catch {
      // onend fires anyway
    }
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
    }
    // Persist into prefix so a subsequent record continues cleanly.
    committedPrefixRef.current = committed;
    finalSegmentsRef.current = new Map();
    setTranscript(committed);
    setInterim("");
    setPhase({ kind: "stopped" });
  }

  function discard() {
    teardownRecognition();
    setTranscript("");
    setInterim("");
    finalSegmentsRef.current = new Map();
    committedPrefixRef.current = "";
    transcriptRef.current = "";
    setPhase({ kind: "idle" });
    onClose();
  }

  async function insert() {
    const text = transcript.trim();
    if (!text) {
      setPhase({
        kind: "error",
        message: "Transkript ist leer — nichts einzufügen.",
      });
      return;
    }
    // Stop any still-running recognition first so we don't insert mid-stream.
    if (phase.kind === "listening") {
      userStoppedRef.current = true;
      try {
        recognitionRef.current?.stop();
      } catch {
        /* ignore */
      }
    }
    setPhase({ kind: "inserting" });
    try {
      // Folder/title only matter for the new-note case; when a note is open
      // App.tsx ignores opts and appends to it. Pass undefined there to keep
      // the open-note path identical to before.
      const opts = isNewNote
        ? {
            folderPath: folderPath || DEFAULT_VOICE_FOLDER,
            title: titleInput.trim() || undefined,
          }
        : undefined;
      await onInsert(text, opts);
      // Success — reset and close.
      setTranscript("");
      setInterim("");
      finalSegmentsRef.current = new Map();
      committedPrefixRef.current = "";
      transcriptRef.current = "";
      setPhase({ kind: "idle" });
      onClose();
    } catch (err) {
      setPhase({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Einfügen fehlgeschlagen — bitte erneut versuchen.",
      });
    }
  }

  if (!open) return null;

  const inserting = phase.kind === "inserting";
  const canInsert = transcript.trim().length > 0 && !inserting;

  // Folder options for the new-note picker. Always include the default voice
  // folder (the vault may not have surfaced it yet), de-dupe, and sort so the
  // list is stable regardless of tree order.
  const folderOptions = Array.from(
    new Set([DEFAULT_VOICE_FOLDER, ...(folders ?? [])]),
  ).sort((a, b) => a.localeCompare(b));

  return (
    <>
      <BadgeAnimationStyles />
      {/* Backdrop */}
      <div
        onClick={() => {
          if (!inserting) discard();
        }}
        aria-hidden="true"
        style={BACKDROP_STYLE}
      />
      {/* Bottom sheet */}
      <section
        role="dialog"
        aria-label="Sprachaufnahme — Überprüfen und einfügen"
        style={SHEET_STYLE}
      >
        <header style={HEADER_STYLE}>
          <Mic size={18} style={{ color: C.accent }} />
          <strong style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>
            Spracheingabe
          </strong>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            disabled={listening}
            aria-label="Sprache"
            style={SELECT_STYLE}
          >
            {LIVE_LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </header>

        {!hasWebSpeech && (
          <div style={WARN_STYLE}>
            <AlertTriangle size={14} style={{ color: C.gold, flexShrink: 0 }} />
            <span>
              Dein Browser unterstützt keine Live-Spracherkennung. Du kannst den
              Text unten von Hand eintippen oder die Whisper-Aufnahme im Import
              nutzen.
            </span>
          </div>
        )}

        {/* Record / Stop control */}
        <div style={{ display: "flex", justifyContent: "center", padding: "4px 0 8px" }}>
          {listening ? (
            <button
              type="button"
              onClick={stopListening}
              aria-label="Aufnahme stoppen"
              style={{ ...RECORD_BUTTON_STYLE, background: C.err, color: "#fff" }}
            >
              <Square size={20} />
              Stopp
            </button>
          ) : (
            <button
              type="button"
              onClick={startListening}
              disabled={!hasWebSpeech || inserting}
              aria-label="Aufnahme starten"
              style={{
                ...RECORD_BUTTON_STYLE,
                opacity: !hasWebSpeech || inserting ? 0.5 : 1,
                cursor: !hasWebSpeech || inserting ? "default" : "pointer",
              }}
            >
              <Mic size={20} />
              {transcript ? "Weiter aufnehmen" : "Aufnehmen"}
            </button>
          )}
        </div>

        {listening && (
          <div style={LISTENING_HINT_STYLE} aria-live="polite">
            <span style={REC_DOT_STYLE} /> Hört zu… sprich frei. Korrektur
            geht jederzeit unten im Textfeld.
          </div>
        )}

        {/* LIVE EDITABLE transcript — grows to fill the fullscreen sheet. */}
        <div style={TRANSCRIPT_WRAP_STYLE}>
          <label style={FIELD_LABEL_STYLE} htmlFor="voice-review-transcript">
            Transkript {listening ? "(live — editierbar)" : "(editierbar)"}
          </label>
          <textarea
            id="voice-review-transcript"
            ref={textareaRef}
            value={
              // While listening, show committed + a greyed interim tail INLINE
              // by appending it; we keep interim out of `transcript` state so an
              // edit during recording doesn't fight the recognizer. The user can
              // still place the caret and edit committed text directly.
              interim && listening
                ? `${transcript}${transcript ? " " : ""}${interim}`
                : transcript
            }
            onChange={(e) => {
              // Manual edits land in committed state. If listening, rebase the
              // recognizer prefix so subsequent finals append after the edit.
              const v = e.target.value;
              setTranscript(v);
              if (listening) {
                committedPrefixRef.current = v;
                finalSegmentsRef.current = new Map();
                setInterim("");
              }
            }}
            // Track whether the user is at/near the bottom so the streaming
            // auto-scroll only kicks in when it won't fight a manual scroll-up.
            onScroll={(e) => recomputeAtBottom(e.currentTarget)}
            placeholder="Hier erscheint dein gesprochener Text — du kannst ihn vor dem Einfügen frei bearbeiten."
            style={TEXTAREA_STYLE}
          />
        </div>

        {/* New-note metadata — only when no note is open. */}
        {isNewNote && (
          <div style={NEWNOTE_FIELDS_STYLE}>
            <div style={NEWNOTE_FIELD_STYLE}>
              <label style={FIELD_LABEL_STYLE} htmlFor="voice-review-folder">
                Ordner
              </label>
              <select
                id="voice-review-folder"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                disabled={inserting}
                aria-label="Zielordner"
                style={NEWNOTE_INPUT_STYLE}
              >
                {folderOptions.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div style={NEWNOTE_FIELD_STYLE}>
              <label style={FIELD_LABEL_STYLE} htmlFor="voice-review-title">
                Titel (optional)
              </label>
              <input
                id="voice-review-title"
                type="text"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                disabled={inserting}
                placeholder="Leer = Zeitstempel-Name"
                style={NEWNOTE_INPUT_STYLE}
              />
            </div>
          </div>
        )}

        {targetTitle ? (
          <p style={TARGET_HINT_STYLE}>
            Einfügen in:{" "}
            <code style={{ fontFamily: FONT.mono, color: C.gold }}>
              {targetTitle}
            </code>
          </p>
        ) : (
          <p style={TARGET_HINT_STYLE}>
            Keine Notiz offen — Text wird als neue Notiz im gewählten Ordner
            gespeichert.
          </p>
        )}

        {phase.kind === "error" && (
          <div style={ERROR_STYLE} aria-live="assertive">
            <AlertTriangle size={14} style={{ color: C.err, flexShrink: 0 }} />
            <span>{phase.message}</span>
          </div>
        )}

        {/* Actions */}
        <div style={ACTIONS_STYLE}>
          <button
            type="button"
            onClick={discard}
            disabled={inserting}
            style={{
              ...DISCARD_BUTTON_STYLE,
              opacity: inserting ? 0.5 : 1,
              cursor: inserting ? "default" : "pointer",
            }}
          >
            <Trash2 size={16} />
            Verwerfen
          </button>
          <button
            type="button"
            onClick={() => void insert()}
            disabled={!canInsert}
            style={{
              ...INSERT_BUTTON_STYLE,
              opacity: canInsert ? 1 : 0.5,
              cursor: canInsert ? "pointer" : "default",
            }}
          >
            {inserting ? (
              <Loader2
                size={16}
                style={{ animation: "lokyy-spin 0.9s linear infinite" }}
              />
            ) : (
              <Check size={16} />
            )}
            {inserting ? "Füge ein…" : "In Notiz einfügen"}
          </button>
        </div>
      </section>
    </>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────── */

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  zIndex: 70,
};

const SHEET_STYLE: CSSProperties = {
  // Fullscreen, not a bottom sheet: cover the whole viewport. `100dvh` tracks
  // the DYNAMIC viewport so mobile browser chrome (URL bar) doesn't clip the
  // pinned actions. Safe-area insets keep the header below the notch and the
  // actions above the gesture bar. The textarea region flex-grows to fill.
  position: "fixed",
  inset: 0,
  zIndex: 71,
  height: "100dvh",
  background: C.panel,
  boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "12px 14px",
  paddingTop: "calc(12px + env(safe-area-inset-top, 0px))",
  paddingBottom: "calc(14px + env(safe-area-inset-bottom, 0px))",
  paddingLeft: "calc(14px + env(safe-area-inset-left, 0px))",
  paddingRight: "calc(14px + env(safe-area-inset-right, 0px))",
  // No outer scroll — the transcript area scrolls internally so the header
  // stays at the top and the actions stay pinned at the bottom.
  overflow: "hidden",
  boxSizing: "border-box",
  fontFamily: FONT.ui,
  color: C.text,
};

/**
 * The transcript label + textarea share a flex column that GROWS to fill all
 * space between the record controls and the pinned footer. `minHeight: 0` lets
 * the textarea actually shrink/scroll inside the flex parent instead of
 * forcing the sheet taller than the viewport.
 */
const TRANSCRIPT_WRAP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  flex: 1,
  minHeight: 0,
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const SELECT_STYLE: CSSProperties = {
  background: C.bg,
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: 7,
  padding: "6px 8px",
  fontSize: 12,
  fontFamily: FONT.ui,
  minHeight: 36,
};

const RECORD_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  minHeight: TOUCH_TARGET_MIN + 4,
  padding: "10px 22px",
  borderRadius: 999,
  border: "none",
  background: C.accent,
  color: "#1a1110",
  fontSize: 14,
  fontWeight: 700,
  fontFamily: FONT.ui,
  cursor: "pointer",
};

const LISTENING_HINT_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 11.5,
  color: C.textDim,
  lineHeight: 1.4,
};

const REC_DOT_STYLE: CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: "50%",
  background: C.err,
  display: "inline-block",
  flexShrink: 0,
  animation: "lokyy-pulse 1.4s ease-in-out infinite",
};

const FIELD_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  color: C.textDim,
  fontWeight: 600,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
};

const TEXTAREA_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: C.bg,
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 15,
  lineHeight: 1.5,
  fontFamily: FONT.ui,
  // Fill the growing wrapper; `flex:1 + minHeight:0` makes it scroll internally
  // rather than push the pinned footer off-screen. No manual resize handle —
  // the sheet is fullscreen so the field is already as large as it can be.
  flex: 1,
  minHeight: 0,
  resize: "none",
};

const NEWNOTE_FIELDS_STYLE: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const NEWNOTE_FIELD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  flex: 1,
  minWidth: 140,
};

const NEWNOTE_INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: C.bg,
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  fontFamily: FONT.ui,
  minHeight: 38,
};

const TARGET_HINT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 11.5,
  color: C.textFaint,
  lineHeight: 1.4,
};

const WARN_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  fontSize: 11.5,
  color: C.textDim,
  background: C.elevated,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: "8px 10px",
  lineHeight: 1.4,
};

const ERROR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  fontSize: 12,
  color: C.err,
  lineHeight: 1.4,
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  gap: 10,
  marginTop: 4,
};

const DISCARD_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  flex: 1,
  minHeight: TOUCH_TARGET_MIN,
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  color: C.textDim,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: FONT.ui,
};

const INSERT_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  flex: 2,
  minHeight: TOUCH_TARGET_MIN,
  background: C.accent,
  border: "none",
  borderRadius: 10,
  color: "#1a1110",
  fontSize: 14,
  fontWeight: 700,
  fontFamily: FONT.ui,
};

/**
 * Re-declare the spin/pulse keyframes locally (the project has no CSS-in-JS
 * keyframe support; NoteHeader does the same with a deduped <style> tag).
 */
function BadgeAnimationStyles() {
  return (
    <style data-lokyy-badge-anim>{`
      @keyframes lokyy-spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
      @keyframes lokyy-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.35; }
      }
    `}</style>
  );
}

export default VoiceReviewSheet;
