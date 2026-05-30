import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import * as LucideIcons from "lucide-react";
import {
  Circle,
  ChevronLeft,
  ChevronRight,
  Settings as SettingsIcon,
  Pencil,
  Trash2,
  type LucideProps,
} from "lucide-react";
import { api, type MenuItem } from "../api.js";
import { C, FONT } from "../theme.js";

/**
 * Sidebar — Story 11.3 (Seitenleisten-Rendering, System + Custom Menüpunkte).
 *
 * Lädt die *bereits gemergte* Menü-Liste über `api.getMenu()` (System-Items
 * vom Server vorangestellt, danach die Custom-Items des Nutzers) und rendert
 * sie als navigierbare Liste: Icon (lucide-react, dynamisch per Name) + Label,
 * der aktive Punkt ist hervorgehoben.
 *
 * Bewusst KEIN eigenes Routing / kein View-Mount hier: die Auflösung
 * (`resolveView(item.viewType)`) und das Mounten in die Main-Fläche macht der
 * App.tsx-Wireup (R-3, Addendum §7) — diese Komponente liefert lediglich den
 * `onSelectItem(item)`-Callback nach außen. Ebenso kein Editor-State: der
 * Zahnrad-Button ruft `onOpenEditor()` (MenuEditor liefert 11.2).
 *
 * System-Items (`kind:"system"`, z. B. Home/Skills) sind read-only — kein
 * Edit-/Lösch-Affordance. Custom-Items (`kind:"custom"`) zeigen Edit/Löschen.
 * Löschen/Editieren delegiert an den 11.2-Editor (Zahnrad → `onOpenEditor`);
 * die inline Edit/Löschen-Trigger eröffnen denselben Editor, vorselektiert auf
 * das jeweilige Item — der eigentliche Mutations-State lebt im 11.2-Editor,
 * nicht hier.
 *
 * Aktiver Menüpunkt + Collapse-Zustand der Sidebar liegen in localStorage
 * (Muster `lokyy:*`, analog `useResizableWidth`) — kein Vault-State (K-2).
 *
 * INLINE-TYPEN: `MenuItem` stammt aus `../api.js` (PWA-Inline-Spiegel von core
 * `MenuItem`). `@lokyy/core` ist node-only und darf nie ins Browser-Bundle
 * (Addendum §0).
 *
 * [Source: epic-11 Story 11.3; epic-11-architecture-addendum.md §0, §3, §7 (R-3)]
 */

const LS_COLLAPSED = "lokyy:sidebar:collapsed";
const LS_ACTIVE = "lokyy:sidebar:active";

export interface SidebarProps {
  /**
   * Id des aktuell aktiven Menüpunkts (Quelle der Wahrheit lebt im App-Wireup).
   * `null`/unbekannt → nichts hervorgehoben.
   */
  activeItemId: string | null;
  /**
   * Wird mit dem gewählten `MenuItem` aufgerufen, wenn der Nutzer einen Punkt
   * anklickt. Der App-Wireup löst daraus die View auf (`resolveView`) und
   * mountet sie in die Main-Fläche.
   */
  onSelectItem: (item: MenuItem) => void;
  /**
   * Öffnet den Menü-Editor (Story 11.2). Optional `item` → der Editor öffnet
   * direkt auf diesem Custom-Item (Edit-/Löschen-Trigger der Zeile). Ohne
   * Argument → Editor im Listen-/Anlege-Modus (Zahnrad-Button oben).
   */
  onOpenEditor: (item?: MenuItem) => void;
  /**
   * Eingebetteter Modus (Epic 11 Layout-Fix): NICHT als eigene Rail-Spalte
   * rendern, sondern als kompakte Menü-Liste OBEN im bestehenden `<aside>`
   * (über dem FileTree). Es gibt dann keine eigene Rail-Breite und keinen
   * Collapse-Toggle — die Items werden immer expandiert gezeigt und das
   * Wrapper-Element trägt keine eigene Spalten-Border. Default `false`
   * (eigenständige Rail, altes Verhalten).
   */
  embedded?: boolean;
}

/* ------------------------------------------------------------------ */
/* Dynamische lucide-react-Icon-Auflösung per Name.
 *
 * `MenuItem.icon` trägt einen lucide-Icon-Namen. Die YAML-Quelle nutzt
 * kebab-case ("file-text"), der lucide-React-Export ist PascalCase
 * ("FileText"). Wir normalisieren beides auf PascalCase und schlagen im
 * Namespace-Import nach. Unbekannt → defensiver Fallback `Circle` (nie Crash,
 * spiegelt das defensive Read-Verhalten in core / `resolveView`). */

type IconComponent = ComponentType<LucideProps>;

