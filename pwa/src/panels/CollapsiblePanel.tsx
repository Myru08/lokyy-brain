import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from "lucide-react";
import { C, FONT } from "../theme.js";

/** An welcher Kante das Fähnchen sitzt. */
export type PanelSide = "left" | "right" | "bottom" | "top";

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
  /**
   * Bestimmt, an welcher Kante das Fähnchen sitzt und in welche Richtung das
   * Panel aufklappt:
   *   "left"/"right"   → vertikales Fähnchen an der Seitenkante, klappt zur
   *                      Seite auf (volle Höhe).
   *   "bottom"         → horizontales Fähnchen UNTEN, klappt nach OBEN auf
   *                      (volle Breite, scroll-/suchbare Fläche).
   *   "top"            → horizontales Fähnchen OBEN, klappt nach UNTEN auf.
   */
  side: PanelSide;
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

  // Orientierung: bottom/top sind horizontal (Fähnchen quer, klappt vertikal
  // auf), left/right sind vertikal (Fähnchen hochkant, klappt seitlich auf).
  const horizontal = side === "bottom" || side === "top";

  // Geschlossen → schmales Fähnchen an der side-Kante.
  if (!open) {
    // Pfeil zeigt in die Aufklapp-Richtung: bottom → nach oben, top → nach
    // unten, left → nach rechts, right → nach links.
    const OpenChevron =
      side === "bottom"
        ? ChevronUp
        : side === "top"
          ? ChevronDown
          : side === "left"
            ? ChevronRight
            : ChevronLeft;
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${title} öffnen`}
        aria-label={`${title} öffnen`}
        aria-expanded={false}
        style={
          horizontal
            ? {
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                flexShrink: 0,
                width: "100%",
                height: 32,
                padding: "0 12px",
                border: "none",
                [side === "bottom" ? "borderTop" : "borderBottom"]:
                  `1px solid ${C.border}`,
                background: C.panel,
                color: C.textDim,
                cursor: "pointer",
                font: `500 11px ${FONT.ui}`,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                transition: "color 120ms, background 120ms",
              }
            : {
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
              }
        }
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
          style={
            horizontal
              ? {
                  letterSpacing: "0.04em",
                  whiteSpace: "nowrap",
                  textTransform: "uppercase",
                }
              : {
                  writingMode: "vertical-rl",
                  textOrientation: "mixed",
                  // links sitzt das Fähnchen, Text von oben nach unten lesbar
                  transform: side === "left" ? "rotate(180deg)" : undefined,
                  letterSpacing: "0.04em",
                  whiteSpace: "nowrap",
                  textTransform: "uppercase",
                }
          }
        >
          {title}
        </span>
      </button>
    );
  }

  // Offen → volle, scroll-/suchbare Fläche; Header mit Schließen-Knopf.
  // Schließen-Pfeil zeigt zurück zur Kante: bottom → nach unten, top → nach
  // oben, left → nach links, right → nach rechts.
  const CloseChevron =
    side === "bottom"
      ? ChevronDown
      : side === "top"
        ? ChevronUp
        : side === "left"
          ? ChevronLeft
          : ChevronRight;

  // Für side="bottom" sitzt der Header (mit Schließen) UNTEN an der Fähnchen-
  // Kante, der scrollbare Inhalt darüber — das Panel klappt also nach OBEN auf.
  // Für side="top" sitzt der Header oben. left/right behalten den Header oben.
  const headerAtBottom = side === "bottom";

  const sectionBorderStyle: React.CSSProperties =
    side === "bottom"
      ? { borderTop: `1px solid ${C.border}` }
      : side === "top"
        ? { borderBottom: `1px solid ${C.border}` }
        : side === "left"
          ? { borderRight: `1px solid ${C.border}` }
          : { borderLeft: `1px solid ${C.border}` };

  const header = (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
        padding: "8px 10px",
        [headerAtBottom ? "borderTop" : "borderBottom"]:
          `1px solid ${C.borderSoft}`,
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
  );

  const body = (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>{children}</div>
  );

  return (
    <section
      aria-label={title}
      style={{
        display: "flex",
        flexDirection: "column",
        // bottom/top füllen die Breite ihres Containers; left/right die Höhe.
        ...(horizontal
          ? { width: "100%", maxHeight: "100%" }
          : { height: "100%" }),
        minHeight: 0,
        flexShrink: 0,
        background: C.panel,
        ...sectionBorderStyle,
      }}
    >
      {headerAtBottom ? (
        <>
          {body}
          {header}
        </>
      ) : (
        <>
          {header}
          {body}
        </>
      )}
    </section>
  );
}
