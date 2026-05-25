import { and, desc, eq, sql } from "drizzle-orm";

import { database } from "../db/index.js";
import { peerProfiles, type PeerProfileRow } from "../db/schema/peerProfiles.js";
import { entities, entityMentions } from "../db/schema/entities.js";
import { getNote, createNote, listNotes } from "../notes/notesService.js";
import {
  parseFrontmatter,
  type FrontmatterMap,
} from "../frontmatter/index.js";
import { isPeerType, type PeerType } from "../frontmatter/types.js";

/**
 * Phase C Wave C2 / Story 3 — Honcho-style peer module.
 *
 * Public surface for peer-note CRUD against the sidecar table. The note
 * frontmatter (in Forgejo) is the source of truth; the `peer_profiles`
 * sidecar is a cheap aggregate index served by the `/api/peers/*` routes
 * and written by the `peer-profile-update` REM-sleep pass.
 *
 * Operations exposed:
 *   - `listPeers` / `getPeer`                  — read the sidecar.
 *   - `recomputePeerProfile`                   — re-derive a single peer's
 *      strength + topics + last_interaction from entity_mentions +
 *      retrieval_traces and persist both sidecar + frontmatter.
 *   - `suggestPeerCandidates`                  — find person-type entities
 *      with ≥N mentions that don't yet have a backing peer-note.
 *   - `createPeerFromEntity`                   — materialize a peer-note
 *      under `peers/{slug}` from an entity row.
 */

/** Default vault directory for peer notes — kept in sync with the schema slug rules. */
const PEER_NOTE_FOLDER = "peers";

/** Recompute trims to this many topic strings per peer. */
const MAX_TOPICS_PER_PEER = 20;

/** Saturate interactions-per-month at this value (formula component). */
const INTERACTION_RATE_SATURATION = 10;

export interface Peer {
  noteId: string;
  peerType: PeerType;
  linkedEntityId?: string;
  relationshipStrength: number;
  interactionCount: number;
  lastInteraction?: Date;
  ongoingTopics: string[];
  traits: string[];
  computedAt: Date;
}

export interface PeerSuggestion {
  entityId: string;
  displayName: string;
  mentionCount: number;
  /** Note id of an existing peer-note that already points at this entity, if any. */
  existingPeerNoteId?: string;
}

function rowToPeer(row: PeerProfileRow): Peer {
  const peerType = isPeerType(row.peerType) ? row.peerType : "person";
  return {
    noteId: row.noteId,
    peerType,
    linkedEntityId: row.linkedEntityId ?? undefined,
    relationshipStrength: row.relationshipStrength,
    interactionCount: row.interactionCount,
    lastInteraction: row.lastInteraction ?? undefined,
    ongoingTopics: row.ongoingTopics ?? [],
    traits: row.traits ?? [],
    computedAt: row.computedAt,
  };
}

/** List every peer profile (newest computed first). */
export async function listPeers(): Promise<Peer[]> {
  const rows = await database()
    .select()
    .from(peerProfiles)
    .orderBy(desc(peerProfiles.computedAt));
  return rows.map(rowToPeer);
}

/** Look up one peer profile by note id. */
export async function getPeer(noteId: string): Promise<Peer | null> {
  const rows = await database()
    .select()
    .from(peerProfiles)
    .where(eq(peerProfiles.noteId, noteId))
    .limit(1);
  const row = rows[0];
  return row ? rowToPeer(row) : null;
}

/**
 * Recompute one peer's profile from the live signals:
 *
 *   strength = 0.4 · min(1, interactions_per_month / 10)
 *            + 0.3 · recency_decay(last_interaction)
 *            + 0.3 · topic_diversity(unique / cap)
 *
 * Sources aggregated per peer:
 *   - `entity_mentions` joined on `linked_entity_id` (one mention = one
 *     interaction; mention.observed_at feeds last_interaction).
 *   - Future Wave C2/C3: also fold retrieval_traces of recent meeting/
 *     customer notes co-tagged with the peer. The hook is in place; the
 *     join is intentionally deferred until the meeting-tagging convention
 *     stabilises.
 *
 * Frontmatter wins: this function ONLY writes the DB sidecar. The
 * `peer-profile-update` sleep pass is responsible for writing back into
 * the .md file when it runs at sleep-time; this call is the cheap path the
 * `/api/peers/:noteId/recompute` route uses to refresh the index.
 *
 * Fire-and-forget at the call-site: failures are swallowed at the route
 * layer so a missing peer-note never blocks anything.
 */