const ICONS = LucideIcons as unknown as Record<string, IconComponent>;

/** "file-text" | "fileText" | "FileText" → "FileText". */
function toPascalCase(name: string): string {
  return name
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function resolveIcon(name: string): IconComponent {
  if (!name) return Circle;
  const direct = ICONS[name];
  if (typeof direct === "function" || typeof direct === "object") {
    if (direct) return direct;
  }
  const pascal = ICONS[toPascalCase(name)];
  return pascal ?? Circle;
}

/* ------------------------------------------------------------------ */

export function Sidebar({
  activeItemId,
  onSelectItem,
  onOpenEditor,
  embedded = false,
}: SidebarProps) {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Im eingebetteten Modus gibt es keinen Collapse — die Liste ist immer
  // expandiert (kompakt im aside-Header). Der Collapse-State bleibt nur für die
  // eigenständige Rail relevant.
  const [collapsedRaw, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_COLLAPSED) === "1";
    } catch {
      return false;
    }
  });
  const collapsed = embedded ? false : collapsedRaw;

  // Letzte aktive Auswahl persistieren (Muster lokyy:*). Die App ist die
  // Quelle der Wahrheit (activeItemId-Prop); wir spiegeln sie nur, damit ein
  // Reload den vorigen Punkt wieder aktiv mounten kann.
  useEffect(() => {
    if (!activeItemId) return;
    try {
      localStorage.setItem(LS_ACTIVE, activeItemId);
    } catch {}
  }, [activeItemId]);

  useEffect(() => {
    if (embedded) return; // eingebettet kein eigener Collapse-State
    try {
      localStorage.setItem(LS_COLLAPSED, collapsedRaw ? "1" : "0");
    } catch {}
  }, [collapsedRaw, embedded]);

  const loadMenu = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await api.getMenu();
      // Server liefert bereits System-zuerst-dann-Custom; defensiv stabil
      // nachsortieren, falls eine Quelle die Reihenfolge nicht garantiert.
      const sorted = [...cfg.items].sort((a, b) => {
        const rank = (k: MenuItem["kind"]) => (k === "system" ? 0 : 1);
        return rank(a.kind) - rank(b.kind);
      });
      setItems(sorted);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Menü konnte nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMenu();
  }, [loadMenu]);

  const systemItems = useMemo(
    () => items.filter((i) => i.kind === "system"),
    [items],
  );
  const customItems = useMemo(
    () => items.filter((i) => i.kind === "custom"),
    [items],
  );

  const width = collapsed ? 56 : 240;

  // Eingebettet: kein eigenes <aside>-Element (das ist bereits der aside in
  // App.tsx), sondern ein <div>-Block ohne eigene Spalten-Breite/-Border, der
  // sich auf seine Inhaltshöhe beschränkt und den FileTree darunter nicht
  // verdrängt. Eigenständig (Rail): bisheriges Verhalten unverändert.
  const Wrapper: "aside" | "div" = embedded ? "div" : "aside";

  return (
    <Wrapper
      style={
        embedded
          ? {
              flexShrink: 0,
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              maxHeight: "45%",
              minHeight: 0,
              background: C.panel,
              borderBottom: `1px solid ${C.border}`,
              fontFamily: FONT.ui,
              overflow: "hidden",
            }
          : {
              width,
              flexShrink: 0,
              height: "100%",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              background: C.panel,
              borderRight: `1px solid ${C.border}`,
              fontFamily: FONT.ui,
              transition: "width 140ms ease",
              overflow: "hidden",
            }
      }
    >
      {/* Kopf: Zahnrad (Editor öffnen, 11.2) + Collapse-Toggle. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "space-between",
          gap: 4,
          padding: collapsed ? "10px 0" : "10px 8px 10px 12px",
          borderBottom: `1px solid ${C.borderSoft}`,
          minHeight: 44,
          boxSizing: "border-box",
        }}
      >
        {!collapsed && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: C.textFaint,
            }}
          >
            Workspace
          </span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          {!collapsed && (
            <button
              type="button"
              title="Menü bearbeiten"
              aria-label="Menü bearbeiten"
              onClick={() => onOpenEditor()}
              style={iconButtonStyle}
              onMouseEnter={hoverOn}
              onMouseLeave={hoverOff}
            >
              <SettingsIcon size={16} />
            </button>
          )}
          {!embedded && (
            <button
              type="button"
              title={collapsed ? "Seitenleiste ausklappen" : "Seitenleiste einklappen"}
              aria-label={collapsed ? "Seitenleiste ausklappen" : "Seitenleiste einklappen"}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((c) => !c)}
              style={iconButtonStyle}
              onMouseEnter={hoverOn}
              onMouseLeave={hoverOff}
            >
              {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          )}
        </div>
      </div>

      {/* Liste */}
      <nav
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "6px 0",
        }}
      >
        {loading && (
          <div style={hintStyle}>{collapsed ? "…" : "Lade Menü …"}</div>
        )}

        {error && !loading && (
          <div style={{ ...hintStyle, color: C.err, fontFamily: FONT.mono }}>
            {collapsed ? "!" : error}
          </div>
        )}

        {!loading &&
          !error &&
          systemItems.map((item) => (
            <SidebarRow
              key={item.id}
              item={item}
              active={item.id === activeItemId}
              collapsed={collapsed}
              onSelect={onSelectItem}
              onOpenEditor={onOpenEditor}
            />
          ))}

        {/* Trenner zwischen System- und Custom-Items, sobald beide existieren. */}
        {!loading &&
          !error &&
          systemItems.length > 0 &&
          customItems.length > 0 && (
            <div
              style={{
                height: 1,
                background: C.borderSoft,
                margin: collapsed ? "6px 12px" : "6px 12px",
              }}
            />
          )}

        {!loading &&
          !error &&
          customItems.map((item) => (
            <SidebarRow
              key={item.id}
              item={item}
              active={item.id === activeItemId}
              collapsed={collapsed}
              onSelect={onSelectItem}
              onOpenEditor={onOpenEditor}
            />
          ))}
      </nav>
    </Wrapper>
  );
}

