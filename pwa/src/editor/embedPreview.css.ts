import { EditorView } from "@codemirror/view";

/**
 * Embed-Card-Styles für `![[Note]]`-Embeds.
 *
 * Liegt bewusst neben `embedPreview.ts` und NICHT in `theme.ts`, damit das
 * Embed-Feature komplett isoliert ein-/ausgehängt werden kann. Farben sind
 * mit dem Live-Preview-Theme abgestimmt (Bright-Orange + Anthrazit).
 */
export const embedTheme = EditorView.theme({
  ".cm-embed-card": {
    border: "1px solid #2A323D",
    borderRadius: "6px",
    padding: "12px 16px",
    margin: "8px 0",
    background: "#1A1F26",
    cursor: "default",
  },
  ".cm-embed-title": {
    fontWeight: "600",
    color: "#F97316",
    marginBottom: "6px",
    cursor: "pointer",
  },
  ".cm-embed-title:hover": {
    color: "#FB923C",
  },
  ".cm-embed-body": {
    color: "#8B9099",
    fontSize: "0.92em",
    lineHeight: "1.55",
  },
});
