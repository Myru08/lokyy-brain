import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ChevronRight, FileText, FolderTree, Plus } from "lucide-react";
import type { Note, TreeNode } from "@lokyy/shared";
import { api } from "../../api.js";
import { C, FONT } from "../../theme.js";
import type { ViewProps } from "./registry.js";
import { NewSkillDialog } from "./NewSkillDialog.js";
import {
  deriveSkillStructures,
  type CompanionFile,
  type SkillStructure,
} from "./skillStructure.js";

/**
 * SkillsView — echter Renderer für `viewType: "skills"` (Story 11.5).
 *
 * Stellt die Skills aus dem konfigurierten System-Menüpunkt-Ordner
 * (`item.folder`, Default `70_pai/skills/`) als KARTEN-Bibliothek dar —
 * Claude-Desktop-Stil: Titel, Beschreibung, `allowed_tools`-Chips und eine
 * Markdown-Vorschau. Die Ordner-Verschachtelung des Vaults wird als
 * Gruppierung sichtbar gemacht (eine Gruppen-Überschrift je Unterordner).
 *
 * Datenquelle (Addendum §0): ausschließlich die bestehenden HTTP-Endpunkte
 * (`api.tree()` für die Ordnerstruktur, `api.getNote()` für Frontmatter +
 * Body je Skill). KEIN MCP-Client im Browser; `@lokyy/core` bleibt außen vor.
 *
 * Skills sind `type: skill`-Notes (Epic 9). Wir lesen den Typ aus dem
 * YAML-Frontmatter des Bodys — `NoteSummary` trägt ihn nicht. Notes ohne
 * `type: skill` (z.B. README oder Topic-Notizen im selben Ordner) werden
 * herausgefiltert.
 *
 * Kein eigener Routing-/Editor-State: Klick auf eine Karte delegiert über
 * `onOpenNote` in `App.open()`.
 *
 * Story 12.2 — Strukturansicht: Ein Skill kann ein ORDNER
 * `70_pai/skills/<name>/` mit `SKILL.md` (`type: skill`) + `references/*.md` +
 * `templates/*` sein (Anthropic-Format). Solche Ordner-Skills werden als EINE
 * Karte mit aufklappbarer Struktur (references/templates als kleiner Baum)
 * gezeigt; Einzel-Note-Skills (`<name>.md`) bleiben einfache Karten. Die
 * Struktur-Ableitung (Tree → Skill-Liste, keine Doppelung) liegt rein und
 * testbar in `skillStructure.ts`.
 *
 * [Source: epic-11-architecture-addendum.md §2; Story 11.5; Epic 9;
 *  epic-12-ordner-skills.md — Story 12.2]
 */

/** Default-Ordner, falls der Menüpunkt keinen Ordner trägt (System-Item-Fallback). */
const DEFAULT_SKILLS_FOLDER = "70_pai/skills";

/* ── Layout-Styles (Shell + Kopfzeile mit „+ Neuer Skill") ───────────── */

const SHELL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  boxSizing: "border-box",
};

const HEADER_BAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "10px 12px",
  borderBottom: `1px solid ${C.border}`,
  flexShrink: 0,
};

const HEADER_TITLE_STYLE: CSSProperties = {
  color: C.gold,
  fontFamily: FONT.ui,
  fontWeight: 700,
  fontSize: 12,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

const NEW_SKILL_BTN_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "5px 10px",
  background: C.accentSoft,
  border: `1px solid ${C.border}`,
  borderRadius: 7,
  color: C.accentHi,
  fontFamily: FONT.ui,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  flexShrink: 0,
};

const NOTICE_STYLE: CSSProperties = {
  margin: "10px 12px 0",
  padding: "8px 11px",
  borderRadius: 7,
  background: "rgba(127,163,122,0.12)",
  border: "1px solid rgba(127,163,122,0.4)",
  color: C.ok,
  fontFamily: FONT.ui,
  fontSize: 12.5,
  lineHeight: 1.4,
};

