/**
 * Brand-Theme der PWA. Cool-Dunkel (Anthrazit) + helles Orange — passt zum
 * neuen Logo (Anthrazit-Hintergrund + Bright-Orange "Brain"-Wordmark).
 * Zentral, damit App-Shell, Datei-Baum und Import-Panel nicht
 * auseinanderlaufen. Spätere Brand-Themes ändern nur diese Datei.
 *
 * Mapping (alt → neu):
 *   #14110f → #13171D   bg
 *   #1c1815 → #1A1F26   panel
 *   #231e1a → #222831   elevated
 *   #322b25 → #2A323D   border (default)
 *   #3a261c → #2A323D   accentDim → renamed to selection-rgba; old usages map here
 *   #5f574e → #5A6270   text dim
 *   #9a8f84 → #8B9099   text muted
 *   #ece6df → #FFFFFF   text
 *   #d2693f → #F97316   accent (orange)
 *   #e8814f → #FB923C   accentHi (hover orange)
 *   #c9a25e → #FFA94D   gold → secondary orange
 *   #e0b576 → #FFC588   gold-hi
 */
export const C = {
  bg: "#13171D",
  panel: "#1A1F26",
  elevated: "#222831",
  hover: "#2A323D",
  border: "#2A323D",
  borderSoft: "#222831",
  borderStrong: "#3B4452",
  text: "#FFFFFF",
  textDim: "#8B9099",
  textFaint: "#5A6270",
  accent: "#F97316",
  accentHi: "#FB923C",
  accentDim: "#C2410C",
  /** Soft selection / active background — semi-transparent accent. */
  selection: "rgba(249,115,22,0.20)",
  /** Even softer hover surface — used for hovered rows / soft fills. */
  accentSoft: "rgba(249,115,22,0.08)",
  gold: "#FFA94D",
  goldHi: "#FFC588",
  ok: "#7fa37a",
  err: "#EF4444",
} as const;

export const FONT = {
  ui: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "'Fraunces', Georgia, serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;
