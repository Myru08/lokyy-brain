import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

/**
 * Slash-Commands — `/` am Zeilen-Anfang öffnet eine Befehl-Palette.
 * Auswahl ersetzt den `/<query>` und fügt das Template ein.
 *
 * Verfügbare Commands:
 *   /h1 /h2 /h3 /h4   Heading
 *   /todo            Todo-Listenpunkt
 *   /code            Code-Fence
 *   /callout         Blockquote-Callout
 *   /wikilink        [[Wikilink]] mit Cursor in den Klammern
 *   /table           Markdown-Tabelle (3x3)
 *   /divider         Horizontale Linie
 *   /tag             #tag mit Cursor dahinter
 *   /now             Aktueller ISO-Timestamp
 *
 * Nutzt CodeMirror's built-in autocompletion engine — `/` triggert,
 * pfeil + enter wählt, esc bricht ab. Sieht aus wie Notion's slash menu.
 */

interface SlashCommand {
  label: string;
  desc: string;
  /** Was eingefügt wird. `|` markiert die finale Cursor-Position. */
  insert: () => string;
}

const COMMANDS: SlashCommand[] = [
  { label: "h1", desc: "Heading 1", insert: () => "# |" },
  { label: "h2", desc: "Heading 2", insert: () => "## |" },
  { label: "h3", desc: "Heading 3", insert: () => "### |" },
  { label: "h4", desc: "Heading 4", insert: () => "#### |" },
  { label: "todo", desc: "Todo-Listpunkt", insert: () => "- [ ] |" },
  { label: "list", desc: "Aufzählung", insert: () => "- |" },
  { label: "ordered", desc: "Nummerierte Liste", insert: () => "1. |" },
  {
    label: "code",
    desc: "Code-Block",
    insert: () => "```\n|\n```",
  },
  {
    label: "ts",
    desc: "TypeScript-Block",
    insert: () => "```ts\n|\n```",
  },
  {
    label: "callout",
    desc: "Blockquote / Callout",
    insert: () => "> |",
  },
  { label: "wikilink", desc: "[[Wikilink]]", insert: () => "[[|]]" },
  { label: "embed", desc: "Embedded Note ![[...]]", insert: () => "![[|]]" },
  {
    label: "table",
    desc: "Markdown-Tabelle 3x3",
    insert: () =>
      "| | | |\n|---|---|---|\n| | | |\n| | | |",
  },
  { label: "divider", desc: "Horizontale Linie", insert: () => "---" },
  { label: "tag", desc: "#tag", insert: () => "#|" },
  {
    label: "now",
    desc: "Aktueller ISO-Timestamp",
    insert: () => new Date().toISOString(),
  },
];

function buildOptions(): Completion[] {
  return COMMANDS.map((cmd) => ({
    label: `/${cmd.label}`,
    detail: cmd.desc,
    apply: (view, _completion, from, to) => {
      const text = cmd.insert();
      const cursorMarker = text.indexOf("|");
      const insert = cursorMarker >= 0 ? text.replace("|", "") : text;
      const cursorPos = cursorMarker >= 0 ? from + cursorMarker : from + insert.length;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: cursorPos },
      });
    },
  }));
}

function slashSource(ctx: CompletionContext): CompletionResult | null {
  // Trigger nur, wenn der `/` am Zeilen-Anfang oder nach Whitespace steht.
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const match = /(^|\s)(\/[a-zA-Z0-9]*)$/.exec(before);
  if (!match) return null;
  const tokenStart = ctx.pos - match[2].length;
  return {
    from: tokenStart,
    options: buildOptions(),
    validFor: /^\/[a-zA-Z0-9]*$/,
  };
}

/** Exported so Editor.tsx can combine with other sources (wikilink etc.). */
export { slashSource };