/** Aus Frontmatter + Tree-Struktur zusammengesetzte Skill-Karte. */
interface SkillCard {
  /** Note-id der Haupt-Note (SKILL.md bzw. Einzel-Note) — an `onOpenNote`. */
  id: string;
  /** "folder-skill" = Ordner mit SKILL.md + Begleitern; "single-note" = lose `.md`. */
  kind: "folder-skill" | "single-note";
  /** Ordner-/Skill-Name (Sortier-/Dedup-Schlüssel aus der Struktur). */
  name: string;
  /** Anzeigetitel (Frontmatter `title` → H1 → Dateiname). */
  title: string;
  /** Frontmatter `description` (oder leerer String). */
  description: string;
  /** Frontmatter `allowed_tools` als Liste (oder leer). */
  allowedTools: string[];
  /** Plaintext-Markdown-Vorschau (Body ohne Frontmatter, geklammert). */
  preview: string;
  /** Begleit-`.md` unter `references/` (nur folder-skill). */
  references: CompanionFile[];
  /** Begleit-Dateien unter `templates/` (nur folder-skill). */
  templates: CompanionFile[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** `[a, b, "c d"]` → ["a","b","c d"]. Keine Verschachtelung. */
function parseInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((part) => stripQuotes(part.trim()))
    .filter((s) => s.length > 0);
}

/**
 * Liest die wenigen Frontmatter-Felder, die die Karte braucht. Flacher
 * Parser (gespiegelt aus `PropertiesPanel`/`embedPreview` — kein
 * gray-matter im Browser-Bundle). Unterstützt Skalare, Inline-Arrays und
 * — speziell für `allowed_tools` — YAML-Block-Listen (`- item`).
 */
function parseSkillFrontmatter(body: string): {
  type: string | null;
  title: string | null;
  description: string | null;
  allowedTools: string[];
  bodyAfter: string;
} {
  const m = FRONTMATTER_RE.exec(body);
  if (!m) {
    return {
      type: null,
      title: null,
      description: null,
      allowedTools: [],
      bodyAfter: body,
    };
  }
  const block = m[1] ?? "";
  const bodyAfter = body.slice(m[0].length);
  const lines = block.split(/\r?\n/);

  let type: string | null = null;
  let title: string | null = null;
  let description: string | null = null;
  let allowedTools: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const km = /^([A-Za-z_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1] as string;
    const rest = (km[2] ?? "").trim();

    if (key === "type" && type === null) type = stripQuotes(rest);
    else if (key === "title" && title === null) title = stripQuotes(rest);
    else if (key === "description" && description === null) {
      description = stripQuotes(rest);
    } else if (key === "allowed_tools" && allowedTools.length === 0) {
      if (rest.startsWith("[") && rest.endsWith("]")) {
        allowedTools = parseInlineArray(rest);
      } else if (rest === "") {
        // Block-Liste auf den Folgezeilen: `  - foo`.
        const collected: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j] ?? "";
          const lm = /^\s*-\s+(.*)$/.exec(next);
          if (!lm) {
            // Erste Nicht-Listenzeile (oder nächster Key) beendet die Liste.
            if (next.trim() === "") continue;
            break;
          }
          const tool = stripQuotes((lm[1] ?? "").trim());
          if (tool) collected.push(tool);
        }
        allowedTools = collected;
      } else {
        allowedTools = [stripQuotes(rest)];
      }
    }
  }

  return { type, title, description, allowedTools, bodyAfter };
}

/** Erste H1 aus dem Body (ohne Frontmatter) als Titel-Fallback. */
function firstHeading(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const h = /^#\s+(.*)$/.exec(line.trim());
    if (h) return (h[1] ?? "").trim() || null;
  }
  return null;
}

/**
 * Plaintext-Vorschau aus dem Markdown-Body: Headings/Listen-/Quote-Marker
 * abstreifen, Wikilinks/Emphasis entschärfen, auf ~280 Zeichen klammern.
 * Bewusst dependency-frei (kein Markdown-Renderer im Bundle) — die volle
 * Markdown-Darstellung liefert der Editor beim Öffnen der Skill-Note.
 */
function buildPreview(bodyAfter: string): string {
  const text = bodyAfter
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*[-*+]\s+/, "").replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1") // [[link|alias]] → link
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // inline code
    .replace(/[*_~]{1,3}/g, "") // emphasis markers
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 280 ? `${text.slice(0, 280).trimEnd()}…` : text;
}

/** Findet den Teilbaum-Knoten zu einem Ordnerpfad und liefert dessen Kinder. */
function scopeToFolder(tree: TreeNode[], folder: string): TreeNode[] | null {
  if (!folder) return tree;
  const stack: TreeNode[] = [...tree];
  while (stack.length > 0) {
    const node = stack.shift() as TreeNode;
    if (node.type === "folder" && node.path === folder) return node.children;
    if (node.children.length > 0) stack.push(...node.children);
  }
  return null;
}