export async function recomputePeerProfile(noteId: string): Promise<void> {
  const db = database();

  // 1. Load the peer-note frontmatter so we know which entity to aggregate
  //    against and pick up user-supplied traits / overrides.
  const note = await getNote(noteId);
  if (!note) {
    // No note → drop any stale sidecar row (cheap, idempotent).
    await db.delete(peerProfiles).where(eq(peerProfiles.noteId, noteId));
    return;
  }
  const { data: fm } = parseFrontmatter(note.body);
  if (fm.type !== "peer") return;

  const peerType: PeerType = isPeerType(String(fm.peer_type))
    ? (fm.peer_type as PeerType)
    : "person";
  const linkedEntityId =
    typeof fm.linked_entity_id === "string" && fm.linked_entity_id.length > 0
      ? fm.linked_entity_id
      : null;

  // 2. Aggregate interactions from entity_mentions for the bound entity.
  //    No bound entity? → fall back to whatever the frontmatter declared.
  let interactionCount = 0;
  let lastInteraction: Date | null = null;
  const topicSet = new Set<string>();

  if (linkedEntityId) {
    const mentions = await db
      .select({
        noteId: entityMentions.noteId,
        observedAt: entityMentions.observedAt,
      })
      .from(entityMentions)
      .where(eq(entityMentions.entityId, linkedEntityId));

    interactionCount = mentions.length;
    for (const m of mentions) {
      if (!lastInteraction || m.observedAt > lastInteraction) {
        lastInteraction = m.observedAt;
      }
    }

    // Co-tagged topics: collect tags from each mention-source note. We use
    // listNotes() once and index by id — cheaper than per-mention getNote.
    if (mentions.length > 0) {
      const wantedIds = new Set(mentions.map((m) => m.noteId));
      const all = await listNotes();
      for (const summary of all) {
        if (!wantedIds.has(summary.id)) continue;
        for (const tag of summary.tags ?? []) topicSet.add(tag);
      }
    }
  }

  // 3. Frontmatter wins for user-overridable fields.
  if (Array.isArray(fm.ongoing_topics)) {
    for (const t of fm.ongoing_topics) {
      if (typeof t === "string" && t.length > 0) topicSet.add(t);
    }
  }
  const traits = Array.isArray(fm.traits)
    ? fm.traits.filter((t): t is string => typeof t === "string")
    : [];
  if (typeof fm.last_interaction === "string") {
    const parsed = new Date(fm.last_interaction);
    if (!Number.isNaN(parsed.getTime()) && (!lastInteraction || parsed > lastInteraction)) {
      lastInteraction = parsed;
    }
  }
  if (typeof fm.interaction_count === "number" && fm.interaction_count > interactionCount) {
    interactionCount = Math.floor(fm.interaction_count);
  }

  const ongoingTopics = [...topicSet].slice(0, MAX_TOPICS_PER_PEER);

  // 4. Compute strength.
  const strength = computeRelationshipStrength({
    interactionCount,
    lastInteraction,
    topicCount: ongoingTopics.length,
    topicCap: MAX_TOPICS_PER_PEER,
    firstMet: typeof fm.first_met === "string" ? new Date(fm.first_met) : null,
  });

  // 5. Frontmatter-supplied override wins (user-set relationship_strength).
  const finalStrength =
    typeof fm.relationship_strength === "number" &&
    Number.isFinite(fm.relationship_strength)
      ? Math.max(0, Math.min(1, fm.relationship_strength))
      : strength;

  // 6. UPSERT into the sidecar.
  await db
    .insert(peerProfiles)
    .values({
      noteId,
      peerType,
      linkedEntityId: linkedEntityId ?? undefined,
      relationshipStrength: finalStrength,
      interactionCount,
      lastInteraction: lastInteraction ?? undefined,
      ongoingTopics,
      traits,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: peerProfiles.noteId,
      set: {
        peerType,
        linkedEntityId: linkedEntityId ?? null,
        relationshipStrength: finalStrength,
        interactionCount,
        lastInteraction: lastInteraction ?? null,
        ongoingTopics,
        traits,
        computedAt: new Date(),
      },
    });
}

/**
 * Find person-type entities with ≥`minMentions` mentions, joined with
 * `peer_profiles` so the caller knows which ones already have a backing
 * peer-note. Sort by mention count desc — most-frequent unbacked entities
 * first.
 */
export async function suggestPeerCandidates(
  minMentions: number = 5,
): Promise<PeerSuggestion[]> {
  const threshold = Math.max(1, Math.floor(minMentions));
  const db = database();

  // Single query: LEFT JOIN peer_profiles ON linked_entity_id matches.
  const rows = await db
    .select({
      entityId: entities.id,
      displayName: entities.displayName,
      mentionCount: entities.mentionCount,
      existingNoteId: peerProfiles.noteId,
    })
    .from(entities)
    .leftJoin(peerProfiles, eq(peerProfiles.linkedEntityId, entities.id))
    .where(
      and(
        eq(entities.type, "person"),
        sql`${entities.mentionCount} >= ${threshold}`,
      ),
    )
    .orderBy(desc(entities.mentionCount));

  return rows.map((r) => ({
    entityId: r.entityId,
    displayName: r.displayName,
    mentionCount: r.mentionCount,
    existingPeerNoteId: r.existingNoteId ?? undefined,
  }));
}

