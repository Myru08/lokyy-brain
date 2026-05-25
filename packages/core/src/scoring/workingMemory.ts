import { backlinks } from "../graph/graphService.js";
import { retrievalCounts } from "./retrievalLog.js";
import { getScoring } from "./store.js";

/**
 * Phase B Wave B2 / Story 2 — Working-Memory + Spacing-Effect-Surfacing.
 *
 * Two brain-inspired recall mechanisms that share the same module because
 * both consume the retrieval-trace + scoring substrate Wave A1 laid down.
 *
 *   - WorkingMemory (this file): in-process, per-session cache of the last
 *     N retrieved notes. Provides a short-half-life boost on the *next*
 *     query so what you just thought about ranks higher — Baddeley &
 *     Hitch (1974) working-memory model in retrieval clothing.
 *
 *   - getSurfaceRecommendations: runtime computation of cold notes linked
 *     to currently-hot notes — Ebbinghaus' (1885) forgetting curve and
 *     Roediger & Karpicke's (2006) testing effect applied to a personal
 *     knowledge graph. Anki for your vault.
 *
 * Both are intentionally cheap. WorkingMemory is a Map<sessionId, Entry[]>;
 * no DB. Surface-recommendations are computed on demand and capped at
 * `MAX_HOT_NOTES` candidates to keep wall-clock bounded on big vaults.
 */

/** One in-memory record of "user opened noteId during sessionId at retrievedAt". */
export interface WorkingMemoryEntry {
  noteId: string;
  /** Unix-ms timestamp; we don't need Date here, just monotone arithmetic. */
  retrievedAt: number;
  sessionId: string;
  /** Snapshot of `options.boostStrength` at record-time — purely informational. */
  boost: number;
}

/** What a caller (ranker) consumes — a noteId paired with its computed boost. */
export interface WorkingMemoryBoost {
  noteId: string;
  /** [0..boostStrength] additive boost, decays exponentially. */
  boost: number;
  reason: "recent_retrieval" | "co_session";
}

/** All knobs are optional; defaults are tuned for a single-user dev vault. */
export interface WorkingMemoryOptions {
  /** Per-session ring-buffer size. Older entries are evicted FIFO. */
  maxEntriesPerSession?: number;
  /** LRU cap across sessions — keeps multi-tab usage from leaking memory. */
  maxSessions?: number;
  /** Half-life of the boost inside a session. After this many minutes, the
   *  boost halves; after 5× this, it's basically gone. */
  halfLifeMinutes?: number;
  /** Maximum boost added to retrieval scores at `retrievedAt`. */
  boostStrength?: number;
}

/**
 * In-process working memory — singleton per server process.
 *
 * IMPORTANT (process-locality): the underlying Map lives in Node heap. It
 * is NOT shared across server processes, NOT persisted, and NOT
 * cluster-aware. With a single-process server (the lokyy-brain default)
 * this is the right call: avoids a Redis dependency, latency is zero,
 * and a process restart simply clears working memory — which roughly
 * mirrors how humans wake up.
 *
 * If lokyy-brain ever runs behind a load balancer with multiple Node
 * workers, sticky-session routing on `sessionId` is sufficient — the
 * boost has no global consistency requirements.
 */
export class WorkingMemory {
  /** Insertion-ordered: Map preserves insertion order for LRU eviction. */
  private readonly bySession = new Map<string, WorkingMemoryEntry[]>();
  private readonly options: Required<WorkingMemoryOptions>;

  constructor(opts: WorkingMemoryOptions = {}) {
    this.options = {
      maxEntriesPerSession: opts.maxEntriesPerSession ?? 50,
      maxSessions: opts.maxSessions ?? 100,
      halfLifeMinutes: opts.halfLifeMinutes ?? 30,
      boostStrength: opts.boostStrength ?? 0.3,
    };
  }

  /**
   * Record a retrieval. Dedupes the same noteId — the second access wins
   * and resets the decay clock. Trims to `maxEntriesPerSession` (newest
   * first) and evicts the oldest session when over `maxSessions`.
   */
  record(noteId: string, sessionId: string): void {
    const now = Date.now();
    const entries = this.bySession.get(sessionId) ?? [];
    // Dedupe: drop any prior entry for this noteId so the new one is fresh.
    const filtered = entries.filter((e) => e.noteId !== noteId);
    filtered.unshift({
      noteId,
      retrievedAt: now,
      sessionId,
      boost: this.options.boostStrength,
    });
    if (filtered.length > this.options.maxEntriesPerSession) {
      filtered.length = this.options.maxEntriesPerSession;
    }
    // Re-insert to bump LRU order if the session already existed.
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, filtered);

