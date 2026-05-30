import { useMemo, useState } from "react";
import {
  Activity,
  Archive,
  BadgeCheck,
  Bell,
  Book,
  BookOpen,
  Bookmark,
  Box,
  Brain,
  Briefcase,
  Calendar,
  CheckSquare,
  ClipboardList,
  Clock,
  Cloud,
  Code,
  Compass,
  Cpu,
  Database,
  FileText,
  Film,
  Flag,
  FlaskConical,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe,
  GraduationCap,
  Hash,
  Heart,
  Home,
  Image,
  Inbox,
  Lightbulb,
  Link,
  List,
  Mail,
  MapPin,
  MessageSquare,
  Mic,
  Network,
  Notebook,
  Package,
  Paperclip,
  PenLine,
  PieChart,
  Pin,
  Rocket,
  Search,
  Settings,
  Sparkles,
  Star,
  StickyNote,
  Tag,
  Target,
  Terminal,
  Trophy,
  Users,
  Video,
  Wand2,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { C, FONT } from "../theme.js";

/**
 * IconPicker — geschlossene Auswahl von lucide-react-Icon-Namen (Story 11.2,
 * AC 3). Der gewählte Name (PascalCase wie im lucide-react-Export) wird in
 * `MenuItem.icon` gespeichert.
 *
 * BEWUSST geschlossene Liste: keine dynamische Auflösung beliebiger lucide-
 * Namen zur Laufzeit (5000+ Icons, riesiges Bundle). Stattdessen ein
 * kuratierter, statisch importierter Satz — tree-shake-bar und
 * typ-vollständig. Neue Icons werden durch Erweitern von `ICON_SET`
 * hinzugefügt.
 *
 * Konsumenten (TreeView/Sidebar in 11.3/11.4) lösen `MenuItem.icon` über
 * `resolveIcon(name)` zu einer Komponente auf — Unbekanntes → `Folder` als
 * defensiver Default (spiegelt das Read-Fallback-Verhalten in core).
 *
 * [Source: epic-11-architecture-addendum.md §2; Story 11.2 AC 3]
 */

/**
 * Kuratierter, statisch importierter Icon-Satz. Key = lucide-react-Export-Name
 * (PascalCase) — genau dieser String landet in `MenuItem.icon`.
 */
const ICON_SET = {
  Folder,
  FolderOpen,
  FileText,
  Notebook,
  StickyNote,
  Inbox,
  Archive,
  Home,
  Star,
  Bookmark,
  Pin,
  Tag,
  Hash,
  Search,
  List,
  ClipboardList,
  CheckSquare,
  Flag,
  Target,
  Trophy,
  BadgeCheck,
  Calendar,
  Clock,
  Bell,
  Mail,
  MessageSquare,
  Users,
  Heart,
  Lightbulb,
  Brain,
  Sparkles,
  Wand2,
  Rocket,
  Zap,
  Compass,
  MapPin,
  Globe,
  Network,
  GitBranch,
  Workflow,
  Link,
  Paperclip,
  Book,
  BookOpen,
  GraduationCap,
  PenLine,
  Code,
  Terminal,
  Cpu,
  Database,
  Cloud,
  Box,
  Package,
  Briefcase,
  Gauge,
  Activity,
  PieChart,
  Image,
  Video,
  Film,
  Mic,
  FlaskConical,
  Settings,
} satisfies Record<string, LucideIcon>;

/** Geschlossene Liste der verfügbaren Icon-Namen. */
export type IconName = keyof typeof ICON_SET;

export const ICON_NAMES = Object.keys(ICON_SET) as IconName[];

/**
 * Löst einen gespeicherten Icon-Namen zu seiner Komponente auf. Unbekannt
 * (z.B. handgepfuschte YAML) → `Folder` als defensiver Default — nie crashen.
 */
export function resolveIcon(name: string): LucideIcon {
  return (ICON_SET as Record<string, LucideIcon>)[name] ?? Folder;
}

export function IconPicker({
  value,
  onChange,
}: {
  /** Aktuell gewählter Icon-Name (oder leer/unbekannt). */
  value: string;
  /** Liefert den gewählten lucide-Namen für `MenuItem.icon`. */
  onChange: (name: IconName) => void;
}) {
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return ICON_NAMES;
    return ICON_NAMES.filter((n) => n.toLowerCase().includes(q));
  }, [filter]);

  return (
    <div>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Icon filtern …"
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "8px 10px",
          marginBottom: 8,
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 6,
          color: C.text,
          fontFamily: FONT.ui,
          fontSize: 13,
          outline: "none",
        }}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(40px, 1fr))",
          gap: 6,
          maxHeight: 200,
          overflowY: "auto",
          padding: 2,
        }}
      >
        {visible.map((name) => {
          const Icon = ICON_SET[name];
          const selected = name === value;
          return (
            <button
              key={name}
              type="button"
              title={name}
              aria-label={name}
              aria-pressed={selected}
              onClick={() => onChange(name)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: 40,
                background: selected ? C.selection : C.elevated,
                border: `1px solid ${selected ? C.accent : C.border}`,
                borderRadius: 6,
                color: selected ? C.accent : C.textDim,
                cursor: "pointer",
              }}
            >
              <Icon size={18} />
            </button>
          );
        })}
        {visible.length === 0 && (
          <div
            style={{
              gridColumn: "1 / -1",
              padding: 12,
              color: C.textFaint,
              fontFamily: FONT.mono,
              fontSize: 12,
            }}
          >
            Kein Icon gefunden
          </div>
        )}
      </div>
    </div>
  );
}
