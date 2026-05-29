import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Save,
  RefreshCw,
  Volume2,
  VolumeX,
  Sparkles,
  Undo2,
  SlidersHorizontal,
  Link2,
  ListTree,
  Copy,
  Trash2,
  RotateCcw,
  Loader2,
  Check,
  X as XIcon,
} from "lucide-react";
import { C, FONT } from "./theme.js";
import { TOUCH_TARGET_MIN } from "./responsive.js";

/**
 * NoteActionsSheet — mobile "⋮ more" bottom sheet.
 *
 * On phones the NoteHeader's inline action row (Save / Sync / TTS / Polish /
 * Properties / Backlinks / Outline / ID / forget …) is unreachable: the
 * buttons crowd off-screen and sit out of thumb range. This sheet collects
 * every one of those actions into touch-sized rows opened by a single "⋮"
 * button in the slim mobile top bar.
 *
 * It owns NO business logic — each row triggers the SAME handler App.tsx wires
 * into the inline desktop NoteHeader. Props mirror the relevant NoteHeader
 * props one-to-one so there's a single source of truth for behaviour.
 *
 * Desktop never mounts this (App gates on `isMobile`); the inline NoteHeader
 * layout there is untouched.
 */

export interface NoteActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** Active note id + display title for the sheet header + handlers. */
  noteId: string;
  title: string;
  /** Whether the note has unsaved local edits — drives Save row enabled-ness. */
  isDirty?: boolean;
  /** Save/sync lifecycle — "saving" disables Save+Sync to avoid double-submit. */
  saving?: boolean;
  /** True while an explicit api.sync() reconcile is in flight. */
  syncing?: boolean;
  /** Whether TTS is currently reading (toggles the read-aloud row label/icon). */
  isReading?: boolean;
  /** True when the note carries `raw_transcript` — shows the Polish-undo row. */
  hasRawTranscript?: boolean;
  /** True when the note is `forgotten:` — flips Forget ⇄ Unforget row. */
  forgotten?: boolean;

  onManualSave: () => void;
  onSync: () => void;
  onToggleSpeech: () => void;
  ttsSupported?: boolean;
  onPolish: () => void;
  onPolishUndo: () => void;
  onProperties: () => void;
  onBacklinks: () => void;
  onOutline: () => void;
  onCopyId: () => void;
  onCopyPrompt: () => void;
  onForget: () => void;
  onUnforget: () => void;
}

interface RowProps {
  icon: ReactNode;
  label: string;
  sublabel?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  trailing?: ReactNode;
  closeOnClick?: boolean;
  onAfter?: () => void;
}

export function NoteActionsSheet(props: NoteActionsSheetProps) {
  const {
    open,
    onClose,
    title,
    isDirty,
    saving,
    syncing,
    isReading,
    hasRawTranscript,
    forgotten,
    ttsSupported = true,
  } = props;

  if (!open) return null;

  const inFlight = saving === true || syncing === true;
  const saveDisabled = inFlight || isDirty === false;
  const syncDisabled = inFlight;

  return (
    <>
      <Keyframes />
      <div onClick={onClose} aria-hidden="true" style={BACKDROP_STYLE} />
      <section role="dialog" aria-label="Notiz-Aktionen" style={SHEET_STYLE}>
        <header style={HEADER_STYLE}>
          <strong style={TITLE_STYLE} title={title}>
            {title}
          </strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            style={CLOSE_BUTTON_STYLE}
          >
            <XIcon size={20} />
          </button>
        </header>

        <div style={LIST_STYLE}>
          <Row
            icon={
              saving ? (
                <Loader2
                  size={20}
                  style={{ animation: "lokyy-spin 0.9s linear infinite" }}
                />
              ) : (
                <Save size={20} />
              )
            }
            label="Speichern"
            sublabel={
              isDirty === false ? "Nichts zu speichern" : "Lokale Änderungen jetzt sichern"
            }
            disabled={saveDisabled}
            onClick={props.onManualSave}
            closeOnClick
            onAfter={onClose}
          />
          <Row
            icon={
              syncing ? (
                <Loader2
                  size={20}
                  style={{ animation: "lokyy-spin 0.9s linear infinite" }}
                />
              ) : (
                <RefreshCw size={20} />
              )
            }
            label="Sync"
            sublabel="Mit Forgejo abgleichen"
            disabled={syncDisabled}
            onClick={props.onSync}
            closeOnClick
            onAfter={onClose}
          />
          <Row
            icon={isReading ? <VolumeX size={20} /> : <Volume2 size={20} />}
            label={isReading ? "Vorlesen stoppen" : "Vorlesen"}
            sublabel={ttsSupported ? undefined : "Browser unterstützt keine Sprachausgabe"}
            disabled={!ttsSupported}
            onClick={props.onToggleSpeech}
          />
          <Row
            icon={<Sparkles size={20} />}
            label="Polish"
            sublabel="Mit KI aufbereiten"
            onClick={props.onPolish}
            closeOnClick
            onAfter={onClose}
          />
          {hasRawTranscript && (
            <Row
              icon={<Undo2 size={20} />}
              label="Original"
              sublabel="Polish rückgängig — Originaltext"
              onClick={props.onPolishUndo}
              closeOnClick
              onAfter={onClose}
            />
          )}
          <Row
            icon={<SlidersHorizontal size={20} />}
            label="Eigenschaften"
            sublabel="Frontmatter bearbeiten"
            onClick={props.onProperties}
            closeOnClick
            onAfter={onClose}
          />
          <Row
            icon={<Link2 size={20} />}
            label="Backlinks"
            onClick={props.onBacklinks}
            closeOnClick
            onAfter={onClose}
          />
          <Row
            icon={<ListTree size={20} />}
            label="Gliederung"
            sublabel="Outline / Überschriften"
            onClick={props.onOutline}
            closeOnClick
            onAfter={onClose}
          />
          <Row
            icon={<Copy size={20} />}
            label="AI-Prompt kopieren"
            sublabel="ID + Pfad + MCP-Hint"
            onClick={props.onCopyPrompt}
          />
          <Row
            icon={<Copy size={20} />}
            label="ID kopieren"
            sublabel="ULID in die Zwischenablage"
            onClick={props.onCopyId}
          />
          {forgotten ? (
            <Row
              icon={<RotateCcw size={20} />}
              label="Unforget"
              sublabel="Wieder in Suchen anzeigen"
              onClick={props.onUnforget}
              closeOnClick
              onAfter={onClose}
            />
          ) : (
            <Row
              icon={<Trash2 size={20} />}
              label="Forget"
              sublabel="Aus Suchen ausblenden (bleibt im Vault)"
              danger
              onClick={props.onForget}
              closeOnClick
              onAfter={onClose}
            />
          )}
        </div>
      </section>
    </>
  );
}

