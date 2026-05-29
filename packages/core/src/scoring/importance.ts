import type { DocType } from "../frontmatter/index.js";

/**
 * Phase A Wave A1 / Story 1 — pure scoring functions.
 *
 * Composite formula:
 *
 *   importance = 0.30 * origin_score(type)
 *              + 0.30 * recency_decay
 *              + 0.20 * log(1 + incoming_backlinks) / log(1 + 50)
 *              + 0.10 * userTouchSignal     // (views + 2*edits) / 50, capped at 1
 *              + 0.10 * coCitationStrength  // coCitationMax / 20, capped at 1
 *
 * Recency uses Anderson & Schooler's power-law decay:
 *
 *   recency = 1 / (1 + (age_days / half_life) ^ 1.2)
 *
 * age_days is measured from MAX(updated, lastAccessed). lastAccessed is
 * reset whenever the note is opened, edited, or gains a new incoming
 * wikilink — so engagement and structural relevance both rejuvenate the
 * score. The sleep-agent NREM phase recomputes nightly; nothing here
 * touches I/O.
 */

export interface ImportanceSignals {
  /** Doc type drives both origin score and half-life. */
  type: DocType;
  /** Frontmatter `updated` timestamp. */
  updated: Date;
  /** Last touch (open / edit / new incoming link). Undefined for fresh notes. */
  lastAccessed?: Date;
  /** Count of incoming wikilinks at signal-collection time. */
  incomingBacklinks: number;
  /** Cumulative view count. */
  viewCount: number;
  /** Cumulative edit count. */
  editCount: number;
  /** Highest co-citation count with any single other note. */
  coCitationMax: number;
}

/**
 * Per-DocType origin score on [0..1]. Decisions and projects anchor the
 * vault (1.0); captures are raw inbox noise until promoted (0.3).
 */
export const ORIGIN_SCORES: Record<DocType, number> = {
  decision: 1.0,
  project: 1.0,
  note: 0.8,
  meeting: 0.7,
  customer: 0.7,
  // Peer-notes anchor relationships like customer notes do; the relationship
  // is itself the load-bearing asset. Same baseline (0.7) so a peer-note
  // ranks alongside customer/meeting evidence in retrieval.
  peer: 0.7,
  workflow: 0.5,
  task: 0.5,
  intervention: 0.6,
  content: 0.6,
  // Skill-notes are reusable structural definitions, peers to workflows.
  skill: 0.5,
  // Epic 10 / Story 10.15 — extended type enum.
  //   tool      0.6 — durable utility records, between workflow and note.
  //   resource  0.5 — captured external material, above raw capture noise.
  //   reference 0.6 — durable lookup material, like content/intervention.
  tool: 0.6,
  resource: 0.5,
  reference: 0.6,
  capture: 0.3,
};

/**
 * Half-life in days per DocType for the power-law decay. The half-life
 * is the point where recency_decay drops below 0.5 — it's a "this kind
 * of note stays relevant for ~X days" knob.
 */
export const HALF_LIFE_DAYS: Record<DocType, number> = {
  decision: 720,
  project: 540,
  customer: 365,
  // A peer-relationship persists like a customer relationship — long half-
  // life so an inactive contact doesn't get prematurely decayed out of
  // retrieval before the next nightly relationship_strength recompute.
  peer: 365,
  note: 180,
  meeting: 90,
  capture: 30,
  workflow: 365,
  task: 90,
  intervention: 365,
  content: 180,
  // Skill-notes stay relevant as long as workflows — they are durable
  // reusable definitions, not time-bound content.
  skill: 365,
  // Epic 10 / Story 10.15 — extended type enum.
  //   tool      365 — durable utility records, like workflows.
  //   resource  180 — captured material, like content; longer than raw capture.
  //   reference 365 — durable lookup material, long-lived like workflows.
  tool: 365,
  resource: 180,
  reference: 365,
};

/** Power-law decay exponent (Anderson & Schooler). */
const DECAY_EXPONENT = 1.2;

/** Backlink saturation point — at 50 incoming links the term hits 1.0. */
const BACKLINK_SATURATION = 50;

/** User-touch saturation point — at (views + 2*edits) = 50 the term hits 1.0. */
const USER_SIGNAL_SATURATION = 50;

/** Co-citation saturation point — at coCitationMax = 20 the term hits 1.0. */
const CO_CITATION_SATURATION = 20;

const WEIGHT_ORIGIN = 0.3;
const WEIGHT_RECENCY = 0.3;
const WEIGHT_BACKLINKS = 0.2;
const WEIGHT_USER = 0.1;
const WEIGHT_COCITE = 0.1;

const MS_PER_DAY = 86_400_000;

/** Origin score for a doc type. Pure lookup. */
export function originScore(type: DocType): number {
  return ORIGIN_SCORES[type];
}

/**
 * Anderson & Schooler power-law recency decay. Returns a value in (0, 1].
 *
 * `base = MAX(updated, lastAccessed)` — whichever event was more recent
 * is what "rejuvenates" the note.
 */
export function recencyDecay(
  updated: Date,
  lastAccessed: Date | undefined,
  type: DocType,
  now: Date = new Date(),
): number {
  const base =
    lastAccessed !== undefined && lastAccessed.getTime() > updated.getTime()
      ? lastAccessed
      : updated;
  const ageMs = now.getTime() - base.getTime();
  const ageDays = Math.max(0, ageMs / MS_PER_DAY);
  const halfLife = HALF_LIFE_DAYS[type];
  return 1 / (1 + Math.pow(ageDays / halfLife, DECAY_EXPONENT));
}

/**
 * Compute the composite importance score in [0..1] from current signals.
 * Pure function — caller is responsible for fetching the signals.
 */
export function computeImportance(
  signals: ImportanceSignals,
  now: Date = new Date(),
): number {
  const origin = originScore(signals.type);
  const recency = recencyDecay(
    signals.updated,
    signals.lastAccessed,
    signals.type,
    now,
  );
  const backlinks =
    Math.log(1 + Math.max(0, signals.incomingBacklinks)) /
    Math.log(1 + BACKLINK_SATURATION);
  const userSignal = Math.min(
    1,
    (Math.max(0, signals.viewCount) + Math.max(0, signals.editCount) * 2) /
      USER_SIGNAL_SATURATION,
  );
  const coCite = Math.min(
    1,
    Math.max(0, signals.coCitationMax) / CO_CITATION_SATURATION,
  );

  return (
    WEIGHT_ORIGIN * origin +
    WEIGHT_RECENCY * recency +
    WEIGHT_BACKLINKS * backlinks +
    WEIGHT_USER * userSignal +
    WEIGHT_COCITE * coCite
  );
}
