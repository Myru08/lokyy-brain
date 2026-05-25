import { ulid } from "ulid";
import { and, desc, eq, ne, sql } from "drizzle-orm";

import { database } from "../db/index.js";
import {
  entities,
  entityMentions,
  ENTITY_TYPES,
  isEntityType,
  type EntityRow,
  type EntityType,
} from "../db/schema/entities.js";

/**
 * Phase C Wave C2 / Story 2 — Entity store API.
 *
 * Public surface for the entity-extraction pipeline. The REM-sleep
 * `entity-extraction` pass calls `upsertEntity` per extracted mention;
 * the server / MCP layer calls the read helpers (`listEntities`,
 * `entitiesInNote`, `notesForEntity`, `entityCoOccurrence`).
 *
 * Canonical-name normalization is the load-bearing piece: two display-name
 * variants ("Anna Müller", "Anna Mueller", "anna mueller", "Anna  Müller ")
 * must collapse onto the SAME canonical key so we never duplicate the
 * entity row and the `mention_count` aggregation stays meaningful. See
 * `normalizeName` for the rules and the German-umlaut mapping table.
 */

export type { EntityType };
export { ENTITY_TYPES, isEntityType };

/** Runtime shape used outside the DB layer. */
export interface Entity {
  id: string;
  canonicalName: string;
  displayName: string;
  type: EntityType;
  aliases: string[];
  firstSeen: Date;
  lastSeen: Date;
  mentionCount: number;
  metadata?: Record<string, unknown>;
}

/** What the LLM-as-NER pass produces per mention before the upsert. */
export interface ExtractedEntity {
  displayName: string;
  type: EntityType;
  confidence: number;
  contextSnippet: string;
}

/**
 * German-umlaut + ß mapping. Done BEFORE the generic
 * `String.normalize("NFD")` strip so the result matches the standard
 * German romanization convention (Müller → mueller, NOT muller).
 *
 * Note: `ñ`, `é`, `ç` etc. fall through to NFD-strip; only the German
 * letters need explicit two-character mapping (ä → ae, NOT a).
 */
const GERMAN_UMLAUT_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/g, "ae"],
  [/ö/g, "oe"],
  [/ü/g, "ue"],
  [/Ä/g, "ae"],
  [/Ö/g, "oe"],
  [/Ü/g, "ue"],
  [/ß/g, "ss"],
];

/**
 * Normalize a name for canonical-form matching:
 *
 *   1. Lowercase                        ("Anna Müller" → "anna müller")
 *   2. Map German umlauts + ß           ("anna müller"  → "anna mueller")
 *   3. NFD-normalize + strip combining  ("café" → "cafe")
 *   4. Strip leading honorifics         ("dr. smith" → "smith"   — see notes)
 *      ⚠ removed: keep titles like "dr" — collapsing "Dr. Smith" with "Smith"
 *      is too eager (different humans), so we only strip the trailing dot.
 *   5. Drop punctuation (keep letters, digits, intra-word hyphens)
 *   6. Collapse internal whitespace, trim
 *
 * Examples (after the full pipeline):
 *   "Anna Müller"  → "anna mueller"
 *   "Anna  Müller "→ "anna mueller"
 *   "Dr. Smith"    → "dr smith"
 *   "Straße"       → "strasse"
 *   "AI/ML"        → "ai ml"
 *   "café"         → "cafe"
 */