function Row({
  icon,
  label,
  sublabel,
  onClick,
  disabled,
  danger,
  trailing,
  closeOnClick,
  onAfter,
}: RowProps) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onClick();
        if (closeOnClick) onAfter?.();
      }}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        ...ROW_STYLE,
        background: pressed && !disabled ? C.hover : "transparent",
        color: disabled ? C.textFaint : danger ? "rgba(239,68,68,0.85)" : C.text,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <span style={{ ...ROW_ICON_STYLE, color: disabled ? C.textFaint : danger ? "rgba(239,68,68,0.85)" : C.accent }}>
        {icon}
      </span>
      <span style={ROW_TEXT_WRAP}>
        <span style={ROW_LABEL_STYLE}>{label}</span>
        {sublabel && <span style={ROW_SUBLABEL_STYLE}>{sublabel}</span>}
      </span>
      {trailing && <span style={{ flexShrink: 0 }}>{trailing}</span>}
    </button>
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
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 71,
  background: C.panel,
  borderTop: `1px solid ${C.border}`,
  borderTopLeftRadius: 16,
  borderTopRightRadius: 16,
  boxShadow: "0 -12px 40px rgba(0,0,0,0.55)",
  display: "flex",
  flexDirection: "column",
  paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))",
  maxHeight: "82vh",
  fontFamily: FONT.ui,
  color: C.text,
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 14px",
  borderBottom: `1px solid ${C.border}`,
  flexShrink: 0,
};

const TITLE_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 14,
  fontWeight: 600,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  color: C.text,
};

const CLOSE_BUTTON_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: TOUCH_TARGET_MIN,
  height: TOUCH_TARGET_MIN,
  background: "transparent",
  border: "none",
  color: C.textDim,
  cursor: "pointer",
  flexShrink: 0,
};

const LIST_STYLE: CSSProperties = {
  overflowY: "auto",
  padding: "6px 6px",
  display: "flex",
  flexDirection: "column",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  width: "100%",
  minHeight: TOUCH_TARGET_MIN + 6,
  padding: "10px 12px",
  border: "none",
  borderRadius: 10,
  textAlign: "left",
  fontFamily: FONT.ui,
};

const ROW_ICON_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  flexShrink: 0,
};

const ROW_TEXT_WRAP: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
};

const ROW_LABEL_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.2,
};

const ROW_SUBLABEL_STYLE: CSSProperties = {
  fontSize: 11.5,
  color: C.textDim,
  lineHeight: 1.3,
  marginTop: 1,
};

function Keyframes() {
  return (
    <style data-lokyy-badge-anim>{`
      @keyframes lokyy-spin {
        from { transform: rotate(0deg); }
        to   { transform: rotate(360deg); }
      }
    `}</style>
  );
}

export default NoteActionsSheet;
