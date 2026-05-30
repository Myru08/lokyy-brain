import { Fragment, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import { C, FONT } from "./theme.js";

/**
 * Properties Panel — Obsidian-style frontmatter editor.
 *
 * Sits above the editor body and lets the user see+edit YAML frontmatter
 * as structured fields. Client-side only: parses on every render from
 * `body`, serializes on every change and reports the new body back via
 * `onUpdateBody`. The body content (everything after the closing `---`)
 * is preserved byte-for-byte — only the frontmatter block is rewritten.
 *
 * ---------------------------------------------------------------------
 * Limitations of the inline YAML parser (intentional — not full YAML):
 *
 *   Supports only the subset lokyy-vault frontmatter uses today:
 *     key: <string>              → string
 *     key: [a, b, c]             → string[]   (quotes optional, trimmed)
 *     key: true | false          → boolean
 *     ISO dates                  → kept as strings (caller treats as ISO)
 *
 *   NOT supported (will round-trip as raw strings or be dropped):
 *     - block scalars (`|`, `>`)
 *     - nested mappings / multi-line indented structures
 *     - anchors, aliases, tags (`!!str`)
 *     - inline mappings (`{foo: bar}`)
 *
 *   The server-side authority for frontmatter validity is the vault
 *   pre-commit hook + `@lokyy/core` (gray-matter + ajv). This panel is
 *   strictly for ergonomic editing of common keys; anything exotic
 *   should be edited in the raw markdown source.
 * ---------------------------------------------------------------------
 */

export interface PropertiesPanelProps {
  /** Full markdown including frontmatter. */
  body: string;
  /** Called with the new full markdown when any property changes. */
  onUpdateBody: (newBody: string) => void;
  /** Whether the panel is expanded (shows fields). */
  expanded: boolean;
  /** Toggle handler — clicking the header invokes this. */
  onToggle: () => void;
}

type ScalarValue = string | boolean;
type FieldValue = ScalarValue | string[];

interface ParsedFrontmatter {
  /** Ordered keys, preserves source order. */
  keys: string[];
  /** Map of key → typed value. */
  values: Record<string, FieldValue>;
  /** Byte-exact source body (everything after closing `---\n`). */
  bodyAfter: string;
  /** True if a frontmatter block was found. */
  found: boolean;
}

/** Must match DOC_TYPES in @lokyy/core. */
const DOC_TYPE_OPTIONS = [
  "note",
  "capture",
  "project",
  "task",
  "decision",
  "meeting",
  "customer",
  "workflow",
  "intervention",
  "content",
  "peer",
] as const;

/**
 * Phase C Wave C2 / Story 3 — peer-specific frontmatter keys we render in
 * a dedicated section when `type === "peer"`. These keys are filtered OUT
 * of the standard field grid (so they don't render twice) and surfaced
 * with peer-specific widgets (slider, chip-list, entity-link).
 *
 * `relationship_strength` is shown read-only as an agent-computed slider;
 * the value comes from the sleep-pass. The user CAN edit it in raw .md
 * (frontmatter wins), but the panel doesn't expose that as a quick action
 * because the agent overwrites it every sleep cycle UNLESS the user
 * supplied an explicit override.
 */
const PEER_EXTRA_KEYS = new Set([
  "peer_type",
  "relationship_strength",
  "ongoing_topics",
  "traits",
  "last_interaction",
  "first_met",
  "interaction_count",
  "linked_entity_id",
  "communication_history_summary",
  "contact",
]);

const READ_ONLY_KEYS = new Set(["id", "created", "updated"]);

/**
 * Core frontmatter keys that are part of the SPEC contract and therefore
 * NOT removable from the panel. `id`/`created` are immutable (and read-only
 * via READ_ONLY_KEYS); `type`/`title`/`updated` are editable elsewhere but
 * must never be deleted. `privacy` has its own dedicated row. Any key NOT in
 * this set is treated as an optional / custom field and gets a remove icon.
 */
const CORE_KEYS = new Set([
  "id",
  "created",
  "updated",
  "type",
  "title",
  "privacy",
]);

/**
 * Schema-known optional fields per doc type, derived from the JSON schemas
 * in `packages/core/src/frontmatter/schemas/*.json` (every doc allows
 * `additionalProperties: true`, so these are the *suggested* — not the only
 * — extra keys). `tags` is universal. The "+ Property" menu offers these
 * first, then a free custom key/value form. Kept in sync manually because
 * the PWA is a browser bundle and `@lokyy/core` ships node-only code.
 */
const TYPE_OPTIONAL_FIELDS: Record<string, string[]> = {
  note: ["tags", "status"],
  capture: ["tags", "source", "url", "status"],
  project: ["tags", "status"],
  task: ["tags", "status", "due"],
  decision: ["tags", "status"],
  meeting: ["tags", "date", "attendees", "status"],
  customer: ["tags", "email", "company", "status"],
  workflow: ["tags", "status"],
  intervention: [
    "tags",
    "status",
    "intervention_kind",
    "target_note_id",
    "confidence",
  ],
  content: ["tags", "status"],
  peer: ["tags", "status"],
};

/** Universal fallback when the doc type is unknown / unset. */
const FALLBACK_OPTIONAL_FIELDS = ["tags", "status"];

/**
 * Editor hint per known optional field, so a freshly-added field gets a
 * sensible initial value + the right widget. Arrays → ChipInput; everything
 * else → text input. Keys not listed default to an empty string.
 */
const ARRAY_VALUED_FIELDS = new Set(["tags", "attendees"]);

/**
 * Keys whose top-level entry is hidden from the field grid because we
 * render them in a dedicated section (privacy row, encoded-context
 * details panel). Without this, the panel would show `encoded:` as a
 * lonely string field with no usable value (the inline YAML parser does
 * not descend into nested mappings).
 */
const HIDDEN_TOPLEVEL_KEYS = new Set(["encoded"]);

/** Field labels for the read-only encoded-context section. */
const ENCODED_FIELD_LABELS: Record<string, string> = {
  device: "Device",
  app_state: "App state",
  time_of_day: "Time of day",
  weekday: "Weekday",
  preceding_notes: "Preceding notes",
  session_duration_min: "Session (min)",
  word_count_session: "Words in session",
  source: "Source",
};

/**
 * Valid privacy tier values. Must mirror `NotePrivacy` in `@lokyy/core`.
 * `"default"` = follow the user's global privacyTier setting.
 * `"local-only"` = hard-force a local LLM provider for any AI op against
 * this note, even if the global setting says cloud is fine.
 */
const PRIVACY_OPTIONS = ["default", "local-only"] as const;
type PrivacyValue = (typeof PRIVACY_OPTIONS)[number];

/** Key the Privacy row renders for. Universal across all doc types. */
const PRIVACY_KEY = "privacy";

// ─── Parser ──────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineArray(raw: string): string[] {
  // Strip surrounding [ ] then split on commas (no nesting supported).
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => stripQuotes(part.trim())).filter((s) => s.length > 0);
}

