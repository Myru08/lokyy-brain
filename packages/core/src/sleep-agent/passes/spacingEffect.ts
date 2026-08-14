import { getSurfaceRecommendations } from "../../scoring/workingMemory.js";
import { createPassErrorLog } from "../errorSamples.js";
import type { SleepPass, SleepPassResult } from "../types.js";

/**
 * Phase B Wave B2 / Story 2 — Spacing-Effect-Surfacing sleep pass.
 *
 * The actual computation lives in `scoring/workingMemory.ts`'s
 * `getSurfaceRecommendations` — that function is also what the route
 * returns on demand. This pass exists for two reasons:
 *
 *   1. Warm-up: run the computation during NREM/REM so any expensive
 *      `backlinks()` traversal happens off the request path. The result
 *      is intentionally NOT persisted (the spec says cold-notes-linked-
 *      to-hot-notes stays runtime-computed — there's no DB column for
 *      "surface_recommendation" and adding one would be premature).
 *
 *   2. Observability: by running inside the sleep-agent, the count of
 *      surfaced notes shows up in `sleep_agent_runs.passStats` so we can
 *      see if surfacing is firing at all without inspecting HTTP traffic.
 *
 * Performance bound: `getSurfaceRecommendations` caps at the top-50 hot
 * notes per run (see `SURFACE_MAX_HOT_NOTES`). For each hot note we walk
 * the vault once (backlinks() reads every .md), so the worst case is
 * ~50 × vault-size file reads. On a ~5k-note vault that's still well
 * under a second; for huge vaults we can later add a graph cache.
 *
 * Errors inside `getSurfaceRecommendations` already log + swallow per-hot
 * iteration; this pass adds an outer try/catch so a catastrophic failure
 * (e.g. DB down) just records `errors: 1` instead of aborting the run.
 *
 * #58 note: this pass has exactly one failure mode and it is pass-wide by
 * construction — the per-hot-note failures never surface here (the callee
 * swallows them), so there is no note id to attribute. Hence the sole sample
 * is pass-scoped. Making the per-hot failures visible means changing
 * `getSurfaceRecommendations`, which is out of this pass's reach.
 */
export const spacingEffectPass: SleepPass = {
  name: "spacing-effect-surfacing",
  phases: ["nrem", "rem"],
  async run(): Promise<SleepPassResult> {
    const errors = createPassErrorLog();
    try {
      const recs = await getSurfaceRecommendations(7, 30, 25);
      return errors.result(recs.length);
    } catch (err) {
      console.warn(
        `[sleep-agent] spacing-effect-surfacing failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      errors.recordPassScoped(err);
      return errors.result(0);
    }
  },
};
