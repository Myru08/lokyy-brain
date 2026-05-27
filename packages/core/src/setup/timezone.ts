import { eq } from "drizzle-orm";
import { database } from "../db/index.js";
import { systemConfig } from "../db/schema/systemConfig.js";

/**
 * Global display-timezone setting — persisted in `system_config` (KV) under
 * the single key `timezone`. Same pattern as `voice_defaults` and the
 * integration settings, but stores a bare IANA string (no JSON envelope).
 *
 * Why this exists: the deployment container clock stays UTC (best practice
 * for replication / logs / time-math), and all storage timestamps continue
 * to be ISO-8601 UTC. ONLY user-visible date rendering — voice-note title
 * patterns, daily-note names, future scheduling cron tokens — goes through
 * the configured timezone. Backward-compat: when no row exists OR the row
 * value is `UTC`, output is byte-identical to the legacy UTC-only renderer.
 *
 * Valid values are any IANA zone string accepted by `Intl.DateTimeFormat`
 * as its `timeZone` option (e.g. `Europe/Berlin`, `America/New_York`,
 * `Asia/Tokyo`, `UTC`, `Pacific/Auckland`). The validator is strict: it
 * runs the input through `new Intl.DateTimeFormat('en-US', { timeZone })`
 * and rejects anything that throws.
 *
 * Frontend convenience tip (not used backend-side): modern runtimes ship
 * `Intl.supportedValuesOf('timeZone')` which returns the full list of
 * accepted zones — perfect for populating a `<select>` of available zones
 * in the settings UI without bundling a tz database.
 */

export const TIMEZONE_KEY = "timezone";

/** Hardcoded fallback. Identical to the legacy UTC-only behavior. */
export const DEFAULT_TIMEZONE = "UTC";

/** Validation error surfaced by `validateTimezone`. */
export class TimezoneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimezoneValidationError";
  }
}

/**
 * Strict validator. Returns the trimmed input on success, throws
 * `TimezoneValidationError` otherwise. Accepts anything that the runtime's
 * `Intl.DateTimeFormat` accepts as `timeZone` — no allow-list, no regex.
 * That's deliberate: IANA's tz database grows over time, and any zone the
 * Node runtime recognises is safe to use.
 */
export function validateTimezone(input: unknown): string {
  if (typeof input !== "string") {
    throw new TimezoneValidationError("timezone must be a string");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new TimezoneValidationError("timezone must not be empty");
  }
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    throw new TimezoneValidationError(
      `'${trimmed}' is not a recognized IANA timezone (try e.g. 'Europe/Berlin', 'America/New_York', 'UTC')`,
    );
  }
  return trimmed;
}

/**
 * Read the persisted display timezone. Falls back to `DEFAULT_TIMEZONE`
 * (`UTC`) when no row exists OR the stored value is no longer recognized
 * (e.g. tzdata downgrade between deploys). A stored-but-invalid value
 * never causes a request to fail — the caller silently gets UTC.
 */
export async function getTimezone(): Promise<string> {
  const rows = await database()
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, TIMEZONE_KEY))
    .limit(1);
  const raw = rows[0]?.valueText;
  if (typeof raw !== "string" || !raw.trim()) {
    return DEFAULT_TIMEZONE;
  }
  try {
    return validateTimezone(raw);
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Persist the timezone. Validates strictly first; on success upserts the
 * row and returns the canonical stored value.
 */
export async function setTimezone(value: unknown): Promise<string> {
  const validated = validateTimezone(value);
  const db = database();
  const existing = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, TIMEZONE_KEY))
    .limit(1);
  if (existing[0]) {
    await db
      .update(systemConfig)
      .set({ valueText: validated, updatedAt: new Date() })
      .where(eq(systemConfig.key, TIMEZONE_KEY));
  } else {
    await db.insert(systemConfig).values({
      key: TIMEZONE_KEY,
      valueText: validated,
    });
  }
  return validated;
}

/**
 * Date-parts in a target timezone, formatted as zero-padded strings ready
 * for direct token substitution. Hour cycle is `h23` (00–23) so the `{HH}`
 * token never produces `24`. Pure function, no DB / IO.
 *
 * Backward-compat invariant: passing `timezone = "UTC"` produces values
 * byte-identical to the legacy `utcParts(d)` helper in `voiceHandler.ts`.
 */
export interface DateParts {
  YYYY: string;
  MM: string;
  DD: string;
  HH: string;
  mm: string;
}

export function getDateParts(d: Date, timezone: string): DateParts {
  // `formatToParts` is the only `Intl` API that gives us numeric components
  // with stable types. We force English so `dayPeriod` etc. never shows up
  // and the part `type` strings stay predictable across locales.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") lookup[p.type] = p.value;
  }
  // `hour` can come back as `"24"` on some older ICU builds despite
  // hourCycle: 'h23' — normalize defensively.
  const hh = lookup.hour === "24" ? "00" : (lookup.hour ?? "00");
  return {
    YYYY: lookup.year ?? "0000",
    MM: lookup.month ?? "00",
    DD: lookup.day ?? "00",
    HH: hh,
    mm: lookup.minute ?? "00",
  };
}