/**
 * Materialize a peer-note from an entity row. The new note lives under
 * `peers/{slug}` and starts with the SPEC-mandatory frontmatter plus the
 * Honcho-style fields seeded from the entity (display name, mention count,
 * last-seen). Throws if the entity does not exist or if a peer-note for
 * the same entity already exists (caller can call `suggestPeerCandidates`
 * to detect the dupe up front).
 */
export async function createPeerFromEntity(
  entityId: string,
  peerType: string,
): Promise<{ noteId: string }> {
  if (!isPeerType(peerType)) {
    throw new Error(
      `createPeerFromEntity: invalid peer_type "${peerType}" — must be one of person|customer|collaborator|family|agent|organization.`,
    );
  }

  const db = database();
  const rows = await db
    .select()
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  const ent = rows[0];
  if (!ent) {
    throw new Error(`createPeerFromEntity: entity "${entityId}" not found.`);
  }

  // Block duplicates — one peer-note per entity at most.
  const existing = await db
    .select({ noteId: peerProfiles.noteId })
    .from(peerProfiles)
    .where(eq(peerProfiles.linkedEntityId, entityId))
    .limit(1);
  if (existing.length > 0) {
    throw new Error(
      `createPeerFromEntity: entity "${entityId}" already has peer-note "${existing[0]!.noteId}".`,
    );
  }

  // Slug from the canonical-name — already lowercased + whitespace-collapsed.
  const slug = ent.canonicalName.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const noteId = `${PEER_NOTE_FOLDER}/${slug || ent.id}`;

  // Seed body — minimal, peer-note sleep-pass + user will flesh out.
  const body = `# ${ent.displayName}\n\n_Auto-created peer-note from entity \`${entityId}\`._\n\n## Notes\n\n`;

  // Frontmatter extras — the standard required fields (id/type/title/
  // created/updated) are generated by `createNote`; we pass the
  // peer-specific extras through `extra`.
  const extra: FrontmatterMap = {
    peer_type: peerType,
    linked_entity_id: entityId,
    relationship_strength: 0,
    interaction_count: ent.mentionCount,
    last_interaction: ent.lastSeen.toISOString(),
    ongoing_topics: [],
    traits: [],
  };

  await createNote(noteId, body, {
    type: "peer",
    title: ent.displayName,
    extra,
  });

  // Seed the sidecar so listings show it before the next sleep run. Best-
  // effort — the sidecar is recomputed every sleep pass anyway.
  try {
    await recomputePeerProfile(noteId);
  } catch {
    // ignore — sidecar is derived, frontmatter is the truth.
  }

  return { noteId };
}

interface StrengthInput {
  interactionCount: number;
  lastInteraction: Date | null;
  topicCount: number;
  topicCap: number;
  firstMet: Date | null;
}

/**
 * Honcho-style relationship-strength heuristic.
 *
 *   strength = 0.4 · min(1, interactions_per_month / 10)
 *            + 0.3 · recency_factor
 *            + 0.3 · topic_diversity
 *
 * Recency factor:
 *   ≤30d  → 1.0
 *   ≤90d  → 0.5
 *   >90d / null → 0.0
 *
 * Interactions-per-month is computed over the relationship lifetime
 * (`firstMet` → now). When `firstMet` is missing we use a 30-day default
 * window so a brand-new peer with 3 mentions in the first day reads as
 * "3/month" rather than dividing by ∞.
 *
 * Cosine-check (sanity test): with `interactions=30, last=today, topics=20/20`
 * we get 0.4·1 + 0.3·1 + 0.3·1 = 1.0. With `interactions=0, last=null,
 * topics=0` we get 0.0. Anything in between scales monotonically.
 */
export function computeRelationshipStrength(input: StrengthInput): number {
  const now = Date.now();

  // ── Interaction component (40%) ──────────────────────────────────────
  const lifetimeMs = input.firstMet
    ? Math.max(now - input.firstMet.getTime(), 86_400_000) // floor at 1 day
    : 30 * 86_400_000;
  const months = Math.max(1, lifetimeMs / (30 * 86_400_000));
  const ratePerMonth = input.interactionCount / months;
  const rateComponent = Math.min(1, ratePerMonth / INTERACTION_RATE_SATURATION);

  // ── Recency component (30%) ──────────────────────────────────────────
  let recencyComponent = 0;
  if (input.lastInteraction) {
    const ageDays = (now - input.lastInteraction.getTime()) / 86_400_000;
    if (ageDays <= 30) recencyComponent = 1;
    else if (ageDays <= 90) recencyComponent = 0.5;
    else recencyComponent = 0;
  }

  // ── Topic-diversity component (30%) ──────────────────────────────────
  const diversityComponent =
    input.topicCap > 0
      ? Math.min(1, input.topicCount / input.topicCap)
      : 0;

  const composite =
    0.4 * rateComponent + 0.3 * recencyComponent + 0.3 * diversityComponent;
  return Math.max(0, Math.min(1, composite));
}
