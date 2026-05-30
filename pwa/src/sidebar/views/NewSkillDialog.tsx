import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { X as XIcon, Loader2, Check } from "lucide-react";
import { api, ApiError } from "../../api.js";
import { C, FONT } from "../../theme.js";
import {
  buildSkillNoteMarkdown,
  defaultSkillBody,
  skillPath,
  slugifySkillName,
  validateSkillInput,
  type NewSkillInput,
  type SkillInputErrors,
} from "./skillTemplate.js";

/**
 * NewSkillDialog — „+ Neuer Skill" der Skill-Bibliothek.
 *
 * Modaler Dialog, der eine Skill-Vorlage vorbefüllt (Titel, skill_name aus dem
 * Titel abgeleitet + editierbar, Beschreibung, Body-Gerüst, optional
 * allowed_tools) und beim Anlegen eine SPEC-valide `type: skill`-Note nach
 * `70_pai/skills/<skill_name>` schreibt.
 *
 * Schreibweg (Addendum §0 — nur bestehende HTTP-API, kein @lokyy/core /
 * MCP im Bundle): `api.putNote(path, markdown)`. Der Server-`saveNote` parst
 * das Vorlagen-Frontmatter (`type: skill` + Felder) und ergänzt id/created/
 * updated selbst — siehe `skillTemplate.ts`. Bei bereits existierendem Pfad
 * würde `putNote` die Note überschreiben, darum prüfen wir den Namen VOR dem
 * Schreiben gegen die bekannten Skill-Namen (Prop `existingSkillNames`) UND
 * fangen einen Server-Konflikt defensiv ab.
 *
 * Fehlerbehandlung: doppelter/ungültiger Name inline am Feld; Schreib-Fehler
 * als Quittungs-Banner (nie die rohe Antwort) — YouTube-JSON-Lehre.
 */

export interface NewSkillDialogProps {
  /** Schließt den Dialog ohne Anlegen. */
  onClose: () => void;
  /**
   * Nach erfolgreichem Anlegen aufgerufen mit der Note-id des neuen Skills.
   * Der Aufrufer (SkillsView) refresht die Liste; optional kann er die Note
   * öffnen. Der Dialog schließt sich selbst NICHT — der Aufrufer entscheidet.
   */
  onCreated: (noteId: string) => void;
  /**
   * Bereits vergebene `skill_name` (kebab) der sichtbaren Skills — für die
   * Duplikat-Prüfung. Case-insensitiv verglichen.
   */
  existingSkillNames: string[];
}

