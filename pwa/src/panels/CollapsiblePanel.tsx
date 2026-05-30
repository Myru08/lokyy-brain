import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { C, FONT } from "../theme.js";

/**
 * CollapsiblePanel — einheitliches Aufklapp-Fähnchen-Pattern (Story 11.9).
 *
 * Umhüllt ein bestehendes Panel (TagPane / Outline / BacklinksPanel) UNVERÄNDERT.
 * Standardmäßig geschlossen: dann erscheint nur ein schmales Fähnchen an der
 * `side`-Kante. Klick öffnet das Panel auf voller, scroll-/suchbarer Fläche;
 * erneuter Klick schließt wieder.
 *
 *   <CollapsiblePanel id="outline" title="Gliederung" side="right">
 *     <Outline … />
 *   </CollapsiblePanel>
 *
 * Open/zu-State lebt pro Panel in localStorage (`lokyy:panel:<id>`, "1"/"0") —
 * NICHT im Vault, kein Forgejo-Commit pro Toggle (K-2). Gleiches try/catch-Muster
 * wie `useResizableWidth` (Resizable.tsx).
 */
export function CollapsiblePanel(props: {
  /** localStorage-Key-Suffix: "lokyy:panel:<id>" */
  id: string;
  title: string;
  /** lucide icon, optional */
  icon?: ReactNode;
  /** bestimmt, an welcher Kante das Fähnchen sitzt */
  side: "left" | "right";
  /** Default false ("alle Panels default geschlossen") */
  defaultOpen?: boolean;
  /** das bestehende Panel (TagPane/Outline/BacklinksPanel) UNVERÄNDERT */
  children: ReactNode;
}): JSX.Element {
  const { id, title, icon, side, defaultOpen = false, children } = props;

  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(`lokyy:panel:${id}`);
      if (raw === "1") return true;
      if (raw === "0") return false;
    } catch {}
    return defaultOpen;
  });

  useEffect(() => {
    try {
      localStorage.setItem(`lokyy:panel:${id}`, open ? "1" : "0");
    } catch {}
  }, [id, open]);

  // Geschlossen → schmales Fähnchen an der side-Kante.
  if (!open) {
    const OpenChevron = side === "left" ? ChevronRight : ChevronLeft;
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${title} öffnen`}
        aria-label={`${title} öffnen`}
        aria-expanded={false}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
          width: 32,
          height: "100%",
          padding: "12px 0",
          border: "none",
          [side === "left" ? "borderRight" : "borderLeft"]:
            `1px solid ${C.border}`,
          background: C.panel,
          color: C.textDim,
          cursor: "pointer",
          font: `500 11px ${FONT.ui}`,
          transition: "color 120ms, background 120ms",
        }}
        onMouseEnter={(e) => {
          const el = e.currentTarget;
          el.style.color = C.accent;
          el.style.background = C.elevated;
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget;
          el.style.color = C.textDim;
          el.style.background = C.panel;
        }}
      >
        <OpenChevron size={16} />
        {icon != null && (
          <span style={{ display: "flex", lineHeight: 0 }}>{icon}</span>
        )}
        <span
          style={{
            writingMode: "vertical-rl",
            textOrientation: "mixed",
            // links sitzt das Fähnchen, Text soll von oben nach unten lesbar sein
            transform: side === "left" ? "rotate(180deg)" : undefined,
            letterSpacing: "0.04em",
            whiteSpace: "nowrap",
            textTransform: "uppercase",
          }}
        >
          {title}
        </span>
      </button>
    );
  }

  // Offen → volle, scroll-/suchbare Fläche; Header mit Schließen-Knopf.
  const CloseChevron = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <section
      aria-label={title}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        flexShrink: 0,
        background: C.panel,
        [side === "left" ? "borderRight" : "borderLeft"]:
          `1px solid ${C.border}`,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
          padding: "8px 10px",
          borderBottom: `1px solid ${C.borderSoft}`,
          color: C.text,
          font: `600 12px ${FONT.ui}`,
          letterSpacing: "0.02em",
          textTransform: "uppercase",
        }}
      >
        {icon != null && (
          <span style={{ display: "flex", lineHeight: 0, color: C.textDim }}>
            {icon}
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0 }}>{title}</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          title={`${title} schließen`}
          aria-label={`${title} schließen`}
          aria-expanded={true}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            padding: 0,
            border: "none",
            borderRadius: 4,
            background: "transparent",
            color: C.textDim,
            cursor: "pointer",
            transition: "color 120ms, background 120ms",
          }}
          onMouseEnter={(e) => {
            const el = e.currentTarget;
            el.style.color = C.accent;
            el.style.background = C.elevated;
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget;
            el.style.color = C.textDim;
            el.style.background = "transparent";
          }}
        >
          <CloseChevron size={16} />
        </button>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>{children}</div>
    </section>
  );
}
