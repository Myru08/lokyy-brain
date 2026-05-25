import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { api } from "./api.js";
import { C, FONT } from "./theme.js";

/**
 * TemplatePicker — modal that lists templates from `00_meta/templates/`,
 * fills variables, and hands the result up to the parent which creates the
 * actual note via `api.createNote(path, body)`.
 *
 * Style matches `QuickSwitcher.tsx`: Fraunces serif, warm dark palette,
 * terracotta accent, blurred backdrop at z-index 60.
 *
 * Supported variables in the template body (MVP):
 *   {{date}}      YYYY-MM-DD     (local TZ)
 *   {{time}}      HH:MM          (local TZ)
 *   {{datetime}}  YYYY-MM-DDTHH:MM:SS  (local-clock ISO, no offset)
 *   {{title}}     user-provided title
 *   {{user}}      `currentUser` prop
 *   {{id}}        random identifier (see fillTemplate note)
 */

export interface TemplatePickerProps {
  open: boolean;
  onClose: () => void;
  onCreate: (targetPath: string, body: string) => Promise<void>;
  /** Logged-in username — substituted for `{{user}}`. */
  currentUser: string;
  /** Default target folder, e.g. "10_inbox". Empty string = vault root. */
  defaultFolder?: string;
}

interface TemplateRef {
  name: string;
  path: string;
  preview: string;
}

/**
 * Convert a title into a safe filename: lowercase, ASCII-ish, hyphenated.
 * Conservative — the user can override the result in the form.
 */
