import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Editor-Theme. Cool-Dunkel (Anthrazit) + Bright-Orange — passt zum neuen
 * Brand-Logo. Die Body-Schrift bleibt bewusst Fraunces (Long-Form-Lesetext);
 * die UI-Chrome läuft mit Inter (siehe `pwa/src/theme.ts`).
 *
 * Die `.cm-h1` / `.cm-strong` / `.cm-wikilink` / `.cm-tag`-Klassen werden
 * von den Live-Preview- und Wikilink-Extensions gesetzt.
 */
export const lokyyTheme = EditorView.theme(
  {
    "&": {
      color: "#FFFFFF",
      backgroundColor: "#13171D",
      fontSize: "15.5px",
      height: "100%",
    },
    ".cm-scroller": { overflow: "auto" },
    ".cm-content": {
      fontFamily: "'Fraunces', Georgia, serif",
      padding: "32px 0",
      maxWidth: "640px",
      margin: "0 auto",
      caretColor: "#F97316",
      lineHeight: "1.85",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#F97316" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { backgroundColor: "rgba(249,115,22,0.20)" },
    ".cm-line": { padding: "0 6px" },
    ".cm-activeLine": { backgroundColor: "rgba(249,115,22,0.06)" },
    ".cm-gutters": { display: "none" },

    /* --- Live-Preview-Klassen --- */
    ".cm-h1": { fontSize: "1.75em", fontWeight: "600", lineHeight: "1.5" },
    ".cm-h2": { fontSize: "1.35em", fontWeight: "600", lineHeight: "1.6" },
    ".cm-h3": { fontSize: "1.15em", fontWeight: "600" },
    ".cm-strong": { fontWeight: "600", color: "#FFFFFF" },
    ".cm-em": { fontStyle: "italic" },
    ".cm-inline-code": {
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: "0.85em",
      background: "#1A1F26",
      border: "1px solid #2A323D",
      borderRadius: "4px",
      padding: "0.5px 5px",
      color: "#FFA94D",
    },
    ".cm-wikilink": {
      color: "#F97316",
      cursor: "pointer",
      borderBottom: "1px solid #3B4452",
    },
    ".cm-wikilink:hover": { color: "#FB923C" },
    ".cm-wikilink-unresolved": {
      color: "#FFA94D",
      cursor: "pointer",
      borderBottom: "1px dashed #5A6270",
      opacity: 0.85,
    },
    ".cm-wikilink-unresolved:hover": { color: "#FFC588" },
    ".cm-tag": {
      color: "#FFA94D",
      background: "rgba(255,169,77,0.08)",
      border: "1px solid rgba(255,169,77,0.25)",
      borderRadius: "5px",
      padding: "0 5px",
    },
  },
  { dark: true },
);

/** Syntax-Highlighting für den rohen Markdown (Marker, Links, Quotes …). */
export const lokyyHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.heading, color: "#FFFFFF", fontWeight: "600" },
    { tag: t.link, color: "#F97316" },
    { tag: t.url, color: "#5A6270" },
    { tag: t.quote, color: "#8B9099", fontStyle: "italic" },
    { tag: t.list, color: "#F97316" },
    { tag: t.monospace, color: "#FFA94D" },
    // Markdown-Marker (#, **, -) dezent, solange sie sichtbar sind
    { tag: t.processingInstruction, color: "#5A6270" },
  ]),
);
