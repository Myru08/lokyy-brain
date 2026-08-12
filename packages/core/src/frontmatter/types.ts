/**
 * Vault frontmatter contract — see CLAUDE.md "Vault Contract (SPEC)".
 *
 * Every .md file in a lokyy-vault requires YAML frontmatter validated by
 * one of these doc types. The pre-commit hook in the vault rejects any
 * write that fails validation.
 */

/** Closed list of supported doc types. */
export const DOC_TYPES = [
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
  // Phase C Wave C2 / Story 3 — Honcho-style peer abstraction.
  // A peer-note represents a person/org/agent the user has an ongoing
  // relationship with; the sleep-agent maintains relationship_strength,
  // ongoing_topics, traits, last_interaction over time.
  "peer",
  // Epic 9 / Story 9-1 — a skill-note is a reusable prompt definition with
  // an execution target (client | server) and an advisory allowed_tools
  // list. Parser/renderer (9-2) and MCP run_skill (9-3) consume it; this
  // type only adds the closed-list membership + schema validation.
  "skill",
  // Epic 10 / Story 10.15 — custom/extended type enum. Three additional
  // closed-list types so the user can classify reference material:
  //   tool      → a software tool / utility (lives in 35_tools)
  //   resource  → an external resource captured for later (lives in 30_captures)
  //   reference → durable reference / lookup material (lives in 20_notes)
  // Each adds only closed-list membership + a schema mirroring note.json
  // (plus an optional `url` field). They auto-propagate into the conventions
  // and folder maps via DOC_TYPES.
  "tool",
  "resource",
  "reference",
  // Modul 15_lerngebiete (ADR-015) — ein Lerngebiet ist ein eigenständiges,
  // langlebiges Lernvorhaben (persönlich oder beruflich) mit eigenem
  // Lernstand, eigenen Lektionen und Lernnachweisen. Bewusst KEIN `project`:
  // ein Projekt zielt auf ein Lieferergebnis mit Abschluss, ein Lerngebiet auf
  // fortlaufenden Kompetenzaufbau ohne festen Endtermin — und es trägt einen
  // eigenen Status-Satz (draft|active|paused|completed|archived).
  // Heimat: `15_lerngebiete` (siehe notes/folderMap.ts). Wie die 10.15-Typen
  // propagiert der Typ über DOC_TYPES automatisch in Conventions, Folder-Map,
  // Scaffold und MCP-Oberfläche.
  "learning-area",
] as const;

/**
 * Story S2 — Karpathy-Profil-Doc-Typen (RAW / Wiki / Outputs).
 *
 * Diese drei Typen gehören NICHT zum PARA-Default-Profil und werden absichtlich
 * NICHT in `DOC_TYPES` gemischt (PARA bleibt bit-identisch — Entscheidung B1,
 * keine bestehende Notiz wird invalide). Das `karpathy`-SPEC-Profil
 * (`frontmatter/profiles.ts`) registriert sie mit eigener type→Ordner-Map
 * (`raw-source→RAW`, `wiki-article→Wiki`, `frage-report→Outputs`) und eigenem
 * Schema-Set. Aktiv nur in Vaults, deren Profil auf `karpathy` aufgelöst wird.
 */
export const KARPATHY_DOC_TYPES = [
  "raw-source",
  "wiki-article",
  "frage-report",
] as const;

export type KarpathyDocType = (typeof KARPATHY_DOC_TYPES)[number];

/**
 * Union aller bekannten Doc-Typen über alle Profile hinweg. `DocType` bleibt
 * der PARA-Default-Typ (abwärtskompatibel: bestehende Signaturen, die `DocType`
 * erwarten, ändern sich nicht). Profil-bewusste Aufrufer akzeptieren
 * `AnyDocType`.
 */
export type DocType = (typeof DOC_TYPES)[number];
export type AnyDocType = DocType | KarpathyDocType;