function parseValue(raw: string): FieldValue {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t.startsWith("[") && t.endsWith("]")) return parseInlineArray(t);
  return stripQuotes(t);
}

function parseFrontmatter(source: string): ParsedFrontmatter {
  const m = FRONTMATTER_RE.exec(source);
  if (!m) {
    return { keys: [], values: {}, bodyAfter: source, found: false };
  }
  const block = m[1] ?? "";
  const bodyAfter = source.slice(m[0].length);
  const keys: string[] = [];
  const values: Record<string, FieldValue> = {};
  for (const lineRaw of block.split(/\r?\n/)) {
    const line = lineRaw;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // Match `key: rest` — only top-level keys (no indentation).
    const km = /^([A-Za-z_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1] as string;
    const rest = km[2] as string;
    if (key in values) continue; // duplicate keys: first wins (parser quirk, documented above).
    keys.push(key);
    values[key] = parseValue(rest);
  }
  return { keys, values, bodyAfter, found: true };
}

// ─── Encoded-context sub-block parser ─────────────────────────────────────
//
// The frontmatter parser above is intentionally flat-only (top-level keys
// with scalar / inline-array values). For the Tulving-style `encoded:` block
// we want to *display* the nested fields read-only without buying into a
// real YAML lib. So we scan the raw frontmatter block, find the `encoded:`
// line, and pick up the indented children until the next non-indented key.
//
// Format we accept:
//   encoded:
//     device: laptop
//     time_of_day: evening
//     preceding_notes: [a, b]
//     source: { kind: "youtube" }     ← rendered as raw string
//
// Anything we can't parse cleanly falls back to a raw string for that
// sub-field; nothing in this read-only path is allowed to throw.
type EncodedField = string | string[];
interface EncodedSnapshot {
  fields: Array<{ key: string; value: EncodedField }>;
}

function parseEncodedSubBlock(source: string): EncodedSnapshot | null {
  const m = FRONTMATTER_RE.exec(source);
  if (!m) return null;
  const block = m[1] ?? "";
  const lines = block.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^encoded\s*:\s*$/.test(l));
  if (idx < 0) return null;

  const out: EncodedSnapshot = { fields: [] };
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Stop at the first non-indented (or empty) line — that's the next
    // top-level key.
    if (line.trim() === "") continue;
    if (!/^\s+/.test(line)) break;

    const km = /^\s+([A-Za-z_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1] as string;
    const rest = (km[2] as string).trim();
    if (rest === "") {
      // Nested object (e.g. `source:` followed by deeper indent). Render
      // as a placeholder — the read-only UI just shows "(nested)".
      out.fields.push({ key, value: "(nested)" });
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      out.fields.push({ key, value: parseInlineArray(rest) });
      continue;
    }
    out.fields.push({ key, value: stripQuotes(rest) });
  }
  return out.fields.length > 0 ? out : null;
}

