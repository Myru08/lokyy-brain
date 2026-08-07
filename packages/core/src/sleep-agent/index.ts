import { ulid } from "ulid";
import { desc, eq } from "drizzle-orm";

import { database } from "../db/index.js";
import {
  sleepAgentRuns,
  type SleepAgentRunRow,
} from "../db/schema/sleepAgentRuns.js";
import { importanceRecomputePass } from "./passes/importanceRecompute.js";
import { spacingEffectPass } from "./passes/spacingEffect.js";
import { topicSynthesisPass } from "./passes/topicSynthesis.js";
import { mem0ClassifierPass } from "./passes/mem0Classifier.js";
import { synapticPruningPass } from "./passes/synapticPruning.js";
import { lintPass } from "./passes/lint.js";
import { entityExtractionPass } from "./passes/entityExtraction.js";
import { biTemporalValidationPass } from "./passes/biTemporalValidation.js";
import { peerProfileUpdatePass } from "./passes/peerProfileUpdate.js";
import { ulidBackfillPass } from "./passes/ulidBackfill.js";
import type {
  SleepPass,
  SleepPhase,
  SleepRun,
  SleepStatus,
  SleepTrigger,
} from "./types.js";

/**
 * Phase A Wave A2 / Story 7 — Sleep-Agent walking skeleton.
 *
 * Three jobs:
 *   1. Run a sleep phase end-to-end (`runPhase`) → executes every pass
 *      whose `phases` contains the requested phase, persists per-pass
 *      stats, never lets one pass's failure abort the next.
 *   2. Idempotency / mutual exclusion: only one run at a time per
 *      process, scheduler timers no-op while a run is active.
 *   3. Schedule those runs (`startScheduler`) on a 30-min idle NREM
 *      interval plus a daily 03:00 nightly REM run. The scheduler is
 *      best-effort and MUST NOT block server startup if the DB is
 *      temporarily unavailable.
 *
 * Later stories append passes to `ALL_PASSES` without changing this
 * orchestrator.
 */

const ALL_PASSES: SleepPass[] = [
  importanceRecomputePass,
  spacingEffectPass,
  topicSynthesisPass,
  mem0ClassifierPass,
  synapticPruningPass,
  lintPass,
  entityExtractionPass,
  biTemporalValidationPass,
  // Phase C Wave C2 / Story 3 — Honcho-style peer-profile-update.
  // REM-phase pass; refreshes relationship_strength + ongoing_topics +
  // last_interaction from entity_mentions for every `type: peer` note.
  peerProfileUpdatePass,
  // Phase D Wave D1 / Story 1 — ULID-Backfill for legacy notes.
  // NREM-phase pass; picks up to 50 ULID-less notes per run, injects an
  // id + type + updated frontmatter and writes back via saveNote (which
  // commits, syncs BM25, refreshes temporal-edges, drops the ULID cache).
  ulidBackfillPass,
  // Future: multiChunkReEmbedPass, multiTraceConsolidationPass, …
];

const TERMINAL_STATUSES: ReadonlySet<SleepStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

function isSleepStatus(value: string): value is SleepStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isSleepPhase(value: string): value is SleepPhase {
  return (
    value === "nrem" ||
    value === "rem" ||
    value === "lint" ||
    value === "dream" ||
    value === "manual"
  );
}

function isSleepTrigger(value: string): value is SleepTrigger {
  return value === "idle" || value === "nightly" || value === "manual";
}

/** Map a Drizzle row back to the runtime `SleepRun` shape. */
function rowToRun(row: SleepAgentRunRow): SleepRun {
  return {
    id: row.id,
    phase: isSleepPhase(row.phase) ? row.phase : "manual",
    trigger: isSleepTrigger(row.trigger) ? row.trigger : "manual",
    status: isSleepStatus(row.status) ? row.status : "failed",
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    passesCompleted: row.passesCompleted ?? [],
    passStats:
      row.passStats && typeof row.passStats === "object"
        ? (row.passStats as Record<string, unknown>)
        : {},
    errorMessage: row.errorMessage ?? undefined,
    notesProcessed: row.notesProcessed,
  };
}

