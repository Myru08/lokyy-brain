import { X } from "lucide-react";
import { C, FONT } from "./theme.js";

export interface TabRef {
  id: string;
  title: string;
}

/**
 * Browser-style Tab-Strip über dem Editor. Multi-Note open + quick switch.
 * Cmd/Ctrl+W close ist im App.tsx als globaler hotkey hinterlegt.
 */
export function Tabs({
  tabs,
  activeId,
  onActivate,
  onClose,
}: {
  tabs: TabRef[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        padding: "6px 8px 0 8px",
        background: C.bg,
        borderBottom: `1px solid ${C.border}`,
        overflowX: "auto",
        flexShrink: 0,
      }}
    >
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        return (
          <div
            key={t.id}
            onClick={() => onActivate(t.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 12px",
              maxWidth: 240,
              background: isActive ? C.panel : "transparent",
              borderRadius: "6px 6px 0 0",
              borderTop: `1px solid ${isActive ? C.accent : "transparent"}`,
              borderLeft: `1px solid ${isActive ? C.border : "transparent"}`,
              borderRight: `1px solid ${isActive ? C.border : "transparent"}`,
              cursor: "pointer",
              color: isActive ? C.text : C.textDim,
              fontSize: 12,
              fontFamily: FONT.ui,
              whiteSpace: "nowrap",
              overflow: "hidden",
              flexShrink: 0,
            }}
            title={t.id}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                fontWeight: isActive ? 600 : 400,
              }}
            >
              {t.title || t.id}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
              title="Schließen (⌘W)"
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: C.textFaint,
                padding: 0,
                display: "flex",
                alignItems: "center",
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
