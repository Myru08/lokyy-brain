import { Fragment } from "react";
import { C, FONT } from "../theme.js";
import { parseHighlight, tokenizeInline } from "./changelogMarkdown.js";

/**
 * Renders the changelog excerpt that `GET /api/system/version` delivers as RAW
 * markdown. Sub-headings become small captions, bullets become a list, and
 * `**`/`*`/`` ` `` become real emphasis — never literal characters on screen.
 */

function Inline({ text }: { text: string }) {
  return (
    <>
      {tokenizeInline(text).map((token, i) => {
        const key = `${i}-${token.type}`;
        if (token.type === "strong") {
          return (
            <strong key={key} style={{ color: C.text, fontWeight: 600 }}>
              {token.value}
            </strong>
          );
        }
        if (token.type === "em") {
          return (
            <em key={key} style={{ fontStyle: "italic" }}>
              {token.value}
            </em>
          );
        }
        if (token.type === "code") {
          return (
            <code
              key={key}
              style={{
                fontFamily: FONT.mono,
                fontSize: "0.92em",
                background: C.elevated,
                borderRadius: 4,
                padding: "1px 4px",
              }}
            >
              {token.value}
            </code>
          );
        }
        return <Fragment key={key}>{token.value}</Fragment>;
      })}
    </>
  );
}

export function Highlights({
  items,
  limit,
}: {
  items: string[];
  /** Show at most this many raw lines. Omit for all of them. */
  limit?: number;
}) {
  const shown = typeof limit === "number" ? items.slice(0, limit) : items;
  if (shown.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {shown.map((raw, i) => {
        const { kind, text } = parseHighlight(raw);
        if (text === "") return null;
        if (kind === "heading") {
          return (
            <div
              key={i}
              style={{
                color: C.gold,
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                marginTop: i === 0 ? 0 : 6,
              }}
            >
              <Inline text={text} />
            </div>
          );
        }
        return (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 6,
              color: C.textDim,
              fontSize: 13,
              lineHeight: 1.45,
            }}
          >
            <span aria-hidden style={{ color: C.accent, flexShrink: 0 }}>
              ·
            </span>
            <span>
              <Inline text={text} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