/**
 * Phase C Wave C2 / Story 3 — kinds of peer the user interacts with.
 *
 * Mirrors the Honcho peer-abstraction: every entity with ongoing two-way
 * interaction shares the same profile shape, but the `peer_type` distinguishes
 * how the relationship is interpreted (e.g. `customer` vs `family`).
 */
export const PEER_TYPES = [
  "person",
  "customer",
  "collaborator",
  "family",
  "agent",
  "organization",
] as const;
export type PeerType = (typeof PEER_TYPES)[number];

export function isPeerType(value: string): value is PeerType {
  return (PEER_TYPES as readonly string[]).includes(value);
}

/**
 * Strict frontmatter shape for `type: peer` notes. The DB sidecar
 * (`peer_profiles`) mirrors the same fields plus a computed timestamp; the
 * frontmatter is the source of truth (Forgejo > DB), the sidecar is an
 * index for cheap aggregate listing.
 */
export interface PeerFrontmatter extends BaseFrontmatter {
  peer_type: PeerType;
  relationship_strength?: number;
  first_met?: string;
  last_interaction?: string;
  interaction_count?: number;
  ongoing_topics?: string[];
  traits?: string[];
  linked_entity_id?: string;
  contact?: {
    email?: string;
    phone?: string;
    company?: string;
    role?: string;
  };
  communication_history_summary?: string;
}

/**
 * Per-note privacy tier (frontmatter `privacy:` field).
 *
 * - `"default"` — follow the global privacyTier setting of the LLM router.
 * - `"local-only"` — force a local provider (`isLocal: true`) regardless of
 *   the user's global setting. Cloud providers are skipped in the router
 *   chain for any AI operation against this note.
 *
 * Optional; absent means `"default"` (backwards-compat with legacy notes
 * written before this field existed).
 */
export type NotePrivacy = "default" | "local-only";

/**
 * Device categories used by the encoding-context-capture (Phase B Wave B3 /
 * Story 1 — Tulving 1973 Encoding Specificity Principle).
 *
 * `"api"` covers headless / scripted writes; `"mcp"` distinguishes writes
 * arriving through the MCP tool surface so retrieval can prefer
 * human-authored notes when the query comes from the PWA.
 */
export type DeviceType =
  | "laptop"
  | "desktop"
  | "mobile"
  | "tablet"
  | "api"
  | "mcp";

/** Coarse time-of-day bucket. See `timeOfDayFrom` in `scoring/encodingContext.ts`. */
export type TimeOfDay = "morning" | "midday" | "evening" | "night";

/** Lowercase English weekday name. */
export type Weekday =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/**
 * Encoding-context block. Captured at note-creation time and persisted as
 * `encoded:` in the YAML frontmatter. NEVER updated on subsequent saves —
 * it describes the encoding event, not the current state of the note.
 *
 * All fields are optional so legacy notes (no `encoded` block) continue to
 * validate; matchers treat a missing block as "no boost".
 */
export interface EncodedContext {
  /** Device class the note was authored on. */
  device?: DeviceType;
  /** Free-form app-state label (e.g. `"focused-writing"`, `"daily-review"`). */
  app_state?: string;
  /** Coarse time-of-day at creation. Derived from local clock. */
  time_of_day?: TimeOfDay;
  /** Weekday at creation. Derived from local clock. */
  weekday?: Weekday;
  /** Notes that were open immediately before this one was created. */
  preceding_notes?: string[];
  /** Length of the authoring session up to this note, in minutes. */
  session_duration_min?: number;
  /** Word-count produced during this session up to creation. */
  word_count_session?: number;
  /** Origin metadata when the note came from a pipe (url, youtube, …). */
  source?: Record<string, unknown>;
}

/**
 * Parsed frontmatter map — open shape; per-type schemas enforce required
 * keys via ajv. We type the well-known fields for ergonomics, but keep the
 * index signature so per-doc-type extras (e.g. `status` on tasks, `source`
 * on captures) pass through without per-call casts.
 */
