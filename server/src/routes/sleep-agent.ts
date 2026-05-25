import { Hono } from "hono";
import { sleepAgent, type SleepPhase } from "@lokyy/core";

/**
 * Phase A Wave A2 / Story 7 — `/api/sleep-agent/*`.
 *
 *   POST /api/sleep-agent/trigger        { phase?: SleepPhase }   manual run
 *   GET  /api/sleep-agent/runs?limit=N                            recent runs
 *   GET  /api/sleep-agent/runs/:id                                one run
 *   POST /api/sleep-agent/cancel                                  mark cancelled
 *
 * `trigger` is always `"manual"` from this route — the scheduler owns
 * `"idle"` and `"nightly"`. A 409 is returned if another run is already
 * in-flight (the agent's idempotency guard throws synchronously).
 */
export const sleepAgentRoutes = new Hono();

const VALID_PHASES: ReadonlySet<SleepPhase> = new Set([
  "nrem",
  "rem",
  "lint",
  "dream",
  "manual",
]);

function isPhase(value: unknown): value is SleepPhase {
  return typeof value === "string" && VALID_PHASES.has(value as SleepPhase);
}

sleepAgentRoutes.post("/trigger", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const phase: SleepPhase = isPhase(body.phase) ? body.phase : "nrem";
  try {
    const run = await sleepAgent().runPhase(phase, "manual");
    return c.json(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "sleep-agent already running") {
      return c.json({ error: message }, 409);
    }
    return c.json({ error: message }, 500);
  }
});

sleepAgentRoutes.get("/runs", async (c) => {
  const raw = c.req.query("limit") ?? "20";
  const limit = Number(raw);
  const runs = await sleepAgent().listRecent(
    Number.isFinite(limit) ? limit : 20,
  );
  return c.json({ runs });
});

sleepAgentRoutes.get("/runs/:id", async (c) => {
  const id = c.req.param("id");
  const run = await sleepAgent().getRun(id);
  if (!run) return c.json({ error: "not found" }, 404);
  return c.json(run);
});

sleepAgentRoutes.post("/cancel", async (c) => {
  await sleepAgent().cancelCurrent();
  return c.json({ ok: true });
});
