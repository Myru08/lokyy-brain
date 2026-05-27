import { Hono } from "hono";
import {
  TimezoneValidationError,
  getTimezone,
  setTimezone,
} from "@lokyy/core";

/**
 * `/api/system/*` — global system-level settings.
 *
 * Currently:
 *   GET  /timezone   → `{ timezone: string }`  (IANA, default `UTC`)
 *   PUT  /timezone   → `{ timezone: string }`  validates strictly via Intl,
 *                      persists, returns the canonical stored value.
 *
 * Same auth posture as `/api/voice/settings`: behind `setupGate` only, no
 * extra auth gate today. When other system settings need a stricter gate,
 * we move them together.
 */
export const systemRoutes = new Hono();

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
