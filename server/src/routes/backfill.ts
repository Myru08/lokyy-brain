import { Hono } from "hono";
import {
  getNote,
  listNotes,
  parseFrontmatter,
  sleepAgent,
} from "@lokyy/core";

/**
 * Phase D Wave D1 / Story 1 — `/api/backfill/*`.
 *
 *   POST /api/backfill/ulid     manual trigger for the ulid-backfill pass
 *                               (delegates to sleepAgent.runPhase("nrem")
 *                               so the existing idempotency guard + run-
 *                               persistence flow applies — including the
 *                               409 "already running" surface).
 *   GET  /api/backfill/status   how many notes still lack a ULID (capped
 *                               at the first 500 to keep the status call
 *                               cheap; the pass itself walks the whole
 *                               vault but at most 50 commits per run).
 *
 * Mounted at `/api/backfill` behind `setupGate` in `server/src/index.ts`.
 *
 * The status endpoint reads frontmatter for up to 500 notes — that's a
 * full read pass against gitService, so callers should not poll faster
 * than a few times per minute. The PWA Settings page calls it once on
 * mount + once after a manual trigger.
 */
export const backfillRoutes = new Hono();

/** Hard cap on how many notes status scans — bounds the response time. */
const STATUS_SCAN_LIMIT = 500;

backfillRoutes.post("/ulid", async (c) => {
  try {
    // NREM phase runs every NREM pass including ulid-backfill. Importance-
    // recompute / synaptic-pruning / etc. are cheap-or-idempotent so this
    // is safe — and we get the standard run-row in `sleep_agent_runs` for
    // observability.
    const run = await sleepAgent().runPhase("nrem", "manual");
    return c.json({ ok: true, run });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "sleep-agent already running") {
      return c.json({ ok: false, error: message }, 409);
    }
    return c.json({ ok: false, error: message }, 500);
  }
});

backfillRoutes.get("/status", async (c) => {
  try {
    const all = await listNotes();
    let scanned = 0;
    let withoutUlid = 0;
    for (const summary of all) {
      if (scanned >= STATUS_SCAN_LIMIT) break;
      scanned++;
      const full = await getNote(summary.id).catch(() => null);
      if (!full?.body) continue;
      const parsed = parseFrontmatter(full.body);
      const fmId = parsed.data.id;
      if (typeof fmId !== "string" || fmId.length === 0) {
        withoutUlid++;
      }
    }
    return c.json({
      totalNotes: all.length,
      scanned,
      withoutUlid,
      scanLimited: all.length > STATUS_SCAN_LIMIT,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});
