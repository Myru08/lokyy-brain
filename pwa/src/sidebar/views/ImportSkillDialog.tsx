import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { X as XIcon, Loader2, Check, FolderUp, FileText } from "lucide-react";
import { api, ApiError } from "../../api.js";
import { C, FONT } from "../../theme.js";
import { slugifySkillName, validateSkillInput } from "./skillTemplate.js";
import {
  collectSkillUpload,
  type SelectedSkillFile,
} from "./importSkillFiles.js";

/**
 * ImportSkillDialog — „Skill importieren" der Skill-Bibliothek (Story 12.3).
 *
 * Modaler Dialog, der einen ORDNER-Skill (Anthropic-Format: `SKILL.md` +
 * `references/` + `templates/`) per Ordner-Upload entgegennimmt und an
 * `POST /api/skills/import` (→ core `importSkill`) postet.
 *
 * Datenfluss (kein @lokyy/core / MCP im Bundle — nur die HTTP-API):
 *   1. `<input webkitdirectory>` liefert eine FileList mit `webkitRelativePath`.
 *   2. `collectSkillUpload` (rein, testbar) leitet Skill-Name (oberstes
 *      Ordner-Segment, slugifiziert, editierbar) + die Dateien mit Pfaden
 *      RELATIV zur Skill-Wurzel ab und prüft auf `SKILL.md`.
 *   3. `api.importSkill(skillName, files)` postet multipart; der Server schreibt
 *      via gitService nach `70_pai/skills/<name>/` und committet nach Forgejo.
 *
 * Fehler/Quittung: nie die rohe Antwort zeigen (YouTube-JSON-Lehre). Erfolg →
 * `onImported(skillName)`; der Aufrufer (SkillsView) refresht die Liste, sodass
 * der Ordner-Skill mit Struktur (12.2) erscheint.
 */

export interface ImportSkillDialogProps {
  /** Schließt den Dialog ohne Import. */
  onClose: () => void;
  /**
   * Nach erfolgreichem Import aufgerufen mit dem Skill-Namen und der Liste der
   * geschriebenen relativen Pfade. Der Dialog schließt sich NICHT selbst.
   */
  onImported: (result: {
    skillName: string;
    written: string[];
    skipped: string[];
  }) => void;
  /** Bereits vergebene Skill-Namen (kebab) — für die Duplikat-Warnung. */
  existingSkillNames: string[];
}

