import { useEffect, useRef, useState } from "react";
import { Mic, X as XIcon, Check, ArrowUpRight } from "lucide-react";
import { C, FONT } from "./theme.js";
import { VoiceRecorder } from "./VoiceRecorder.js";
import { useIsMobile, TOUCH_TARGET_MIN } from "./responsive.js";

/**
 * VoiceQuickButton — top-bar mic toggle for the Sprachaufnahme slide-over.
 *
 * History: this used to ship its own inline state machine + tiny toast. The
 * toast was great for the "speak, stop, save" one-click happy path but
 * exposed none of the recorder's actual settings — no mode-switch, no title,
 * no language, no Verwerfen, no live-vs-capture target. Users kept opening
 * the long Import → Sprachaufnahme tab just to get those controls back.
 *
 * The redesign collapses this to a dumb toggle: tap the mic, the full
 * `<VoiceRecorder>` slides in from the right (same visual pattern as
 * `ImportPanel`), and every feature is one tap away. ESC and the backdrop
 * close it; recording state lives entirely inside the recorder.
 *
 * The only thing this component still owns is the "✓ Notiz erstellt" toast
 * shown at the bottom after a save, so the user can jump to the new note
 * even after the panel auto-collapsed.
 */

interface VoiceQuickButtonProps {
  /** Open the freshly created/transcribed note in the editor. */
  onImported: (noteId: string) => void;
  /**
   * Live-mode "Live in neuen Editor schreiben" plumbing — wired through to
   * the recorder. When all three are provided the recorder shows the
   * extra target radio; otherwise it falls back to capture-only.
   */
  onLiveEditorRequested?: (noteId: string, notePath: string) => void;
  onLiveEditorAppend?: (segment: string) => void;
  onLiveEditorStopped?: () => void;
  /** Parent reports the user switched tabs mid-live-recording. */
  liveEditorOffTarget?: boolean;
  /** Touch-target sizing on mobile — matches the rest of the top-bar. */
  isMobile?: boolean;
}

/** ms the bottom toast stays visible before fading. */
const TOAST_AUTO_DISMISS_MS = 6000;
/** ms after a successful save before the panel auto-closes. */
const PANEL_AUTO_CLOSE_MS = 3000;

interface ImportedToast {
  noteId: string;
  notePath: string;
}

export function VoiceQuickButton({
  onImported,
  onLiveEditorRequested,
  onLiveEditorAppend,
  onLiveEditorStopped,
  liveEditorOffTarget = false,
  isMobile: isMobileProp,
}: VoiceQuickButtonProps) {
  const isMobileHook = useIsMobile();
  const isMobile = isMobileProp ?? isMobileHook;
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<ImportedToast | null>(null);

  const toastTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  /* ── ESC closes the slide-over (same UX contract as ImportPanel) ── */
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null)
        window.clearTimeout(toastTimerRef.current);
      if (closeTimerRef.current !== null)
        window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  /**
   * VoiceRecorder fires `onTranscribed` once a note has been saved. We open
   * it in the editor, schedule the slide-over to auto-collapse after 3s
   * (so the user can see the success state inside the recorder first), and
   * pop a bottom toast that survives the panel close.
   */
  function handleTranscribed(noteId: string, notePath?: string) {
    onImported(noteId);
    setToast({ noteId, notePath: notePath ?? `${noteId}.md` });

    if (toastTimerRef.current !== null)
      window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, TOAST_AUTO_DISMISS_MS);

    if (closeTimerRef.current !== null)
      window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, PANEL_AUTO_CLOSE_MS);
  }

  /* ── Render ───────────────────────────────────────────────────── */

  const buttonSize = isMobile ? TOUCH_TARGET_MIN : 36;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? "Sprachaufnahme schließen" : "Sprachaufnahme öffnen"}
        aria-label={
          open ? "Sprachaufnahme schließen" : "Sprachaufnahme öffnen"
        }
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          background: open ? C.elevated : C.elevated,
          border: `1px solid ${open ? C.accent : C.border}`,
          borderRadius: 7,
          padding: 0,
          width: buttonSize,
          height: buttonSize,
          minHeight: 36,
          cursor: "pointer",
          color: C.text,
          flexShrink: 0,
        }}
      >
        <Mic
          size={isMobile ? 22 : 20}
          style={{ color: open ? C.accent : C.accent }}
        />
      </button>

      {/* Backdrop (visible only when panel open). */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.18s",
          zIndex: 50,
        }}
      />

      {/* Slide-over — mirrors ImportPanel's visual pattern (fixed right,
        * full-height column, translateX transition). Width 440px on
        * desktop matches the spec; full-viewport on mobile. */}
      <aside
        role="dialog"
        aria-label="Sprachaufnahme"
        aria-hidden={!open}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: isMobile ? "100vw" : 440,
          maxWidth: "100vw",
          background: C.panel,
          borderLeft: isMobile ? "none" : `1px solid ${C.border}`,
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.22s ease",
          zIndex: 51,
          display: "flex",
          flexDirection: "column",
          fontFamily: FONT.ui,
          color: C.text,
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 14px",
            height: 48,
            borderBottom: `1px solid ${C.border}`,
            flexShrink: 0,
          }}
        >
          <Mic size={16} style={{ color: C.accent }} />
          <strong style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
            Sprachaufnahme
          </strong>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Schließen"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              color: C.textDim,
              cursor: "pointer",
              width: isMobile ? TOUCH_TARGET_MIN : 28,
              height: isMobile ? TOUCH_TARGET_MIN : 28,
              padding: 0,
            }}
          >
            <XIcon size={isMobile ? 22 : 16} />
          </button>
        </header>

        {/* The full recorder. `active={open}` tells the recorder to abort
          * any in-flight session when the user closes the panel — matches
          * how ImportPanel currently uses it. */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
          }}
        >
          <VoiceRecorder
            onTranscribed={(noteId) => handleTranscribed(noteId)}
            active={open}
            onLiveEditorRequested={(noteId, notePath) => {
              onLiveEditorRequested?.(noteId, notePath);
            }}
            onLiveEditorAppend={onLiveEditorAppend}
            onLiveEditorStopped={onLiveEditorStopped}
            liveEditorOffTarget={liveEditorOffTarget}
          />
        </div>
      </aside>

      {/* Bottom toast — survives the panel close so the user can still
        * jump to the new note. Auto-dismisses after TOAST_AUTO_DISMISS_MS. */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: 24,
            zIndex: 60,
            minWidth: 280,
            maxWidth: "min(520px, calc(100vw - 32px))",
            padding: "10px 12px",
            background: C.panel,
            border: `1px solid ${C.ok}`,
            borderRadius: 10,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: FONT.ui,
            fontSize: 12.5,
            color: C.text,
          }}
        >
          <Check size={16} style={{ color: C.ok, flexShrink: 0 }} />
          <span style={{ flex: 1, wordBreak: "break-all" }}>
            Notiz erstellt:{" "}
            <code
              style={{
                fontFamily: FONT.mono,
                color: C.gold,
                fontSize: 11.5,
              }}
            >
              {toast.notePath}
            </code>
          </span>
          {toast.noteId && (
            <button
              type="button"
              onClick={() => {
                onImported(toast.noteId);
                setToast(null);
                if (toastTimerRef.current !== null) {
                  window.clearTimeout(toastTimerRef.current);
                  toastTimerRef.current = null;
                }
              }}
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
            onClick={() => {
              setToast(null);
              if (toastTimerRef.current !== null) {
                window.clearTimeout(toastTimerRef.current);
                toastTimerRef.current = null;
              }
            }}
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
      )}
    </>
  );
}

export default VoiceQuickButton;