export class SleepAgent {
  private running = false;
  private currentRunId: string | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private nightlyTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Run all passes registered for `phase`. Idempotent: throws if another
   * run is already in-flight in this process. Per-pass exceptions are
   * captured in `passStats[passName].error` and do NOT abort the run.
   */
  async runPhase(phase: SleepPhase, trigger: SleepTrigger): Promise<SleepRun> {
    if (this.running) {
      throw new Error("sleep-agent already running");
    }
    this.running = true;

    const run: SleepRun = {
      id: ulid(),
      phase,
      trigger,
      status: "running",
      startedAt: new Date(),
      passesCompleted: [],
      passStats: {},
      notesProcessed: 0,
    };
    this.currentRunId = run.id;

    const db = database();
    await db.insert(sleepAgentRuns).values({
      id: run.id,
      phase: run.phase,
      trigger: run.trigger,
      status: run.status,
      startedAt: run.startedAt,
      passesCompleted: run.passesCompleted,
      passStats: run.passStats,
      notesProcessed: run.notesProcessed,
    });

    try {
      const passes = ALL_PASSES.filter((p) => p.phases.includes(phase));
      for (const pass of passes) {
        try {
          const result = await pass.run(run);
          run.passesCompleted.push(pass.name);
          run.passStats[pass.name] = result;
          run.notesProcessed += result.processed;
        } catch (err) {
          run.passStats[pass.name] = {
            error: err instanceof Error ? err.message : String(err),
          };
          console.warn(
            `[sleep-agent] pass "${pass.name}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      run.status = "completed";
    } catch (err) {
      run.status = "failed";
      run.errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      run.finishedAt = new Date();
      try {
        await db
          .update(sleepAgentRuns)
          .set({
            status: run.status,
            finishedAt: run.finishedAt,
            passesCompleted: run.passesCompleted,
            passStats: run.passStats,
            notesProcessed: run.notesProcessed,
            errorMessage: run.errorMessage ?? null,
          })
          .where(eq(sleepAgentRuns.id, run.id));
      } catch (err) {
        console.warn(
          `[sleep-agent] failed to persist run ${run.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.currentRunId = null;
      this.running = false;
    }

    return run;
  }

  /**
   * Arm both timers. Idle = recurring `setInterval` (default 30 min) that
   * fires an NREM run if and only if no run is currently active. Nightly
   * = a self-rescheduling `setTimeout` that targets the next `nightlyHour`
   * local time (default 03:00) and re-arms itself for the following day.
   */
  startScheduler(opts: { idleMinutes?: number; nightlyHour?: number } = {}): void {
    const idleMin = opts.idleMinutes ?? 30;
    const nightlyHour = opts.nightlyHour ?? 3;

    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.nightlyTimer) clearTimeout(this.nightlyTimer);

    this.idleTimer = setInterval(() => {
      if (this.running) return;
      void this.runPhase("nrem", "idle").catch((err) => {
        console.warn(
          `[sleep-agent] idle run failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, idleMin * 60_000);
    // Don't keep the event loop alive just for the scheduler — process
    // exit should not be blocked by the next tick.
    if (typeof this.idleTimer === "object" && this.idleTimer !== null) {
      const t = this.idleTimer as { unref?: () => void };
      t.unref?.();
    }

    this.scheduleNightly(nightlyHour);
  }

  /** Disarm both timers. Safe to call from any state. */
  stopScheduler(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.nightlyTimer) clearTimeout(this.nightlyTimer);
    this.idleTimer = null;
    this.nightlyTimer = null;
  }

  /**
   * Schedule the next nightly run for `hour:00` local time. The next run
   * always recomputes "tomorrow at hour" from a fresh `new Date()` — this
   * is why DST transitions don't drift the schedule: we never accumulate
   * an offset, we always re-anchor to wall-clock time.
   *
   * The nightly slot runs REM, not NREM. The idle timer already fires NREM
   * every 30 min, so a nightly NREM would repeat work that just ran — while
   * REM would never fire at all without a manual trigger. REM carries the
   * passes that actually build connections (entity-extraction,
   * topic-synthesis, mem0-classifier, peer-profile-update), and
   * `mem0Classifier` only considers notes touched within the last 24 h
   * (`RECENT_WINDOW_MS`). Anything less than a daily cadence therefore drops
   * notes silently and permanently — they never become candidates again.
   */
  private scheduleNightly(hour: number): void {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const ms = Math.max(0, next.getTime() - now.getTime());
    this.nightlyTimer = setTimeout(() => {
      if (!this.running) {
        void this.runPhase("rem", "nightly").catch((err) => {
          console.warn(
            `[sleep-agent] nightly run failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
      // Re-anchor for the next calendar day, even if the run skipped.
      this.scheduleNightly(hour);
    }, ms);
    if (typeof this.nightlyTimer === "object" && this.nightlyTimer !== null) {
      const t = this.nightlyTimer as { unref?: () => void };
      t.unref?.();
    }
  }

  /** Recent runs, newest first. */
  async listRecent(limit = 20): Promise<SleepRun[]> {
    const safeLimit = Math.max(
      1,
      Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 20),
    );
    const rows = await database()
      .select()
      .from(sleepAgentRuns)
      .orderBy(desc(sleepAgentRuns.startedAt))
      .limit(safeLimit);
    return rows.map(rowToRun);
  }

  /** Fetch a single run by id, or null if no row exists. */
  async getRun(id: string): Promise<SleepRun | null> {
    const rows = await database()
      .select()
      .from(sleepAgentRuns)
      .where(eq(sleepAgentRuns.id, id))
      .limit(1);
    const row = rows[0];
    return row ? rowToRun(row) : null;
  }

  /**
   * Cancel any in-flight run by marking its DB row `cancelled`. The
   * actively executing pass is NOT interrupted (passes don't take a
   * cancellation token in Story 7); the running flag will flip back to
   * `false` once the pass returns. This is intentional — best-effort
   * cancellation for the walking skeleton, real cooperative cancellation
   * lands when LLM passes are introduced.
   */
  async cancelCurrent(): Promise<void> {
    const id = this.currentRunId;
    if (!id) return;
    const db = database();
    await db
      .update(sleepAgentRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(sleepAgentRuns.id, id));
  }

  /** Test/inspection helper — true while a run is in-flight in this process. */
  isRunning(): boolean {
    return this.running;
  }
}

let _instance: SleepAgent | null = null;

/** Process-wide singleton — one scheduler per server process. */
export function sleepAgent(): SleepAgent {
  if (!_instance) _instance = new SleepAgent();
  return _instance;
}

/** Test seam — drops the singleton so a fresh agent boots next time. */
export function _resetSleepAgentForTests(): void {
  if (_instance) _instance.stopScheduler();
  _instance = null;
}

export { TERMINAL_STATUSES };
export * from "./types.js";