    // LRU session eviction: Map iterates in insertion order, so the first
    // key is the least-recently-touched session.
    while (this.bySession.size > this.options.maxSessions) {
      const oldestKey = this.bySession.keys().next().value;
      if (!oldestKey) break;
      this.bySession.delete(oldestKey);
    }
  }

  /**
   * Compute boost values for the given candidate noteIds in the given
   * session. Only candidates that have a non-trivial boost (>0.01) are
   * returned. `now` is injectable for tests.
   *
   * Decay: `boost(t) = strength * 2^(-Δt / halfLife)`. Exponential, not
   * linear — same shape as the recency-decay component in importance.ts.
   */
  getBoosts(
    candidates: string[],
    sessionId: string,
    now: number = Date.now(),
  ): WorkingMemoryBoost[] {
    const entries = this.bySession.get(sessionId);
    if (!entries || entries.length === 0) return [];
    const halfLifeMs = this.options.halfLifeMinutes * 60_000;

    // Map for O(1) lookup; candidate list is the loop driver so we don't
    // emit boosts for notes the caller didn't ask about.
    const map = new Map<string, WorkingMemoryEntry>();
    for (const e of entries) map.set(e.noteId, e);

    const boosts: WorkingMemoryBoost[] = [];
    for (const noteId of candidates) {
      const e = map.get(noteId);
      if (!e) continue;
      const ageMs = Math.max(0, now - e.retrievedAt);
      const factor = Math.pow(2, -ageMs / halfLifeMs);
      const boost = this.options.boostStrength * factor;
      if (boost > 0.01) {
        boosts.push({ noteId, boost, reason: "recent_retrieval" });
      }
    }
    return boosts;
  }

  /** Clear one session (e.g. logout) or everything (e.g. test teardown). */
  clear(sessionId?: string): void {
    if (sessionId) this.bySession.delete(sessionId);
    else this.bySession.clear();
  }

  /** Total entries across all sessions — for telemetry / debug. */
  size(): number {
    let n = 0;
    for (const arr of this.bySession.values()) n += arr.length;
    return n;
  }

  /** Number of tracked sessions — for telemetry / debug. */
  sessionCount(): number {
    return this.bySession.size;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let _instance: WorkingMemory | null = null;

/** Process-wide singleton — one cache per server process. */
export function workingMemory(): WorkingMemory {
  if (!_instance) _instance = new WorkingMemory();
  return _instance;
}

/** Test seam — wipe the singleton between tests. */
export function _resetWorkingMemoryForTests(): void {
  _instance = null;
}

// ─── Spacing-Effect-Surfacing ────────────────────────────────────────────

/** One "you forgot this" candidate for the resurface pane. */
export interface SurfaceRecommendation {
  noteId: string;
  /** Higher = stronger signal. Currently = number of distinct hot links. */
  surfaceScore: number;
  /** Human-readable reasons, e.g. ["linked to 01H... (hot)", ...]. */
  reasons: string[];
}

/** Performance bound: cap the number of "hot" notes we expand from. */
const MAX_HOT_NOTES = 50;

/**
 * Compute cold-notes-linked-to-hot-notes on demand.
 *
 * Algorithm:
 *   1. retrievalCounts(hotDays) → notes accessed in the recent window,
 *      sorted by count desc.
 *   2. Take the top `MAX_HOT_NOTES` — bounds wall-clock for big vaults
 *      (backlinks() walks every .md file once per call).
 *   3. For each hot note, fetch backlinks; for each backlinker, look up
 *      its scoring row. If `lastAccessed` is older than `coldDays` (or
 *      missing), it's a surface candidate.
 *   4. Aggregate by backlinker noteId, sum scores, attach reasons.
 *
 * Notes:
 *   - This is intentionally runtime-only (no DB write). The spec calls
 *     out NOT writing to scoring sidecar columns that don't exist.
 *   - The sleep-agent pass (spacingEffectPass) calls into the same
 *     computation as a warm-up / smoke test, but does not persist either.
 */
export async function getSurfaceRecommendations(
  hotDays = 7,
  coldDays = 30,
  limit = 5,
): Promise<SurfaceRecommendation[]> {
  const hits = await retrievalCounts(hotDays);
  if (hits.length === 0) return [];

  // Cap hot-note expansion. Sorted desc by count via retrievalCounts.
  const hotNotes = hits.slice(0, MAX_HOT_NOTES);
  const hotIds = new Set(hotNotes.map((h) => h.noteId));

  const coldCutoffMs = Date.now() - coldDays * 86_400_000;
  const candidates = new Map<
    string,
    { score: number; reasons: string[] }
  >();

  for (const hot of hotNotes) {
    let back: Awaited<ReturnType<typeof backlinks>>;
    try {
      back = await backlinks(hot.noteId);
    } catch (err) {
      console.warn(
        `[workingMemory] backlinks(${hot.noteId}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    for (const bl of back) {
      // A backlinker that's itself a hot note isn't "forgotten" — skip.
      if (hotIds.has(bl.noteId)) continue;

      let scoring: Awaited<ReturnType<typeof getScoring>>;
      try {
        scoring = await getScoring(bl.noteId);
      } catch {
        scoring = null;
      }
      const lastAccessMs = scoring?.lastAccessed?.getTime() ?? 0;
      // Cold means: never touched (lastAccessMs === 0) OR touched before cutoff.
      if (lastAccessMs > coldCutoffMs) continue;

      const existing = candidates.get(bl.noteId) ?? {
        score: 0,
        reasons: [] as string[],
      };
      existing.score += 1;
      // Cap reasons to keep the payload small — top 3 reasons per candidate.
      if (existing.reasons.length < 3) {
        existing.reasons.push(`linked to ${hot.noteId}`);
      }
      candidates.set(bl.noteId, existing);
    }
  }

  return [...candidates.entries()]
    .map(([noteId, v]) => ({
      noteId,
      surfaceScore: v.score,
      reasons: v.reasons,
    }))
    .sort((a, b) => b.surfaceScore - a.surfaceScore)
    .slice(0, Math.max(0, limit));
}

/** Exposed for the sleep-agent pass to share the cap constant. */
export const SURFACE_MAX_HOT_NOTES = MAX_HOT_NOTES;