// ─── Serializer ──────────────────────────────────────────────────────────

/** Heuristic: quote strings that contain YAML-special chars or look ambiguous. */
function needsQuoting(s: string): boolean {
  if (s === "") return true;
  if (s === "true" || s === "false" || s === "null") return true;
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return true; // numeric-looking
  if (/[:#\[\]{},&*!|>'"%@`]/.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;
  return false;
}

function serializeScalar(v: ScalarValue): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (needsQuoting(v)) return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return v;
}

function serializeArray(arr: string[]): string {
  if (arr.length === 0) return "[]";
  return `[${arr.map((s) => serializeScalar(s)).join(", ")}]`;
}

function serializeFrontmatter(
  keys: string[],
  values: Record<string, FieldValue>,
  bodyAfter: string,
): string {
  const lines: string[] = ["---"];
  for (const k of keys) {
    const v = values[k];
    if (Array.isArray(v)) {
      lines.push(`${k}: ${serializeArray(v)}`);
    } else if (typeof v === "boolean") {
      lines.push(`${k}: ${v ? "true" : "false"}`);
    } else {
      lines.push(`${k}: ${serializeScalar(v)}`);
    }
  }
  lines.push("---");
  // Re-attach body with a single newline separator, matching the parser's
  // expectation. If bodyAfter already begins with a newline, no extra one.
  const sep = bodyAfter.startsWith("\n") ? "" : "\n";
  return lines.join("\n") + "\n" + sep + bodyAfter;
}

// ─── Styles ──────────────────────────────────────────────────────────────

const PANEL_STYLE: CSSProperties = {
  background: "#1A1F26",
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: "12px 16px",
  marginBottom: 12,
  fontFamily: FONT.ui,
  color: C.text,
  fontSize: 14,
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
  userSelect: "none",
  color: C.textDim,
  fontSize: 13,
  fontWeight: 500,
};

const LABEL_STYLE: CSSProperties = {
  color: C.textDim,
  textTransform: "uppercase",
  fontSize: "0.75em",
  letterSpacing: "0.05em",
  alignSelf: "center",
};

const INPUT_BASE: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  padding: "4px 8px",
  color: C.text,
  fontFamily: FONT.ui,
  fontSize: 14,
  outline: "none",
  caretColor: "#F97316",
};

const READONLY_STYLE: CSSProperties = {
  ...INPUT_BASE,
  fontFamily: FONT.mono,
  color: C.textFaint,
  background: "rgba(255,255,255,0.02)",
  cursor: "default",
};

const CHIP_STYLE: CSSProperties = {
  background: "rgba(255,169,77,0.08)",
  border: "1px solid rgba(255,169,77,0.25)",
  borderRadius: 5,
  padding: "2px 8px",
  color: "#FFA94D",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 12,
};

const CHIP_CLOSE_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#FFA94D",
  cursor: "pointer",
  padding: 0,
  fontSize: 14,
  lineHeight: 1,
};

// ─── Add-property + remove-icon styles ────────────────────────────────────

const REMOVE_ICON_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  color: C.textDim,
  cursor: "pointer",
  fontSize: 16,
  lineHeight: 1,
  padding: "0 4px",
  flexShrink: 0,
};

const ADD_PROPERTY_WRAP_STYLE: CSSProperties = {
  marginTop: 12,
  paddingTop: 12,
  borderTop: `1px dashed ${C.border}`,
};

const ADD_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: `1px dashed ${C.border}`,
  borderRadius: 5,
  color: C.textDim,
  cursor: "pointer",
  fontFamily: FONT.ui,
  fontSize: 13,
  padding: "5px 10px",
};

