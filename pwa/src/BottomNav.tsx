import type { CSSProperties, ReactNode } from "react";
import {
  PanelLeft,
  Search as SearchIcon,
  Plus,
  Mic,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { C, FONT } from "./theme.js";
import { TOUCH_TARGET_MIN } from "./responsive.js";
import type { SaveStatus } from "./NoteHeader.js";

/**
 * BottomNav — persistent mobile bottom tab bar.
 *
 * Mobile testing surfaced that the top-bar action buttons sit out of thumb
 * reach and there was no primary navigation affordance. This bar fixes both:
 * five large (≥44px) targets pinned to the bottom of the viewport, safe-area
 * aware so it clears the iOS home-indicator / Android gesture bar.
 *
 * The bar is purely presentational — every action is a callback prop owned by
 * App.tsx. The Sync tab mirrors the editor's save/sync lifecycle so the user
 * always sees whether a reconcile is pending/in-flight without opening the
 * note-actions sheet.
 *
 * Rendering is gated by the caller (App only mounts this when `isMobile`), so
 * desktop never sees it and its layout is untouched.
 */

export interface BottomNavProps {
  /** Toggle the file-tree drawer (Baum/Drawer tab). */
  onDrawer: () => void;
  /** Open the CommandPalette search (Suche tab). */
  onSearch: () => void;
  /** Create a new note (Neu + tab). */
  onNew: () => void;
  /** Open the Voice review-sheet (Voice tab). */
  onVoice: () => void;
  /** Reconcile with Forgejo via api.sync() (Sync tab). */
  onSync: () => void;
  /**
   * Editor save/sync lifecycle — drives the Sync tab's spinner + active dot.
   * Mirrors App.tsx's `sync` SyncState (same union NoteHeader consumes).
   */
  syncState?: SaveStatus;
  /** True while an explicit api.sync() reconcile is in flight. */
  syncing?: boolean;
  /** True while the drawer is open — highlights the Baum tab. */
  drawerOpen?: boolean;
}

const BAR_STYLE: CSSProperties = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 45,
  display: "flex",
  alignItems: "stretch",
  justifyContent: "space-around",
  background: C.panel,
  borderTop: `1px solid ${C.border}`,
  fontFamily: FONT.ui,
  // Safe-area-inset so the bar clears the home indicator / gesture nav.
  paddingBottom: "env(safe-area-inset-bottom, 0px)",
  // Subtle lift so the editor content reads as "behind" the bar.
  boxShadow: "0 -6px 18px rgba(0,0,0,0.35)",
};

const TAB_STYLE: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 2,
  minWidth: TOUCH_TARGET_MIN,
  minHeight: 56,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: C.textDim,
  fontFamily: FONT.ui,
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: "0.01em",
  padding: "6px 2px",
};

const LABEL_STYLE: CSSProperties = {
  lineHeight: 1.1,
};

/** The center "Neu" tab gets the accent treatment — it's the primary CTA. */
const NEW_ICON_WRAP: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 38,
  height: 38,
  borderRadius: 12,
  background: C.accent,
  color: "#1a1110",
};

interface TabProps {
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  ariaLabel: string;
}

function Tab({ label, active, onClick, disabled, children, ariaLabel }: TabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        ...TAB_STYLE,
        color: active ? C.accent : disabled ? C.textFaint : C.textDim,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
      <span style={LABEL_STYLE}>{label}</span>
    </button>
  );
}

export function BottomNav({
  onDrawer,
  onSearch,
  onNew,
  onVoice,
  onSync,
  syncState,
  syncing,
  drawerOpen,
}: BottomNavProps) {
  const syncInFlight = syncing === true || syncState === "saving";
  // The Sync tab "glows" when there is something worth reconciling (dirty /
  // error / conflict) so the user knows to tap it; a clean synced state is
  // calm. We never disable it (pull-only is always meaningful), just recolor.
  const syncActive =
    syncState === "dirty" ||
    syncState === "error" ||
    syncState === "conflict";

  return (
    <nav aria-label="Mobile-Navigation" style={BAR_STYLE}>
      <Tab
        label="Baum"
        ariaLabel="Datei-Baum öffnen"
        active={drawerOpen}
        onClick={onDrawer}
      >
        <PanelLeft size={22} />
      </Tab>
      <Tab label="Suche" ariaLabel="Suche öffnen" onClick={onSearch}>
        <SearchIcon size={22} />
      </Tab>
      <Tab label="Neu" ariaLabel="Neue Notiz" onClick={onNew}>
        <span style={NEW_ICON_WRAP}>
          <Plus size={22} />
        </span>
      </Tab>
      <Tab label="Voice" ariaLabel="Sprachaufnahme öffnen" onClick={onVoice}>
        <Mic size={22} />
      </Tab>
      <Tab
        label="Sync"
        ariaLabel="Mit Forgejo abgleichen"
        active={syncActive}
        disabled={syncInFlight}
        onClick={onSync}
      >
        {syncInFlight ? (
          <Loader2
            size={22}
            style={{ animation: "lokyy-spin 0.9s linear infinite" }}
          />
        ) : (
          <RefreshCw size={22} />
        )}
      </Tab>
    </nav>
  );
}

export default BottomNav;