export interface FrontmatterMap {
  /** ULID (26 chars, Crockford base32). Immutable after creation. */
  id?: string;
  /** One of the DOC_TYPES values. */
  type?: DocType;
  /** Human-readable title. */
  title?: string;
  /** Creation ISO-8601 timestamp. Immutable after creation. */
  created?: string;
  /** Last-modified ISO-8601 timestamp. Bumped on each save. */
  updated?: string;
  /** Free-form tags. */
  tags?: string[];
  /** Aliases for the note (alternative names). */
  aliases?: string[];
  /**
   * Privacy tier for AI operations. When set to `"local-only"` the
   * LlmRouter is forced onto an `isLocal: true` provider regardless of
   * the user's global privacyTier setting. Absent = `"default"`.
   */
  privacy?: NotePrivacy;
  /**
   * Encoding-context captured at create-time. See `EncodedContext` and
   * `scoring/encodingContext.ts`. Optional — legacy notes have no block.
   */
  encoded?: EncodedContext;
  /** Per-doc-type extras (status, due, source, …) pass through here. */
  [key: string]: unknown;
}

/** Required base fields every doc carries (strict — for typed builders). */
export interface BaseFrontmatter {
  /** ULID (26 chars, Crockford base32). Immutable after creation. */
  id: string;
  /** One of the DOC_TYPES values. */
  type: DocType;
  /** Human-readable title. */
  title: string;
  /** Creation ISO-8601 timestamp. Immutable after creation. */
  created: string;
  /** Last-modified ISO-8601 timestamp. Bumped on each save. */
  updated: string;
  /** Optional privacy tier — see `NotePrivacy`. */
  privacy?: NotePrivacy;
  /** Optional encoding-context block — see `EncodedContext`. */
  encoded?: EncodedContext;
  /**
   * Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
   *
   * When `true` (or an ISO-timestamp string marking when the user invoked
   * forget), the note is excluded from active retrieval across every
   * search layer (Tier1-BM25, Tier2-embeddings, hybrid-RRF, PPR). The
   * note itself stays in the vault for audit + recovery; an explicit
   * unforget() drops the field.
   *
   * Absent = not forgotten. Backwards-compatible with legacy notes.
   */
  forgotten?: boolean | string;
}

/**
 * Phase C Wave C3 / Story 2 — Cognee `forget()` primitive.
 *
 * Returns true when the supplied frontmatter has an active "forgotten"
 * marker. Accepts both shapes the schema allows:
 *
 *   - `forgotten: true`           — legacy / fast-path boolean
 *   - `forgotten: "2026-05-25T…"` — ISO-timestamp; truthy non-empty string
 *
 * Falsy values (`false`, empty string, missing field) → not forgotten.
 *
 * Input is intentionally typed as `{ forgotten?: unknown }` so the
 * function accepts both the strict `BaseFrontmatter`/`PeerFrontmatter`
 * (where `forgotten` is `boolean | string | undefined`) and the loose
 * `FrontmatterMap` index signature (where it's `unknown`) without an
 * explicit cast at every call-site.
 */
export function isForgotten(
  data: Record<string, unknown> | null | undefined,
): boolean {
  if (!data) return false;
  const v = data.forgotten;
  if (v === true) return true;
  if (typeof v === "string" && v.trim().length > 0) return true;
  return false;
}

/** Ajv-style validation result wrapper. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationErrorDetail[];
}

export interface ValidationErrorDetail {
  /** JSON Pointer path inside the frontmatter. */
  instancePath: string;
  /** Ajv keyword that failed (e.g. "required", "pattern", "format"). */
  keyword: string;
  /** Human-readable message. */
  message: string;
  /** Additional Ajv params (e.g. `{missingProperty: "id"}`). */
  params: Record<string, unknown>;
}