const SUGGEST_CHIP_STYLE: CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  color: C.text,
  cursor: "pointer",
  fontFamily: FONT.ui,
  fontSize: 12,
  padding: "3px 9px",
};

// ─── Privacy-row styles ──────────────────────────────────────────────────

/**
 * The privacy row gets its own dedicated layout — full-width, single line,
 * label + select + optional badge. It sits at the very top of the expanded
 * panel because the privacy state is high-stakes (gates the LLM router).
 */
const PRIVACY_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  marginBottom: 12,
  borderRadius: 5,
  border: `1px solid ${C.border}`,
  background: "rgba(255,255,255,0.015)",
};

const PRIVACY_BADGE_STYLE: CSSProperties = {
  background: "rgba(249,115,22,0.15)",
  border: "1px solid rgba(249,115,22,0.45)",
  borderRadius: 4,
  padding: "2px 8px",
  color: "#F97316",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

const PRIVACY_SELECT_STYLE: CSSProperties = {
  ...INPUT_BASE,
  flex: 1,
  appearance: "none",
};

// ─── Subcomponents ───────────────────────────────────────────────────────

function FocusableInput(props: {
  value: string;
  onChange: (v: string) => void;
  type?: "text";
}) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      type={props.type ?? "text"}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        ...INPUT_BASE,
        borderColor: focused ? "#F97316" : C.border,
      }}
    />
  );
}

