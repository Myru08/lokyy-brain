import { Hono } from "hono";
import {
  TimezoneValidationError,
  forceUpdateCheck,
  getTimezone,
  getUpdateStatus,
  setTimezone,
} from "@lokyy/core";
import { systemUpdateRoutes } from "./systemUpdate.js";

/**
 * `/api/system/*` — global system-level settings.
 *
 * Currently:
 *   GET  /timezone   → `{ timezone: string }`  (IANA, default `UTC`)
 *   PUT  /timezone   → `{ timezone: string }`  validates strictly via Intl,
 *                      persists, returns the canonical stored value.
 *   GET  /version    → running build version + update-check result (7.12)
 *   /update/*        → update execution — `requireAdmin`, see systemUpdate.ts
 *
 * Same auth posture as `/api/voice/settings`: behind `setupGate` only, no
 * extra auth gate today. When other system settings need a stricter gate,
 * we move them together. The exception is `/update/*`, which brings its own
 * `requireAdmin` — reading a version is public, executing an update is not.
 */
export const systemRoutes = new Hono();

/**
 * Story 7.12 — identity of the running build plus the cached update-check
 * result: `{ running, buildSha, latest, updateAvailable, highlights,
 * checkedAt, status }`.
 *
 * Reads ONLY from the in-memory cache (warmed once at startup, refreshed in
 * the background when older than 6 h), so this handler never waits on the
 * network — AC#3 forbids a blocking request in the UI path. A failed or
 * disabled check simply yields `updateAvailable: false`.
 *
 * Intentionally NOT behind `requireAdmin`: the PWA compares its own build
 * version against `running` to detect a stale cache, which happens before any
 * role is known. The response carries no secrets — a version string and
 * public changelog lines. Admin-gating belongs on the update EXECUTION
 * endpoints (AC#10), not on reading a version number.
 */
systemRoutes.get("/version", (c) => c.json(getUpdateStatus()));

/**
 * „Jetzt prüfen" — force a check right now, ignoring the 6 h cache, and answer
 * with the fresh `UpdateCheckResult`. The result is written back into the
 * shared cache, so the banner picks it up from the very next `GET /version`.
 *
 * Unlike `GET /version` this one DOES wait on the network — that is the whole
 * point of a button — but `forceUpdateCheck` keeps the hard budget (5 s
 * timeout, at most one retry), so the worst case is bounded.
 *
 * Rate limit (AC#2): at most one real fetch per 30 s. Deliberately **200 with
 * the cached result** plus `throttled: true` and a `Retry-After` header, NOT a
 * 429. Rationale: clicking twice is not a client error, and a red error state
 * for a version check contradicts the module's rule that a check which cannot
 * run is a non-event. The payload stays truthful — a cached result at most
 * 30 s old — and `throttled` lets a caller say "gerade eben geprüft" instead
 * of inventing a failure.
 *
 * Not admin-gated, exactly like `GET /version`: it reads a public changelog
 * and returns no secrets. Update EXECUTION stays behind `requireAdmin`.
 */
systemRoutes.post("/version/check", async (c) => {
  const { result, throttled, retryAfterSeconds } = await forceUpdateCheck();
  if (throttled) {
    c.header("Retry-After", String(retryAfterSeconds));
  }
  return c.json({ ...result, throttled, retryAfterSeconds });
});

/**
 * Story 7.12 Task 4 — update EXECUTION, admin-only (AC#10):
 *   GET  /api/system/update       → capability (`canUpdate` + reason)
 *   POST /api/system/update       → start a job
 *   GET  /api/system/update/:id   → phase + log tail
 */
systemRoutes.route("/update", systemUpdateRoutes);

systemRoutes.get("/timezone", async (c) => {
  const timezone = await getTimezone();
  return c.json({ timezone });
});

systemRoutes.put("/timezone", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: "invalid-json",
        message: "Body must be valid JSON",
      },
      400,
    );
  }
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("timezone" in (body as Record<string, unknown>))
  ) {
    return c.json(
      {
        error: "invalid-timezone",
        message: "Body must be { timezone: string }",
      },
      400,
    );
  }
  const requested = (body as Record<string, unknown>).timezone;
  try {
    const stored = await setTimezone(requested);
    return c.json({ timezone: stored });
  } catch (err) {
    if (err instanceof TimezoneValidationError) {
      return c.json(
        {
          error: "invalid-timezone",
          message: err.message,
        },
        400,
      );
    }
    return c.json(
      {
        error: "persist-failed",
        message: err instanceof Error ? err.message : "persist failed",
      },
      500,
    );
  }
});