export function ImportSkillDialog({
  onClose,
  onImported,
  existingSkillNames,
}: ImportSkillDialogProps) {
  const [skillName, setSkillName] = useState("");
  const [files, setFiles] = useState<SelectedSkillFile[]>([]);
  const [hasSkillMd, setHasSkillMd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** true, sobald der Nutzer den Namen manuell angefasst hat. */
  const nameTouched = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Esc schließt den Dialog (wenn nicht gerade gesendet wird).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  const existingLower = useMemo(
    () => new Set(existingSkillNames.map((n) => n.trim().toLowerCase())),
    [existingSkillNames],
  );

  function handlePick(picked: FileList | null) {
    setSubmitError(null);
    if (!picked || picked.length === 0) {
      setFiles([]);
      setHasSkillMd(false);
      return;
    }
    const collected = collectSkillUpload(picked);
    setFiles(collected.files);
    setHasSkillMd(collected.hasSkillMd);
    // Name folgt dem Ordnernamen, bis der Nutzer ihn selbst gesetzt hat.
    if (!nameTouched.current && collected.suggestedName) {
      setSkillName(collected.suggestedName);
    }
  }

  const nameTrim = skillName.trim();
  const nameSchemaError = validateSkillInput({
    title: "x", // Titel hier irrelevant — wir prüfen nur skillName.
    skillName,
    description: "x",
    body: "",
  }).skillName;
  const duplicate =
    nameTrim !== "" && existingLower.has(nameTrim.toLowerCase());
  const nameError =
    nameSchemaError ??
    (duplicate ? `„${nameTrim}" existiert bereits.` : undefined);

  const noFiles = files.length === 0;
  const missingSkillMd = !noFiles && !hasSkillMd;

  const canSubmit =
    !submitting && !noFiles && !missingSkillMd && nameTrim !== "" && !nameError;

  async function handleImport() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.importSkill(nameTrim, files);
      onImported(result);
    } catch (err) {
      let msg = "Skill konnte nicht importiert werden.";
      if (err instanceof ApiError) {
        msg = err.isConflict
          ? `Konflikt: „${nameTrim}" existiert bereits oder kollidiert.`
          : err.message || msg;
      } else if (err instanceof Error) {
        msg = err.message || msg;
      }
      setSubmitError(msg);
      setSubmitting(false);
    }
  }

  return (
    <>
      <div
        onClick={submitting ? undefined : onClose}
        aria-hidden="true"
        style={BACKDROP_STYLE}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Skill importieren"
        style={DIALOG_STYLE}
      >
        <header style={HEADER_STYLE}>
          <strong style={HEADER_TITLE_STYLE}>Skill importieren</strong>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Schließen"
            style={CLOSE_BTN_STYLE}
          >
            <XIcon size={18} />
          </button>
        </header>

        <div style={BODY_STYLE}>
          <p style={HINT_NOTE_STYLE}>
            Wähle den ORDNER eines Skills (Anthropic-Format): eine{" "}
            <code>SKILL.md</code> an der Wurzel, optional <code>references/</code>{" "}
            und <code>templates/</code>. Der Inhalt wird nach{" "}
            <code>70_pai/skills/&lt;name&gt;/</code> geschrieben.
          </p>

          {/* Ordner-Upload. `webkitdirectory` für ganze Ordner; das `multiple`
              erlaubt zusätzlich eine flache Mehrfach-Datei-Auswahl als Fallback. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            // Non-standard Attribute (TS-DOM kennt sie nicht typisiert) — als
            // String-Props gesetzt, wie es Chromium/WebKit erwarten.
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(e) => handlePick(e.currentTarget.files)}
            style={{ display: "none" }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
            style={PICK_BTN_STYLE}
          >
            <FolderUp size={16} />
            {noFiles ? "Skill-Ordner wählen…" : "Anderen Ordner wählen…"}
          </button>

          {!noFiles && (
            <div style={FILE_LIST_WRAP_STYLE}>
              <div style={FILE_LIST_HEAD_STYLE}>
                {files.length} {files.length === 1 ? "Datei" : "Dateien"} ausgewählt
              </div>
              <div style={FILE_LIST_STYLE}>
                {files.map((f) => (
                  <div key={f.relPath} style={FILE_ROW_STYLE}>
                    <FileText
                      size={12}
                      style={{ color: C.textFaint, flexShrink: 0 }}
                    />
                    <span>{f.relPath}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {missingSkillMd && (
            <div role="alert" style={WARN_BANNER_STYLE}>
              Keine <code>SKILL.md</code> an der Wurzel gefunden. Ein
              Ordner-Skill braucht eine <code>SKILL.md</code> (Anthropic-Format).
            </div>
          )}

          <label style={FIELD_STYLE}>
            <span style={FIELD_LABEL_STYLE}>Skill-Name</span>
            <input
              value={skillName}
              onChange={(e) => {
                nameTouched.current = true;
                setSkillName(e.target.value);
              }}
              onBlur={(e) => setSkillName(slugifySkillName(e.target.value))}
              placeholder="z. B. weekly-review"
              spellCheck={false}
              disabled={submitting}
              style={{ ...INPUT_STYLE, fontFamily: FONT.mono }}
            />
            {nameError ? (
              <span style={FIELD_ERROR_STYLE}>{nameError}</span>
            ) : (
              <span style={FIELD_HINT_STYLE}>
                Zielordner: 70_pai/skills/{nameTrim || "<name>"}/
              </span>
            )}
          </label>

          {submitError && (
            <div role="alert" style={ERROR_BANNER_STYLE}>
              {submitError}
            </div>
          )}
        </div>

        <footer style={FOOTER_STYLE}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={SECONDARY_BTN_STYLE}
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={!canSubmit}
            style={{
              ...PRIMARY_BTN_STYLE,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? "pointer" : "default",
            }}
          >
            {submitting ? (
              <Loader2
                size={16}
                style={{ animation: "lokyy-spin 0.9s linear infinite" }}
              />
            ) : (
              <Check size={16} />
            )}
            Importieren
          </button>
        </footer>
      </section>
      <style data-lokyy-importskill-anim>{`
        @keyframes lokyy-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}

/* ── Styles (gespiegelt aus NewSkillDialog für ein konsistentes Look&Feel) ── */

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  zIndex: 80,
};

const DIALOG_STYLE: CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  zIndex: 81,
  width: "min(560px, calc(100vw - 32px))",
  maxHeight: "calc(100vh - 48px)",
  display: "flex",
  flexDirection: "column",
  background: C.panel,
  border: `1px solid ${C.borderStrong}`,
  borderRadius: 12,
  boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
  fontFamily: FONT.ui,
  color: C.text,
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "14px 16px",
  borderBottom: `1px solid ${C.border}`,
  flexShrink: 0,
};