function ChipInput(props: {
  value: string[];
  onChange: (v: string[]) => void;
  /** If true, chips render in the tag colour scheme (gold accent). */
  asTags?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);

  function commit() {
    const next = draft.trim().replace(/^#/, "");
    if (next === "") return;
    if (props.value.includes(next)) {
      setDraft("");
      return;
    }
    props.onChange([...props.value, next]);
    setDraft("");
  }

  function removeAt(i: number) {
    const next = props.value.slice();
    next.splice(i, 1);
    props.onChange(next);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "" && props.value.length > 0) {
      removeAt(props.value.length - 1);
    }
  }

  return (
    <div
      style={{
        ...INPUT_BASE,
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        alignItems: "center",
        borderColor: focused ? "#F97316" : C.border,
        padding: "3px 6px",
        minHeight: 28,
      }}
    >
      {props.value.map((chip, i) => (
        <span key={`${chip}-${i}`} style={CHIP_STYLE}>
          {props.asTags ? `#${chip}` : chip}
          <button
            type="button"
            aria-label={`Remove ${chip}`}
            onClick={() => removeAt(i)}
            style={CHIP_CLOSE_STYLE}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => {
          setFocused(false);
          if (draft.trim() !== "") commit();
        }}
        onFocus={() => setFocused(true)}
        placeholder={props.value.length === 0 ? "add…" : ""}
        style={{
          flex: 1,
          minWidth: 60,
          background: "transparent",
          border: "none",
          outline: "none",
          color: C.text,
          fontFamily: FONT.ui,
          fontSize: 13,
          caretColor: "#F97316",
          padding: "2px 0",
        }}
      />
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────

export function PropertiesPanel({
  body,
  onUpdateBody,
  expanded,
  onToggle,
}: PropertiesPanelProps) {
  const parsed = useMemo(() => parseFrontmatter(body), [body]);

  if (!parsed.found) {
    return (
      <div style={PANEL_STYLE}>
        <p style={{ margin: 0, color: C.textDim, fontSize: 13 }}>
          This note has no frontmatter.
        </p>
      </div>
    );
  }

  // Resolve current privacy state. Tolerate missing key, unknown values
  // (legacy or hand-edited notes) — anything that isn't "local-only" is
  // treated as "default" for UI purposes; the underlying value is only
  // written when the user picks a non-default option.
  const rawPrivacy = parsed.values[PRIVACY_KEY];
  const currentPrivacy: PrivacyValue =
    rawPrivacy === "local-only" ? "local-only" : "default";
  const isLocalOnly = currentPrivacy === "local-only";

  // Phase C Wave C2 / Story 3 — Peer-specific extras get their own widget
  // section below, so we filter them out of the standard grid only when
  // this note is actually `type: peer`. For non-peer notes a stray
  // `peer_type:` field would still render as a normal text field (defensive).
  const docType = typeof parsed.values.type === "string" ? parsed.values.type : "";
  const isPeer = docType === "peer";

  // Count fields *excluding* privacy + hidden-top-level (encoded) — those
  // get dedicated rows above/below the grid and shouldn't double-count.
  // For peer notes also hide peer-specific keys (rendered in PeerSection).
  const visibleKeys = parsed.keys.filter(
    (k) =>
      k !== PRIVACY_KEY &&
      !HIDDEN_TOPLEVEL_KEYS.has(k) &&
      !(isPeer && PEER_EXTRA_KEYS.has(k)),
  );
  const fieldCount = visibleKeys.length;

  // Encoded-context (Tulving 1973) — captured at create-time, never
  // edited by the user. Parsed independently from the raw body because
  // the flat YAML parser above doesn't descend into nested mappings.
  const encodedSnapshot = useMemo(() => parseEncodedSubBlock(body), [body]);

  function update(key: string, next: FieldValue) {
    const newValues: Record<string, FieldValue> = { ...parsed.values, [key]: next };
    // Preserve key order; ensure `privacy` exists in `keys` if newly set.
    const keys = parsed.keys.includes(key) ? parsed.keys : [...parsed.keys, key];
    const newBody = serializeFrontmatter(keys, newValues, parsed.bodyAfter);
    onUpdateBody(newBody);
  }

  function updatePrivacy(next: PrivacyValue) {
    update(PRIVACY_KEY, next);
  }

  /**
   * Remove an optional / custom key entirely from the frontmatter. Core
   * SPEC keys (CORE_KEYS) can never be removed — the caller already gates
   * this via the remove-icon visibility, but we guard here too so a stray
   * call can't corrupt the contract.
   */
  function remove(key: string) {
    if (CORE_KEYS.has(key)) return;
    const keys = parsed.keys.filter((k) => k !== key);
    const newValues: Record<string, FieldValue> = { ...parsed.values };
    delete newValues[key];
    const newBody = serializeFrontmatter(keys, newValues, parsed.bodyAfter);
    onUpdateBody(newBody);
  }

  /**
   * Add a brand-new key to the frontmatter with a type-appropriate empty
   * value. Routes through the same serialize/onUpdateBody path as edits, so
   * the new key survives a save→reload roundtrip (the key is appended to the
   * ordered `keys` list by `serializeFrontmatter`). No-ops if the key already
   * exists or is blank.
   */
  function addProperty(rawKey: string) {
    const key = rawKey.trim();
    if (key === "") return;
    if (parsed.keys.includes(key)) return;
    const initial: FieldValue = ARRAY_VALUED_FIELDS.has(key) ? [] : "";
    const keys = [...parsed.keys, key];
    const newValues: Record<string, FieldValue> = {
      ...parsed.values,
      [key]: initial,
    };
    const newBody = serializeFrontmatter(keys, newValues, parsed.bodyAfter);
    onUpdateBody(newBody);
  }

  // Schema-known optional fields for this doc type that are NOT already
  // present — these populate the quick-add menu.
  const optionalCandidates = (
    TYPE_OPTIONAL_FIELDS[docType] ?? FALLBACK_OPTIONAL_FIELDS
  ).filter((k) => !parsed.keys.includes(k));

  // Subtle Brand-accent tint when privacy is local-only — visible at a
  // glance without being shouty. RGBA over the existing panel background.
  const panelStyle: CSSProperties = isLocalOnly
    ? { ...PANEL_STYLE, background: "rgba(249,115,22,0.05)" }
    : PANEL_STYLE;

  return (
    <div style={panelStyle}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        style={HEADER_STYLE}
        aria-expanded={expanded}
      >
        <span
          style={{
            fontSize: 16,
            color: C.accent,
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 0.15s ease",
            display: "inline-block",
            lineHeight: 1,
          }}
        >
          ▸
        </span>
        <span>Properties ({fieldCount})</span>
        {isLocalOnly && <span style={PRIVACY_BADGE_STYLE}>🔒 LOCAL</span>}
      </div>

      {expanded && (
        <>
          {/* Dedicated Privacy row — pinned at the top because the
              privacy tier gates which LLM provider the router chooses. */}
          <div style={{ ...PRIVACY_ROW_STYLE, marginTop: 12 }}>
            <span style={{ ...LABEL_STYLE, alignSelf: "center" }}>
              🔒 Privacy
            </span>
            <select
              value={currentPrivacy}
              onChange={(e) => updatePrivacy(e.target.value as PrivacyValue)}
              style={PRIVACY_SELECT_STYLE}
              aria-label="Privacy tier for AI operations"
            >
              <option value="default">
                Default (follows your global setting)
              </option>
              <option value="local-only">
                Local-only (never sent to cloud LLMs)
              </option>
            </select>
            {isLocalOnly && <span style={PRIVACY_BADGE_STYLE}>🔒 LOCAL</span>}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "140px 1fr",
              gap: "8px 12px",
              alignItems: "start",
            }}
          >
            {visibleKeys.map((key) => {
              const value = parsed.values[key];
              return (
                <Row
                  key={key}
                  fieldKey={key}
                  value={value as FieldValue}
                  onChange={(v) => update(key, v)}
                  onRemove={CORE_KEYS.has(key) ? undefined : () => remove(key)}
                />
              );
            })}
          </div>

          <AddProperty
            candidates={optionalCandidates}
            existingKeys={parsed.keys}
            onAdd={addProperty}
          />

          {isPeer && (
            <PeerSection
              values={parsed.values}
              onUpdate={(key, next) => update(key, next)}
            />
          )}

          {encodedSnapshot && (
            <details style={{ marginTop: 12 }}>
              <summary
                style={{
                  cursor: "pointer",
                  color: C.textDim,
                  fontSize: 12,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  userSelect: "none",
                  padding: "4px 0",
                }}
              >
                Encoded Context ({encodedSnapshot.fields.length})
              </summary>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "140px 1fr",
                  gap: "6px 12px",
                  alignItems: "center",
                  marginTop: 8,
                  paddingLeft: 4,
                }}
              >
                {encodedSnapshot.fields.map((f) => (
                  <Fragment key={f.key}>
                    <span style={LABEL_STYLE}>
                      {ENCODED_FIELD_LABELS[f.key] ?? f.key}
                    </span>
                    <input
                      type="text"
                      value={Array.isArray(f.value) ? f.value.join(", ") : f.value}
                      readOnly
                      tabIndex={-1}
                      style={READONLY_STYLE}
                    />
                  </Fragment>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

// ─── Row dispatch ────────────────────────────────────────────────────────

function Row(props: {
  fieldKey: string;
  value: FieldValue;
  onChange: (v: FieldValue) => void;
  /** When provided, a remove icon is shown next to the field. */
  onRemove?: () => void;
}) {
  const { fieldKey, value, onChange, onRemove } = props;
  const readOnly = READ_ONLY_KEYS.has(fieldKey);

  return (
    <>
      <label style={LABEL_STYLE}>{fieldKey}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {renderField(fieldKey, value, onChange, readOnly)}
        </div>
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${fieldKey}`}
            title={`Remove ${fieldKey}`}
            onClick={onRemove}
            style={REMOVE_ICON_STYLE}
          >
            ×
          </button>
        )}
      </div>
    </>
  );
}

function renderField(
  key: string,
  value: FieldValue,
  onChange: (v: FieldValue) => void,
  readOnly: boolean,
) {
  if (readOnly) {
    const display = Array.isArray(value)
      ? value.join(", ")
      : typeof value === "boolean"
        ? value ? "true" : "false"
        : value;
    return (
      <input
        type="text"
        value={display}
        readOnly
        style={READONLY_STYLE}
        tabIndex={-1}
      />
    );
  }

  if (key === "type") {
    const current = typeof value === "string" ? value : "";
    return (
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        style={{
          ...INPUT_BASE,
          appearance: "none",
        }}
      >
        {!DOC_TYPE_OPTIONS.includes(current as typeof DOC_TYPE_OPTIONS[number]) && (
          <option value={current}>{current || "(unset)"}</option>
        )}
        {DOC_TYPE_OPTIONS.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (key === "tags") {
    const arr = Array.isArray(value) ? value : [];
    return <ChipInput value={arr} onChange={(v) => onChange(v)} asTags />;
  }

  if (Array.isArray(value)) {
    return <ChipInput value={value} onChange={(v) => onChange(v)} />;
  }

  if (typeof value === "boolean") {
    return (
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "#F97316", width: 16, height: 16 }}
      />
    );
  }

  return <FocusableInput value={value} onChange={(v) => onChange(v)} />;
}

// ─── Add-property control ─────────────────────────────────────────────────
//
// Sits below the field grid. Collapsed by default ("+ Property"). Expanding
// reveals (a) one-click chips for schema-known optional fields not yet
// present (e.g. `tags`, `status`), and (b) a free custom key/value form for
// arbitrary keys (schemas allow `additionalProperties: true`). Both paths
// call `onAdd(key)`, which appends the key to the frontmatter via the normal
// serialize→onUpdateBody save path so it survives a reload roundtrip.

function AddProperty(props: {
  candidates: string[];
  existingKeys: string[];
  onAdd: (key: string) => void;
}) {
  const { candidates, existingKeys, onAdd } = props;
  const [open, setOpen] = useState(false);
  const [customKey, setCustomKey] = useState("");

  // A valid YAML-ish key: starts with a letter/underscore, then word chars /
  // hyphens. Matches the parser's own key regex so a saved field round-trips.
  const trimmed = customKey.trim();
  const keyValid = /^[A-Za-z_][A-Za-z0-9_\-]*$/.test(trimmed);
  const keyDuplicate = existingKeys.includes(trimmed);
  const canAddCustom = keyValid && !keyDuplicate;

  function addCustom() {
    if (!canAddCustom) return;
    onAdd(trimmed);
    setCustomKey("");
    setOpen(false);
  }

  if (!open) {
    return (
      <div style={ADD_PROPERTY_WRAP_STYLE}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={ADD_BUTTON_STYLE}
        >
          + Property
        </button>
      </div>
    );
  }

  return (
    <div style={ADD_PROPERTY_WRAP_STYLE}>
      {candidates.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>Suggested fields</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {candidates.map((c) => (
              <button
                key={c}
                type="button"
                style={SUGGEST_CHIP_STYLE}
                onClick={() => {
                  onAdd(c);
                  setOpen(false);
                }}
              >
                + {c}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={{ ...LABEL_STYLE, marginBottom: 6 }}>Weitere Felder</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="text"
            value={customKey}
            placeholder="key"
            aria-label="Custom property key"
            onChange={(e) => setCustomKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
            style={{
              ...INPUT_BASE,
              flex: 1,
              minWidth: 0,
              borderColor:
                trimmed !== "" && !canAddCustom ? "#F97316" : C.border,
            }}
          />
          <button
            type="button"
            onClick={addCustom}
            disabled={!canAddCustom}
            style={{
              ...ADD_BUTTON_STYLE,
              opacity: canAddCustom ? 1 : 0.4,
              cursor: canAddCustom ? "pointer" : "not-allowed",
            }}
          >
            Add
          </button>
          <button
            type="button"
            aria-label="Cancel add property"
            onClick={() => {
              setCustomKey("");
              setOpen(false);
            }}
            style={REMOVE_ICON_STYLE}
          >
            ×
          </button>
        </div>
        {trimmed !== "" && keyDuplicate && (
          <div style={{ color: "#F97316", fontSize: 11, marginTop: 4 }}>
            Field "{trimmed}" already exists.
          </div>
        )}
        {trimmed !== "" && !keyValid && (
          <div style={{ color: "#F97316", fontSize: 11, marginTop: 4 }}>
            Key must start with a letter and contain only letters, digits,
            "_" or "-".
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Peer-Section (Phase C Wave C2 / Story 3) ────────────────────────────
//
// Honcho-style peer-note extras. Only rendered when `type: peer`. The
// `relationship_strength` slider is read-only by design — the sleep-pass
// owns the value (frontmatter can still override by raw .md edit). The
// other extras are user-editable chip-lists and inputs.
//
// Peer-types — duplicated here intentionally instead of importing from
// @lokyy/core (PWA is a browser bundle, `core` ships node-only code).
const PEER_TYPE_OPTIONS = [
  "person",
  "customer",
  "collaborator",
  "family",
  "agent",
  "organization",
] as const;

const PEER_SECTION_STYLE: CSSProperties = {
  marginTop: 14,
  paddingTop: 12,
  borderTop: `1px dashed ${C.border}`,
};

const PEER_SECTION_HEADER_STYLE: CSSProperties = {
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: C.textDim,
  marginBottom: 8,
  fontWeight: 600,
};

const STRENGTH_BAR_BG: CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  height: 18,
  position: "relative",
  overflow: "hidden",
};

const STRENGTH_BAR_FILL = (pct: number): CSSProperties => ({
  position: "absolute",
  top: 0,
  bottom: 0,
  left: 0,
  width: `${Math.round(pct * 100)}%`,
  background:
    "linear-gradient(90deg, rgba(249,115,22,0.55), rgba(255,169,77,0.75))",
});

const STRENGTH_VALUE_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  color: C.text,
  fontVariantNumeric: "tabular-nums",
};

function PeerSection(props: {
  values: Record<string, FieldValue>;
  onUpdate: (key: string, next: FieldValue) => void;
}) {
  const { values, onUpdate } = props;

  // ── relationship_strength (read-only slider) ────────────────────────
  const rawStrength = values.relationship_strength;
  const strength = (() => {
    const n = typeof rawStrength === "string" ? Number(rawStrength) : rawStrength;
    return typeof n === "number" && Number.isFinite(n)
      ? Math.max(0, Math.min(1, n))
      : 0;
  })();

  // ── peer_type ───────────────────────────────────────────────────────
  const rawPeerType = values.peer_type;
  const peerType = typeof rawPeerType === "string" ? rawPeerType : "";

  // ── ongoing_topics ──────────────────────────────────────────────────
  const ongoingTopics = Array.isArray(values.ongoing_topics)
    ? values.ongoing_topics
    : [];

  // ── traits ──────────────────────────────────────────────────────────
  const traits = Array.isArray(values.traits) ? values.traits : [];

  // ── last_interaction ────────────────────────────────────────────────
  const lastInteraction =
    typeof values.last_interaction === "string" ? values.last_interaction : "";

  // ── first_met ───────────────────────────────────────────────────────
  const firstMet = typeof values.first_met === "string" ? values.first_met : "";

  // ── interaction_count ───────────────────────────────────────────────
  const interactionCount = (() => {
    const v = values.interaction_count;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? String(Math.floor(n)) : "";
    }
    return "";
  })();

  // ── linked_entity_id ────────────────────────────────────────────────
  const linkedEntityId =
    typeof values.linked_entity_id === "string" ? values.linked_entity_id : "";

  return (
    <div style={PEER_SECTION_STYLE}>
      <div style={PEER_SECTION_HEADER_STYLE}>Peer Profile</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "140px 1fr",
          gap: "8px 12px",
          alignItems: "center",
        }}
      >
        {/* peer_type select */}
        <label style={LABEL_STYLE}>peer_type</label>
        <select
          value={peerType}
          onChange={(e) => onUpdate("peer_type", e.target.value)}
          style={{ ...INPUT_BASE, appearance: "none" }}
        >
          {!(PEER_TYPE_OPTIONS as readonly string[]).includes(peerType) && (
            <option value={peerType}>{peerType || "(unset)"}</option>
          )}
          {PEER_TYPE_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>

        {/* relationship_strength — read-only progress bar */}
        <label style={LABEL_STYLE}>strength</label>
        <div style={STRENGTH_BAR_BG} title="Agent-computed — frontmatter override wins">
          <div style={STRENGTH_BAR_FILL(strength)} />
          <span style={STRENGTH_VALUE_STYLE}>{strength.toFixed(2)}</span>
        </div>

        {/* ongoing_topics chip-list */}
        <label style={LABEL_STYLE}>ongoing topics</label>
        <ChipInput
          value={ongoingTopics}
          onChange={(v) => onUpdate("ongoing_topics", v)}
        />

        {/* traits chip-list */}
        <label style={LABEL_STYLE}>traits</label>
        <ChipInput value={traits} onChange={(v) => onUpdate("traits", v)} />

        {/* last_interaction — datetime-local input */}
        <label style={LABEL_STYLE}>last interaction</label>
        <FocusableInput
          value={lastInteraction}
          onChange={(v) => onUpdate("last_interaction", v)}
        />

        {/* first_met — date input */}
        <label style={LABEL_STYLE}>first met</label>
        <FocusableInput
          value={firstMet}
          onChange={(v) => onUpdate("first_met", v)}
        />

        {/* interaction_count — numeric */}
        <label style={LABEL_STYLE}>interactions</label>
        <FocusableInput
          value={interactionCount}
          onChange={(v) => {
            const n = Number(v);
            if (v === "") onUpdate("interaction_count", "");
            else if (Number.isFinite(n) && n >= 0)
              onUpdate("interaction_count", String(Math.floor(n)));
          }}
        />

        {/* linked_entity_id — clickable when present (anchor to entity page) */}
        <label style={LABEL_STYLE}>linked entity</label>
        {linkedEntityId ? (
          <a
            href={`/entities/${encodeURIComponent(linkedEntityId)}`}
            style={{
              ...INPUT_BASE,
              color: "#FFA94D",
              textDecoration: "none",
              display: "block",
            }}
          >
            {linkedEntityId} →
          </a>
        ) : (
          <span style={{ ...READONLY_STYLE, display: "block" }}>(none)</span>
        )}
      </div>
    </div>
  );
}
