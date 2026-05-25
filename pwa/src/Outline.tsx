import { useMemo } from "react";
import { C, FONT } from "./theme.js";

interface Heading {
  level: number; // 1..6
  text: string;
  line: number; // 0-based
}

function parseHeadings(body: string): Heading[] {
  const out: Heading[] = [];
  const lines = body.split("\n");
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const m = /^(#{1,6})\s+(.+)$/.exec(l);
    if (m) {
      out.push({ level: m[1].length, text: m[2].trim(), line: i });
    }
  }
  return out;
}

/**
 * Outline-Sidebar — H1/H2/H3-Navigation rechts. Klick scrollt im Editor
 * zur Zeile. Reagiert auf body-Änderungen (re-parse).
 */
export function Outline({
  body,
  onJump,
}: {
  body: string;
  onJump: (line: number) => void;
}) {
  const headings = useMemo(() => parseHeadings(body), [body]);
  if (headings.length === 0) return null;

  return (
    <aside
      style={{
        flex: 1,
        background: C.bg,
        padding: "16px 12px",
        overflow: "auto",
        fontFamily: FONT.ui,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: 1.2,
          color: C.textDim,
          textTransform: "uppercase",
          marginBottom: 10,
          fontFamily: FONT.mono,
        }}
      >
        Outline
      </div>
      {headings.map((h, i) => (
        <button
          key={`${i}-${h.line}`}
          onClick={() => onJump(h.line)}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            background: "transparent",
            border: "none",
            padding: "3px 0 3px " + (h.level - 1) * 10 + "px",
            cursor: "pointer",
            color: h.level === 1 ? C.text : h.level === 2 ? C.textDim : C.textFaint,
            fontSize: h.level === 1 ? 13 : 12,
            fontFamily: h.level === 1 ? FONT.serif : FONT.ui,
            fontWeight: h.level === 1 ? 600 : 400,
            lineHeight: 1.4,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={h.text}
        >
          {h.text}
        </button>
      ))}
    </aside>
  );
}