const HEADER_TITLE_STYLE: CSSProperties = {
  flex: 1,
  fontSize: 15,
  fontWeight: 700,
  color: C.text,
};

const CLOSE_BTN_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  background: "transparent",
  border: "none",
  borderRadius: 8,
  color: C.textDim,
  cursor: "pointer",
};

const BODY_STYLE: CSSProperties = {
  overflowY: "auto",
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const HINT_NOTE_STYLE: CSSProperties = {
  margin: 0,
  padding: "9px 11px",
  borderRadius: 8,
  background: C.elevated,
  border: `1px solid ${C.borderSoft}`,
  color: C.textDim,
  fontSize: 12,
  lineHeight: 1.5,
};

const PICK_BTN_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: "11px 14px",
  background: C.accentSoft,
  border: `1px dashed ${C.borderStrong}`,
  borderRadius: 8,
  color: C.accentHi,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: FONT.ui,
};

const FILE_LIST_WRAP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const FILE_LIST_HEAD_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: C.textDim,
};

const FILE_LIST_STYLE: CSSProperties = {
  maxHeight: 180,
  overflowY: "auto",
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  background: C.bg,
  padding: "6px 8px",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const FILE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: C.text,
  fontFamily: FONT.mono,
  fontSize: 11.5,
  lineHeight: 1.5,
};

const FIELD_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const FIELD_LABEL_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: C.textDim,
  letterSpacing: "0.02em",
};

const FIELD_HINT_STYLE: CSSProperties = {
  fontSize: 11,
  color: C.textFaint,
  lineHeight: 1.4,
  fontFamily: FONT.mono,
};

const FIELD_ERROR_STYLE: CSSProperties = {
  fontSize: 11.5,
  color: C.err,
  lineHeight: 1.4,
};

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: C.bg,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: "9px 11px",
  fontSize: 13.5,
  color: C.text,
  fontFamily: FONT.ui,
  outline: "none",
};

const WARN_BANNER_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  background: "rgba(234,179,8,0.10)",
  border: "1px solid rgba(234,179,8,0.4)",
  color: "#FDE68A",
  fontSize: 12.5,
  lineHeight: 1.45,
};

const ERROR_BANNER_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 8,
  background: "rgba(239,68,68,0.10)",
  border: "1px solid rgba(239,68,68,0.4)",
  color: "#FCA5A5",
  fontSize: 12.5,
  lineHeight: 1.45,
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 10,
  padding: "12px 16px",
  borderTop: `1px solid ${C.border}`,
  flexShrink: 0,
};

const SECONDARY_BTN_STYLE: CSSProperties = {
  padding: "9px 14px",
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  color: C.text,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: FONT.ui,
};

const PRIMARY_BTN_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "9px 16px",
  background: C.accent,
  border: `1px solid ${C.accent}`,
  borderRadius: 8,
  color: "#1A0E05",
  fontSize: 13,
  fontWeight: 700,
  fontFamily: FONT.ui,
};

export default ImportSkillDialog;