function kebab(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // strip Unicode combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Strip leading / trailing slashes; collapse internal doubles. */
function normalizePath(p: string): string {
  return p
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

/**
 * Replace `{{var}}` placeholders. For `{{id}}` we use `crypto.randomUUID()`
 * (NOT a ULID) as an inline fallback — the PWA bundle does not depend on
 * the `ulid` package, and the server's `createNote` will generate the real
 * SPEC-valid ULID for the frontmatter regardless. This `{{id}}` is only for
 * templates that want a stable random token in the body itself.
 */
function fillTemplate(
  body: string,
  ctx: { title: string; user: string },
): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const datetime =
    `${date}T${time}:${pad(now.getSeconds())}`;
  // crypto.randomUUID is available in all modern browsers + Node ≥ 19.
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return body
    .replaceAll("{{date}}", date)
    .replaceAll("{{time}}", time)
    .replaceAll("{{datetime}}", datetime)
    .replaceAll("{{title}}", ctx.title)
    .replaceAll("{{user}}", ctx.user || "anonymous")
    .replaceAll("{{id}}", id);
}

export function TemplatePicker({
  open,
  onClose,
  onCreate,
  currentUser,
  defaultFolder = "",
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<TemplateRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);

  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState(defaultFolder);
  const [filename, setFilename] = useState("");
  const [filenameTouched, setFilenameTouched] = useState(false);
  const [creating, setCreating] = useState(false);

  const titleRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Load templates on every open. Reset form state too.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedName(null);
    setCursor(0);
    setTitle("");
    setFolder(defaultFolder);
    setFilename("");
    setFilenameTouched(false);
    api
      .listTemplates()
      .then((rows) => {
        if (cancelled) return;
        setTemplates(rows);
        if (rows.length > 0) setSelectedName(rows[0]!.name);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTemplates([]);
        setError(e instanceof Error ? e.message : "Templates konnten nicht geladen werden");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    const t = window.setTimeout(() => titleRef.current?.focus(), 30);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, defaultFolder]);

  // Auto-derive filename from title until user types in the filename field.
  useEffect(() => {
    if (filenameTouched) return;
    setFilename(kebab(title));
  }, [title, filenameTouched]);

  // Keep cursor and selectedName aligned.
  useEffect(() => {
    if (templates.length === 0) {
      setCursor(0);
      return;
    }
    setCursor((c) => Math.min(c, templates.length - 1));
  }, [templates]);

  useEffect(() => {
    if (templates.length === 0) return;
    setSelectedName(templates[cursor]?.name ?? null);
  }, [cursor, templates]);

  // Scroll active list item into view.
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const active = root.querySelector<HTMLDivElement>(
      `[data-tpl-idx="${cursor}"]`,
    );
    if (active) active.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const canCreate = useMemo(
    () =>
      !creating &&
      !!selectedName &&
      title.trim().length > 0 &&
      filename.trim().length > 0,
    [creating, selectedName, title, filename],
  );

  if (!open) return null;

  async function handleCreate() {
    if (!selectedName || !canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const tpl = await api.getTemplate(selectedName);
      const filled = fillTemplate(tpl.body, {
        title: title.trim(),
        user: currentUser,
      });
      const cleanFolder = normalizePath(folder);
      const cleanFile = filename.trim().replace(/\.md$/i, "");
      if (!cleanFile) {
        setError("Filename darf nicht leer sein");
        setCreating(false);
        return;
      }
      const targetPath = cleanFolder
        ? `${cleanFolder}/${cleanFile}`
        : cleanFile;
      await onCreate(targetPath, filled);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Anlegen fehlgeschlagen");
    } finally {
      setCreating(false);
    }
  }

  function onKeyDownRoot(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  function onKeyDownList(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (templates.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, templates.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    }
  }

  return (
    <div
      onClick={onClose}
      onKeyDown={onKeyDownRoot}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(820px, 94vw)",
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
          overflow: "hidden",
          fontFamily: FONT.serif,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "14px 20px",
            borderBottom: `1px solid ${C.border}`,
            color: C.text,
            fontFamily: FONT.serif,
            fontSize: 17,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>From template</span>
          <span
            style={{
              fontFamily: FONT.mono,
              fontSize: 11,
              color: C.textFaint,
            }}
          >
            ↑↓ select · Esc close
          </span>
        </div>

        <div style={{ display: "flex", minHeight: 360 }}>
          {/* LEFT: template list */}
          <div
            ref={listRef}
            tabIndex={0}
            onKeyDown={onKeyDownList}
            style={{
              width: 280,
              borderRight: `1px solid ${C.border}`,
              maxHeight: "60vh",
              overflowY: "auto",
              outline: "none",
            }}
          >
            {loading && (
              <div
                style={{
                  padding: 14,
                  fontSize: 12,
                  color: C.textDim,
                  fontFamily: FONT.mono,
                }}
              >
                loading templates …
              </div>
            )}
            {!loading && templates.length === 0 && (
              <div
                style={{
                  padding: 18,
                  color: C.textDim,
                  fontSize: 13,
                  fontFamily: FONT.serif,
                }}
              >
                No templates yet.
                <br />
                <span
                  style={{
                    fontFamily: FONT.mono,
                    fontSize: 11,
                    color: C.textFaint,
                  }}
                >
                  Add .md files in 00_meta/templates/
                </span>
              </div>
            )}
            {!loading &&
              templates.map((t, i) => (
                <TemplateRow
                  key={t.path}
                  idx={i}
                  name={t.name}
                  preview={t.preview}
                  active={cursor === i}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => setCursor(i)}
                />
              ))}
          </div>

          {/* RIGHT: form */}
          <div
            style={{
              flex: 1,
              padding: "18px 22px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div
              style={{
                fontFamily: FONT.serif,
                fontSize: 22,
                color: C.accent,
                lineHeight: 1.2,
                minHeight: 28,
              }}
            >
              {selectedName ?? "—"}
            </div>

            <Field label="Title">
              <input
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canCreate) {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
                placeholder="New note title"
                style={inputStyle}
              />
            </Field>

            <Field label="Target folder">
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder={defaultFolder || "(vault root)"}
                style={inputStyle}
              />
            </Field>

            <Field label="Filename">
              <input
                value={filename}
                onChange={(e) => {
                  setFilenameTouched(true);
                  setFilename(e.target.value);
                }}
                placeholder="auto-derived from title"
                style={inputStyle}
              />
            </Field>

            {error && (
              <div
                style={{
                  color: C.err,
                  fontFamily: FONT.mono,
                  fontSize: 12,
                }}
              >
                {error}
              </div>
            )}

            <div
              style={{
                marginTop: "auto",
                display: "flex",
                gap: 10,
                justifyContent: "flex-end",
                paddingTop: 6,
              }}
            >
              <button
                type="button"
                onClick={onClose}
                style={buttonGhostStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={!canCreate}
                style={{
                  ...buttonPrimaryStyle,
                  opacity: canCreate ? 1 : 0.5,
                  cursor: canCreate ? "pointer" : "not-allowed",
                }}
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TemplateRow({
  idx,
  name,
  preview,
  active,
  onMouseEnter,
  onClick,
}: {
  idx: number;
  name: string;
  preview: string;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  return (
    <div
      data-tpl-idx={idx}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      style={{
        padding: "10px 14px",
        cursor: "pointer",
        background: active ? C.accentDim : "transparent",
        borderLeft: `3px solid ${active ? C.accent : "transparent"}`,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div
        style={{
          color: active ? C.accent : C.text,
          fontFamily: FONT.serif,
          fontSize: 14,
          lineHeight: 1.3,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </div>
      <div
        style={{
          color: C.textFaint,
          fontFamily: FONT.mono,
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {preview || "(empty)"}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontFamily: FONT.mono,
        fontSize: 11,
        color: C.textDim,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {label}
      {children}
    </label>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: C.elevated,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  color: C.text,
  fontFamily: FONT.serif,
  fontSize: 15,
  outline: "none",
};

const buttonGhostStyle: CSSProperties = {
  padding: "8px 16px",
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  color: C.textDim,
  fontFamily: FONT.serif,
  fontSize: 14,
  cursor: "pointer",
};

const buttonPrimaryStyle: CSSProperties = {
  padding: "8px 18px",
  background: C.accent,
  border: `1px solid ${C.accent}`,
  borderRadius: 6,
  color: "#FFFFFF",
  fontFamily: FONT.serif,
  fontSize: 14,
  fontWeight: 600,
};