export function SkillsView({ item, onOpenNote }: ViewProps) {
  const folder = item.folder || DEFAULT_SKILLS_FOLDER;
  const [cards, setCards] = useState<SkillCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** Quittung nach erfolgreichem Anlegen (z. B. „Skill 'x' angelegt"). */
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const tree = await api.tree();
      const scoped = scopeToFolder(tree, folder);
      if (scoped === null) {
        setCards([]);
        setError(null);
        setLoading(false);
        return;
      }
      // Struktur rein aus dem Tree ableiten (folder-skill vs single-note,
      // references/templates gruppiert, keine Doppelung) — synchron, testbar.
      const structures = deriveSkillStructures(scoped);
      // Nur die Haupt-Note (SKILL.md bzw. Einzel-Note) je Kandidat laden, um
      // `type: skill` zu bestätigen und Titel/Beschreibung zu ziehen. Begleit-
      // Files werden NICHT geladen (Anthropic-Pattern: SKILL.md ist die Tür).
      // Parallel über Promise.all; einzelne Fehler verwerfen wir still
      // (eine kaputte Note darf die Bibliothek nicht killen).
      const loaded = await Promise.all(
        structures.map(async (s: SkillStructure) => {
          try {
            const note: Note = await api.getNote(s.mainPath);
            const fm = parseSkillFrontmatter(note.body);
            if (fm.type !== "skill") return null;
            const card: SkillCard = {
              id: note.id,
              kind: s.kind,
              name: s.name,
              title: fm.title || firstHeading(fm.bodyAfter) || note.title || s.name,
              description: fm.description ?? "",
              allowedTools: fm.allowedTools,
              preview: buildPreview(fm.bodyAfter),
              references: s.references,
              templates: s.templates,
            };
            return card;
          } catch {
            return null;
          }
        }),
      );
      const valid = loaded.filter((c): c is SkillCard => c !== null);
      valid.sort((a, b) => a.name.localeCompare(b.name));
      setCards(valid);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Skills konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, [folder]);

  useEffect(() => {
    void load();
  }, [load]);

  // Bekannte skill_name (Ordner- bzw. Dateiname) für die Duplikat-Prüfung im
  // Dialog. `card.name` ist der stabile Struktur-Schlüssel aus der Ableitung.
  const existingSkillNames = useMemo(
    () => cards.map((c) => c.name),
    [cards],
  );

  const handleCreated = useCallback(
    (noteId: string) => {
      setDialogOpen(false);
      const name = noteId.split("/").pop() ?? noteId;
      setNotice(`Skill „${name}" angelegt.`);
      void load();
    },
    [load],
  );

  // Gemeinsamer Kopf (Titel + „+ Neuer Skill") — in allen States sichtbar.
  const header = (
    <div style={HEADER_BAR_STYLE}>
      <span style={HEADER_TITLE_STYLE}>Skill-Bibliothek</span>
      <button
        type="button"
        onClick={() => {
          setNotice(null);
          setDialogOpen(true);
        }}
        style={NEW_SKILL_BTN_STYLE}
        title="Neuen Skill per Vorlage anlegen"
      >
        <Plus size={14} />
        Neuer Skill
      </button>
    </div>
  );

  const dialog = dialogOpen ? (
    <NewSkillDialog
      onClose={() => setDialogOpen(false)}
      onCreated={handleCreated}
      existingSkillNames={existingSkillNames}
    />
  ) : null;

  if (error) {
    return (
      <div style={SHELL_STYLE}>
        {header}
        <div style={{ padding: 16, color: C.err, fontFamily: FONT.mono, fontSize: 12 }}>
          {error}
        </div>
        {dialog}
      </div>
    );
  }

  if (loading) {
    return (
      <div style={SHELL_STYLE}>
        {header}
        <div style={{ padding: 16, color: C.textFaint, fontFamily: FONT.mono, fontSize: 12 }}>
          Lade Skills…
        </div>
        {dialog}
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div style={SHELL_STYLE}>
        {header}
        {notice && <div style={NOTICE_STYLE}>{notice}</div>}
        <div
          style={{
            padding: "16px",
            color: C.textDim,
            fontFamily: FONT.mono,
            fontSize: 12.5,
            lineHeight: 1.6,
          }}
        >
          <div style={{ color: C.textFaint }}>Keine Skills in „{folder}".</div>
        </div>
        {dialog}
      </div>
    );
  }

  return (
    <div style={SHELL_STYLE}>
      {header}
      {notice && <div style={NOTICE_STYLE}>{notice}</div>}
      <div
        style={{
          padding: "12px 12px 24px",
          fontFamily: FONT.ui,
          overflowY: "auto",
          flex: 1,
          minHeight: 0,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {cards.map((card) => (
            <SkillCardItem key={card.id} card={card} onOpen={onOpenNote} />
          ))}
        </div>
      </div>
      {dialog}
    </div>
  );
}

function SkillCardItem({
  card,
  onOpen,
}: {
  card: SkillCard;
  onOpen: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  // Ordner-Skills tragen eine aufklappbare Struktur (references/templates).
  // Default eingeklappt — wie die Claude-Desktop-Skill-Karte.
  const [expanded, setExpanded] = useState(false);
  const hasStructure =
    card.kind === "folder-skill" &&
    (card.references.length > 0 || card.templates.length > 0);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? C.elevated : C.panel,
        border: `1px solid ${hover ? C.borderStrong : C.border}`,
        borderRadius: 8,
        padding: "12px 14px",
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      {/* Titelzeile = öffnet die Haupt-Note (SKILL.md bzw. Einzel-Note). */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(card.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(card.id);
          }
        }}
        style={{ cursor: "pointer", outline: "none" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            color: C.text,
            fontWeight: 600,
            fontSize: 14,
            marginBottom: card.description ? 4 : 8,
          }}
        >
          {card.kind === "folder-skill" ? (
            <FolderTree size={14} style={{ color: C.gold, flexShrink: 0 }} />
          ) : (
            <FileText size={14} style={{ color: C.textDim, flexShrink: 0 }} />
          )}
          <span>{card.title}</span>
        </div>
        {card.description && (
          <div
            style={{
              color: C.textDim,
              fontSize: 12.5,
              lineHeight: 1.5,
              marginBottom: 8,
            }}
          >
            {card.description}
          </div>
        )}
      </div>

      {card.allowedTools.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {card.allowedTools.map((tool) => (
            <span
              key={tool}
              style={{
                fontFamily: FONT.mono,
                fontSize: 10.5,
                color: C.accentHi,
                background: C.accentSoft,
                border: `1px solid ${C.border}`,
                borderRadius: 5,
                padding: "2px 7px",
                lineHeight: 1.4,
              }}
            >
              {tool}
            </span>
          ))}
        </div>
      )}

      {card.preview && (
        <div
          style={{
            color: C.textFaint,
            fontFamily: FONT.mono,
            fontSize: 11,
            lineHeight: 1.55,
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            marginBottom: hasStructure ? 8 : 0,
          }}
        >
          {card.preview}
        </div>
      )}

      {/* Aufklappbare Struktur — nur Ordner-Skills mit Begleit-Files. */}
      {hasStructure && (
        <SkillStructureSection
          references={card.references}
          templates={card.templates}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}

/**
 * Aufklappbarer Struktur-Block einer Ordner-Skill-Karte: ein „Struktur"-
 * Toggle, darunter `references/` und `templates/` als kleiner Baum. Klick auf
 * ein `.md`-Begleit-File öffnet es via `onOpen`; non-`.md` (z.B.
 * `dashboard.jsx`) werden nur gelistet (nicht im Markdown-Editor öffenbar).
 */
function SkillStructureSection({
  references,
  templates,
  expanded,
  onToggle,
  onOpen,
}: {
  references: CompanionFile[];
  templates: CompanionFile[];
  expanded: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  const total = references.length + templates.length;
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          background: "transparent",
          border: "none",
          padding: "2px 0",
          cursor: "pointer",
          color: C.textDim,
          fontFamily: FONT.mono,
          fontSize: 11,
          letterSpacing: "0.03em",
          textTransform: "uppercase",
        }}
        aria-expanded={expanded}
      >
        <ChevronRight
          size={13}
          style={{
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 120ms ease",
            flexShrink: 0,
          }}
        />
        Struktur · {total} {total === 1 ? "Datei" : "Dateien"}
      </button>

      {expanded && (
        <div style={{ marginTop: 6, paddingLeft: 4 }}>
          {references.length > 0 && (
            <CompanionGroup label="references/" files={references} onOpen={onOpen} />
          )}
          {templates.length > 0 && (
            <CompanionGroup label="templates/" files={templates} onOpen={onOpen} />
          )}
        </div>
      )}
    </div>
  );
}

/** Eine benannte Begleit-Gruppe (references/ oder templates/) als Liste. */
function CompanionGroup({
  label,
  files,
  onOpen,
}: {
  label: string;
  files: CompanionFile[];
  onOpen: (id: string) => void;
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          color: C.textFaint,
          fontFamily: FONT.mono,
          fontSize: 11,
          margin: "4px 0 2px",
        }}
      >
        {label}
      </div>
      {files.map((file) => (
        <CompanionRow key={file.path} file={file} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** Eine Begleit-Datei-Zeile. `.md` öffnet via onOpen; non-`.md` nur Anzeige. */
function CompanionRow({
  file,
  onOpen,
}: {
  file: CompanionFile;
  onOpen: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const openable = file.isMarkdown;
  const handleOpen = () => {
    if (openable) onOpen(file.id);
  };
  return (
    <div
      role={openable ? "button" : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={handleOpen}
      onKeyDown={(e) => {
        if (openable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          handleOpen();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 6px 3px 14px",
        borderRadius: 5,
        cursor: openable ? "pointer" : "default",
        background: openable && hover ? C.accentSoft : "transparent",
        color: openable ? C.text : C.textDim,
        fontFamily: FONT.mono,
        fontSize: 11.5,
        outline: "none",
      }}
      title={openable ? `Öffnen: ${file.path}` : file.path}
    >
      <FileText size={12} style={{ color: C.textFaint, flexShrink: 0 }} />
      <span>{file.name}</span>
    </div>
  );
}