/* ------------------------------------------------------------------ */

function SidebarRow({
  item,
  active,
  collapsed,
  onSelect,
  onOpenEditor,
}: {
  item: MenuItem;
  active: boolean;
  collapsed: boolean;
  onSelect: (item: MenuItem) => void;
  onOpenEditor: (item?: MenuItem) => void;
}) {
  const [hover, setHover] = useState(false);
  const Icon = resolveIcon(item.icon);
  const isCustom = item.kind === "custom";

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "1px 6px",
        padding: collapsed ? "8px 0" : "7px 8px 7px 10px",
        justifyContent: collapsed ? "center" : "flex-start",
        borderRadius: 7,
        cursor: "pointer",
        color: active ? C.accentHi : hover ? C.text : C.textDim,
        background: active ? C.selection : hover ? C.accentSoft : "transparent",
        borderLeft: `2px solid ${active ? C.accent : "transparent"}`,
        transition: "background 100ms, color 100ms",
        position: "relative",
      }}
    >
      <button
        type="button"
        onClick={() => onSelect(item)}
        title={collapsed ? item.label : undefined}
        aria-current={active ? "page" : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          justifyContent: collapsed ? "center" : "flex-start",
          background: "transparent",
          border: "none",
          color: "inherit",
          font: "inherit",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <Icon size={17} style={{ flexShrink: 0 }} />
        {!collapsed && (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13.5,
              fontWeight: active ? 600 : 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {item.label}
          </span>
        )}
      </button>

      {/* Edit/Löschen nur für Custom-Items, nur expandiert + on hover/active.
          System-Items sind read-only → keinerlei Affordance. */}
      {!collapsed && isCustom && (hover || active) && (
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button
            type="button"
            title="Menüpunkt bearbeiten"
            aria-label={`Menüpunkt „${item.label}" bearbeiten`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenEditor(item);
            }}
            style={rowActionStyle}
            onMouseEnter={hoverOn}
            onMouseLeave={hoverOff}
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            title="Menüpunkt löschen"
            aria-label={`Menüpunkt „${item.label}" löschen`}
            onClick={(e) => {
              e.stopPropagation();
              // Löschen läuft über den 11.2-Editor (Bestätigung + putMenu dort);
              // hier nur den Editor vorselektiert öffnen.
              onOpenEditor(item);
            }}
            style={rowActionStyle}
            onMouseEnter={hoverOn}
            onMouseLeave={hoverOff}
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline-Styles + Hover-Helfer (gleiches Muster wie übrige PWA-Komponenten). */

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: C.textDim,
  cursor: "pointer",
  transition: "background 100ms, color 100ms",
};

const rowActionStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 5,
  border: "none",
  background: "transparent",
  color: C.textFaint,
  cursor: "pointer",
  transition: "background 100ms, color 100ms",
};

const hintStyle: React.CSSProperties = {
  padding: "12px 14px",
  color: C.textFaint,
  fontSize: 12,
};

function hoverOn(e: React.MouseEvent<HTMLButtonElement>) {
  const el = e.currentTarget;
  el.style.background = C.hover;
  el.style.color = C.text;
}

function hoverOff(e: React.MouseEvent<HTMLButtonElement>) {
  const el = e.currentTarget;
  el.style.background = "transparent";
  el.style.color = C.textDim;
}