export function normalizeName(name: string): string {
  if (typeof name !== "string") return "";
  let s = name.toLowerCase();
  for (const [re, rep] of GERMAN_UMLAUT_MAP) {
    s = s.replace(re, rep);
  }
  // NFD-normalize + strip remaining combining marks (covers é, ñ, ç, …).
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Replace non [a-z0-9-] runs with single spaces, then collapse + trim.
  s = s.replace(/[^a-z0-9-]+/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

/** Map a Drizzle row back to the runtime shape. */
function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    canonicalName: row.canonicalName,
    displayName: row.displayName,
    type: isEntityType(row.type) ? row.type : "concept",
    aliases: row.aliases ?? [],
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    mentionCount: row.mentionCount,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Upsert one extracted entity against the store:
 *   - Existing canonical-name + type → increment `mention_count`, update
 *     `last_seen`, add `displayName` to `aliases` if not already present.
 *   - No match → INSERT a fresh row.
 *
 * The per-note mention edge in `entity_mentions` is created idempotently
 * (composite PK = `(entity_id, note_id)`): re-running the pass against the
 * same note does NOT inflate the `entity_mentions` table, only the
 * `entities.mention_count` aggregate moves.
 *
 * `(canonical_name, type)` is the dedup key — different types can share a
 * canonical name without colliding ("apple" the company vs "apple" the
 * concept) and the type-aware index keeps lookups O(1) per row.
 */
export async function upsertEntity(
  extracted: ExtractedEntity,
  noteId: string,
  observedAt: Date,
): Promise<Entity> {
  const canonical = normalizeName(extracted.displayName);
  if (canonical.length === 0) {
    throw new Error("upsertEntity: displayName normalized to empty string");
  }

  const db = database();

  // Find existing (canonical, type) match — same canonical with a different
  // type is intentionally a separate row.
  const existing = await db
    .select()
    .from(entities)
    .where(
      and(eq(entities.canonicalName, canonical), eq(entities.type, extracted.type)),
    )
    .limit(1);

  let entity: Entity;

  if (existing.length > 0) {
    const row = existing[0]!;
    const aliases = row.aliases ?? [];
    const needsAlias =
      extracted.displayName !== row.displayName &&
      !aliases.includes(extracted.displayName);
    const newAliases = needsAlias ? [...aliases, extracted.displayName] : aliases;

    await db
      .update(entities)
      .set({
        lastSeen: observedAt,
        mentionCount: row.mentionCount + 1,
        aliases: newAliases,
      })
      .where(eq(entities.id, row.id));

    entity = rowToEntity({
      ...row,
      lastSeen: observedAt,
      mentionCount: row.mentionCount + 1,
      aliases: newAliases,
    });
  } else {
    const id = ulid();
    const row: EntityRow = {
      id,
      canonicalName: canonical,
      displayName: extracted.displayName,
      type: extracted.type,
      aliases: [],
      firstSeen: observedAt,
      lastSeen: observedAt,
      mentionCount: 1,
      metadata: null,
    };
    await db.insert(entities).values(row);
    entity = rowToEntity(row);
  }

  // Per-(entity, note) edge. ON CONFLICT DO NOTHING: re-seeing the same
  // (entity, note) pair leaves the edge alone — only the `mention_count`
  // on the canonical row moves up. Idempotent for repeated sleep-runs.
  await db
    .insert(entityMentions)
    .values({
      entityId: entity.id,
      noteId,
      observedAt,
      confidence: extracted.confidence.toFixed(3),
      context: extracted.contextSnippet.slice(0, 200),
    })
    .onConflictDoNothing();

  return entity;
}

export interface ListEntitiesOpts {
  type?: EntityType;
  limit?: number;
  minMentions?: number;
}

/**
 * List entities, optionally filtered by type / mention threshold. Newest
 * `last_seen` first (matches the typical "most-active entities" UI need).
 */
export async function listEntities(opts: ListEntitiesOpts = {}): Promise<Entity[]> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
  const minMentions = Math.max(0, opts.minMentions ?? 0);

  const conds = [] as ReturnType<typeof eq>[];
  if (opts.type) conds.push(eq(entities.type, opts.type));
  if (minMentions > 0) {
    // drizzle has no `gte` exported alias here that's pre-typed against the
    // column; using sql template gets us the >= compare without importing
    // another helper.
    conds.push(
      sql`${entities.mentionCount} >= ${minMentions}` as unknown as ReturnType<
        typeof eq
      >,
    );
  }

  const base = database()
    .select()
    .from(entities)
    .orderBy(desc(entities.lastSeen))
    .limit(limit);

  const rows = await (conds.length === 0
    ? base
    : conds.length === 1
      ? base.where(conds[0]!)
      : base.where(and(...conds)));

  return rows.map(rowToEntity);
}

/** Get a single entity by id, or null. */
export async function getEntity(id: string): Promise<Entity | null> {
  const rows = await database()
    .select()
    .from(entities)
    .where(eq(entities.id, id))
    .limit(1);
  const row = rows[0];
  return row ? rowToEntity(row) : null;
}

/** Entities mentioned in the given note (deduped). */
export async function entitiesInNote(noteId: string): Promise<Entity[]> {
  const rows = await database()
    .select({
      id: entities.id,
      canonicalName: entities.canonicalName,
      displayName: entities.displayName,
      type: entities.type,
      aliases: entities.aliases,
      firstSeen: entities.firstSeen,
      lastSeen: entities.lastSeen,
      mentionCount: entities.mentionCount,
      metadata: entities.metadata,
    })
    .from(entityMentions)
    .innerJoin(entities, eq(entities.id, entityMentions.entityId))
    .where(eq(entityMentions.noteId, noteId));
  return rows.map((r) => rowToEntity(r as EntityRow));
}

/** All note ids that mention the given entity. */
export async function notesForEntity(entityId: string): Promise<string[]> {
  const rows = await database()
    .select({ noteId: entityMentions.noteId })
    .from(entityMentions)
    .where(eq(entityMentions.entityId, entityId));
  return rows.map((r) => r.noteId);
}

export interface CoOccurrenceHit {
  entityId: string;
  count: number;
}

/**
 * Entities most frequently co-mentioned with `entityId` in the same notes.
 * Self-loop (the seed entity itself) is excluded. Result sorted by count
 * desc, then by `entityId` asc for stable pagination.
 */
export async function entityCoOccurrence(
  entityId: string,
  limit = 20,
): Promise<CoOccurrenceHit[]> {
  const cappedLimit = Math.max(1, Math.min(500, limit));
  const db = database();

  // Subquery: notes mentioning the seed entity.
  const seedNotes = db
    .select({ noteId: entityMentions.noteId })
    .from(entityMentions)
    .where(eq(entityMentions.entityId, entityId));

  // Join the seed-notes back to entity_mentions and count per other-entity.
  const rows = await db
    .select({
      entityId: entityMentions.entityId,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(entityMentions)
    .where(
      and(
        ne(entityMentions.entityId, entityId),
        sql`${entityMentions.noteId} IN ${seedNotes}`,
      ),
    )
    .groupBy(entityMentions.entityId)
    .orderBy(sql`COUNT(*) DESC, ${entityMentions.entityId} ASC`)
    .limit(cappedLimit);

  return rows.map((r) => ({ entityId: r.entityId, count: Number(r.count) }));
}