export function NewSkillDialog({
  onClose,
  onCreated,
  existingSkillNames,
}: NewSkillDialogProps) {
  const [title, setTitle] = useState("");
  const [skillName, setSkillName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(() => defaultSkillBody(""));
  const [toolsRaw, setToolsRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** true, sobald der Nutzer skill_name oder body manuell editiert hat. */
  const nameTouched = useRef(false);
  const bodyTouched = useRef(false);

  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

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

  const input: NewSkillInput = {
    title,
    skillName,
    description,
    body,
    allowedTools: toolsRaw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  };

  const fieldErrors: SkillInputErrors = validateSkillInput(input);
  const duplicate =
    skillName.trim() !== "" && existingLower.has(skillName.trim().toLowerCase());
  const nameError = fieldErrors.skillName ?? (duplicate ? `„${skillName.trim()}" existiert bereits.` : undefined);
  const canSubmit =
    !submitting &&
    !fieldErrors.title &&
    !nameError &&
    !fieldErrors.description;

  function onTitleChange(value: string) {
    setTitle(value);
    // skill_name folgt dem Titel, bis der Nutzer es selbst angefasst hat.
    if (!nameTouched.current) setSkillName(slugifySkillName(value));
    // Body-Gerüst folgt dem Titel, bis der Nutzer den Body editiert.
    if (!bodyTouched.current) setBody(defaultSkillBody(value));
  }

  async function handleCreate() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    const path = skillPath(skillName);
    try {
      const markdown = buildSkillNoteMarkdown(input);
      const note = await api.putNote(path, markdown);
      onCreated(note.id);
    } catch (err) {
      let msg = "Skill konnte nicht angelegt werden.";
      if (err instanceof ApiError) {
        msg = err.isConflict
          ? `Konflikt: „${skillName.trim()}" existiert bereits oder kollidiert.`
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
      <div onClick={submitting ? undefined : onClose} aria-hidden="true" style={BACKDROP_STYLE} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Neuen Skill anlegen"
        style={DIALOG_STYLE}
      >
        <header style={HEADER_STYLE}>
          <strong style={HEADER_TITLE_STYLE}>Neuer Skill</strong>
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
          <Field label="Titel" error={fieldErrors.title}>
            <input
              ref={titleInputRef}
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="z. B. Weekly Review"
              style={INPUT_STYLE}
            />
          </Field>

          <Field
            label="Skill-Name"
            hint="lowercase-kebab — der Handle für run_skill und der Pfad."
            error={nameError}
          >
            <input
              value={skillName}
              onChange={(e) => {
                nameTouched.current = true;
                setSkillName(e.target.value);
              }}
              onBlur={(e) => setSkillName(slugifySkillName(e.target.value))}
              placeholder="weekly-review"
              spellCheck={false}
              style={{ ...INPUT_STYLE, fontFamily: FONT.mono }}
            />
            {skillName.trim() !== "" && !nameError && (
              <div style={PATH_PREVIEW_STYLE}>{skillPath(skillName)}.md</div>
            )}
          </Field>

          <Field label="Beschreibung" error={fieldErrors.description}>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Eine Zeile: was der Skill tut."
              style={INPUT_STYLE}
            />
          </Field>

          <Field
            label="Prompt / Ausführungs-Body"
            hint="Markdown. {{token}} wird beim Aufruf aus dem input_schema ersetzt."
          >
            <textarea
              value={body}
              onChange={(e) => {
                bodyTouched.current = true;
                setBody(e.target.value);
              }}
              rows={9}
              spellCheck={false}
              style={TEXTAREA_STYLE}
            />
          </Field>

          <Field
            label="allowed_tools (optional)"
            hint="Komma-getrennt, advisory — z. B. search_vault, read_note."
          >
            <input
              value={toolsRaw}
              onChange={(e) => setToolsRaw(e.target.value)}
              placeholder="search_vault, read_note"
              spellCheck={false}
              style={{ ...INPUT_STYLE, fontFamily: FONT.mono }}
            />
          </Field>

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
            onClick={() => void handleCreate()}
            disabled={!canSubmit}
            style={{
              ...PRIMARY_BTN_STYLE,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? "pointer" : "default",
            }}
          >
            {submitting ? (
              <Loader2 size={16} style={{ animation: "lokyy-spin 0.9s linear infinite" }} />
            ) : (
              <Check size={16} />
            )}
            Skill anlegen
          </button>
        </footer>
      </section>
      <style data-lokyy-newskill-anim>{`
        @keyframes lokyy-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={FIELD_STYLE}>
      <span style={FIELD_LABEL_STYLE}>{label}</span>
      {children}
      {error ? (
        <span style={FIELD_ERROR_STYLE}>{error}</span>
      ) : (
        hint && <span style={FIELD_HINT_STYLE}>{hint}</span>
      )}
    </label>
  );
}

/* ── Styles ─────────────────────────────────────────────────────────── */

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

const TEXTAREA_STYLE: CSSProperties = {
  ...INPUT_STYLE,
  fontFamily: FONT.mono,
  fontSize: 12.5,
  lineHeight: 1.55,
  resize: "vertical",
};

const PATH_PREVIEW_STYLE: CSSProperties = {
  fontFamily: FONT.mono,
  fontSize: 11,
  color: C.accentHi,
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

export default NewSkillDialog;
