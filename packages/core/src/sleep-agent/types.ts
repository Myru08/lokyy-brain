/**
 * Phase A Wave A2 / Story 7 — Sleep-Agent type surface.
 *
 * Walking-skeleton: a SleepRun is a chain of SleepPasses bound to a phase.
 * Story 7 ships only `importance-recompute` in phase `nrem`; later stories
 * append re-embed, multi-trace consolidation, synaptic pruning, topic
 * synthesis, and lint without changing this shape.
 */

/** Phases roughly mirror the human sleep cycle — see SleepAgent docs. */
export type SleepPhase = "nrem" | "rem" | "lint" | "dream" | "manual";

/** What kicked the run off. `manual` = explicit API trigger. */
export type SleepTrigger = "idle" | "nightly" | "manual";

/** Lifecycle status — single transition path enforced by the scheduler. */
export type SleepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * One execution of the sleep-agent. Mirrors the `sleep_agent_runs` row,
 * but with `Date` instead of timestamptz strings and a narrower type on
 * `passStats`. The agent keeps the running record in memory and flushes
 * it to the DB on terminal transitions.
 */
export interface SleepRun {
  /** ULID, set by the agent before INSERT. */
  id: string;
  phase: SleepPhase;
  trigger: SleepTrigger;
  status: SleepStatus;
  startedAt: Date;
  /** Set on completed/failed/cancelled, undefined while running. */
  finishedAt?: Date;
  /** Names of passes that succeeded for this run (order = exec order). */
  passesCompleted: string[];
  /** Per-pass result payload — see SleepPass.run return shape. */
  passStats: Record<string, unknown>;
  /** Populated when `status === "failed"`. */
  errorMessage?: string;
  /** Sum of `processed` counts across all passes that succeeded. */
  notesProcessed: number;
}

/** Result of one pass execution; aggregated into SleepRun.notesProcessed. */
export interface SleepPassResult {
  processed: number;
  errors: number;
  /**
   * Optional free-form diagnostic string persisted alongside the counts in
   * `sleep_agent_runs.passStats[passName].notes`. Useful for passes whose
   * "what happened" can't be reduced to a single integer — e.g. the
   * topic-synthesis pass writes the cluster count and graph modularity here
   * so post-hoc inspection doesn't require re-running the algorithm.
   */
  notes?: string;
}

/**
 * A single sleep-agent pass. Pure-ish: receives the running SleepRun
 * record for context (it MAY read `passesCompleted` / `passStats` from
 * prior passes in the same run) but must NOT mutate `status` /
 * `startedAt` / `finishedAt` — those are owned by the SleepAgent.
 *
 * `phases` declares which SleepPhase(s) include this pass; the agent
 * runs the union of all passes whose `phases` contains the requested
 * phase, in registration order.
 */
export interface SleepPass {
  /** Stable, lower-kebab name. Used as the key in `pass_stats`. */
  name: string;
  /** Run one pass; the agent persists the returned counts. */
  run(run: SleepRun): Promise<SleepPassResult>;
  /** Phases this pass participates in. */
  phases: SleepPhase[];
}
