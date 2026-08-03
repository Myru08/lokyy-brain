import { Hono } from "hono";
import {
  TimezoneValidationError,
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
