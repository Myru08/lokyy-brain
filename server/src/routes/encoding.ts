import { Hono } from "hono";
import {
  applyContextBoost,
  captureEncodingContext,
  contextMatchBoost,
  timeOfDayFrom,
  weekdayFrom,
  type CaptureContextInput,
  type ContextMatchResult,
  type DeviceType,
  type EncodedContext,
  type QueryContext,
  type ScoredHit,
  type TimeOfDay,
  type Weekday,
} from "@lokyy/core";

/**
 * /api/encoding — Phase B Wave B3 / Story 1 (Tulving 1973).
 *
 * Two endpoints:
 *
 *   POST /api/encoding/capture       — derive a fresh `EncodedContext` from
 *                                       request headers + caller-supplied
 *                                       session shape (preceding-notes,
 *                                       session-duration, …).
 *
 *   POST /api/encoding/match-boost   — given a list of scored hits + a
 *                                       query-context, returns the hits
 *                                       re-sorted by the context-boosted
 *                                       score with per-field explanations.
 *
 * Both are pure-compute (no DB, no git) — safe to call from anywhere. The
 * `capture` route is also used by the PWA / pipe handlers when they want
 * the server to assemble the encoded block instead of doing it client-side.
 */
export const encodingRoutes = new Hono();

/** Valid `DeviceType` values, mirrors the union in @lokyy/core. */
const DEVICE_VALUES = new Set<DeviceType>([
  "laptop",
  "desktop",
  "mobile",
  "tablet",
  "api",
  "mcp",
]);

const TIME_OF_DAY_VALUES = new Set<TimeOfDay>([
  "morning",
  "midday",
  "evening",
  "night",
]);

const WEEKDAY_VALUES = new Set<Weekday>([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

/**
 * Heuristic device detection from a User-Agent header.
 *
 * Order matters: mobile keywords come BEFORE tablet keywords because most
 * tablet UAs also carry "Mobile" in the string. We check tablet-specific
 * markers (`iPad`, `Tablet`) first to break the tie. Desktop OS markers
 * land in `"laptop"` — the distinction laptop-vs-desktop is invisible to
 * a UA string, so we lump them under `"laptop"` (the more common case
 * in this project's userbase). Server-side / scripted callers without
 * a UA header default to `"api"`.
 */
export function deviceFromUserAgent(ua: string | undefined | null): DeviceType {
  if (!ua) return "api";
  const lower = ua.toLowerCase();
  // Tablet markers — strict, ordered before mobile.
  if (/ipad|tablet|playbook|silk/.test(lower)) return "tablet";
  // Mobile.
  if (/iphone|ipod|android.*mobile|mobile.*safari|opera mini|iemobile/.test(lower)) {
    return "mobile";
  }
  // Desktop OS markers — collapse to laptop.
  if (/windows nt|macintosh|mac os x|linux x86|x11/.test(lower)) return "laptop";
  return "api";
}

/**
 * Validate + coerce a free-form `CaptureContextInput` from JSON. Drops
 * values that fail the enum / number checks rather than throwing — the
 * route is best-effort and we'd rather emit a partial block than 400 a
 * note-creation flow.
 */
function sanitizeCaptureInput(
  raw: Partial<CaptureContextInput> & { device?: string },
): CaptureContextInput {
  const out: CaptureContextInput = {};
  if (raw.device && DEVICE_VALUES.has(raw.device as DeviceType)) {
    out.device = raw.device as DeviceType;
  }
  if (typeof raw.app_state === "string") out.app_state = raw.app_state;
  if (Array.isArray(raw.preceding_notes)) {
    out.preceding_notes = raw.preceding_notes.filter(
      (n): n is string => typeof n === "string",
    );
  }
  if (
    typeof raw.session_duration_min === "number" &&
    raw.session_duration_min >= 0 &&
    Number.isInteger(raw.session_duration_min)
  ) {
    out.session_duration_min = raw.session_duration_min;
  }
  if (
    typeof raw.word_count_session === "number" &&
    raw.word_count_session >= 0 &&
    Number.isInteger(raw.word_count_session)
  ) {
    out.word_count_session = raw.word_count_session;
  }
  if (raw.source && typeof raw.source === "object" && !Array.isArray(raw.source)) {
    out.source = raw.source as Record<string, unknown>;
  }
  return out;
}

/**
 * POST /api/encoding/capture
 *
 * Body (all fields optional):
 *   { device?, app_state?, preceding_notes?, session_duration_min?,
 *     word_count_session?, source? }
 *
 * If `device` is omitted, the server derives it from the `User-Agent`
 * header. `time_of_day` and `weekday` are always derived server-side from
 * the wall clock.
 *
 * Response: `{ encoded: EncodedContext }`.
 */
encodingRoutes.post("/capture", async (c) => {
  let raw: Partial<CaptureContextInput> & { device?: string } = {};
  try {
    raw = await c.req.json();
  } catch {
    // No body — that's fine, we'll just derive everything from the UA.
  }
  const input = sanitizeCaptureInput(raw);
  if (!input.device) {
    input.device = deviceFromUserAgent(c.req.header("user-agent"));
  }
  const encoded = captureEncodingContext(input);
  return c.json({ encoded });
});

/**
 * POST /api/encoding/match-boost
 *
 * Body:
 *   {
 *     hits:     [{ noteId, score, encoded?, folder? }, …],
 *     queryCtx: { device?, time_of_day?, weekday?,
 *                 preceding_notes?, active_project? }
 *   }
 *
 * Response:
 *   { hits: [{ noteId, score, encoded?, folder?,
 *              boostedScore, contextMatch: { totalBoost, matches } }, …] }
 *
 * Pure compute — no DB, no auth-sensitive data. Useful for the Wave B3
 * Story 2 pipeline that wires this boost into hybridSearch/PPR results
 * after they come back from the retrieval layer.
 */
encodingRoutes.post("/match-boost", async (c) => {
  let body: { hits?: unknown; queryCtx?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON body required" }, 400);
  }
  if (!Array.isArray(body.hits)) {
    return c.json({ error: "hits (array) required" }, 400);
  }
  const queryCtx = sanitizeQueryCtx(body.queryCtx);
  const hits: ScoredHit[] = body.hits
    .filter(
      (h): h is { noteId: string; score: number } =>
        typeof h === "object" &&
        h !== null &&
        typeof (h as { noteId?: unknown }).noteId === "string" &&
        typeof (h as { score?: unknown }).score === "number",
    )
    .map((h) => {
      // We've already proved noteId+score are typed correctly; the
      // optional fields stay loose and the boost helper tolerates undefined.
      const raw = h as ScoredHit & { encoded?: EncodedContext; folder?: string };
      return {
        noteId: raw.noteId,
        score: raw.score,
        encoded: raw.encoded,
        folder: raw.folder,
      };
    });
  const boosted = applyContextBoost(hits, queryCtx);
  return c.json({ hits: boosted });
});

/**
 * Coerce a free-form `queryCtx` from JSON into a typed `QueryContext`.
 * Unknown values for the enum fields are dropped silently — the boost
 * helper degrades gracefully to "no match" on missing keys.
 */
function sanitizeQueryCtx(raw: unknown): QueryContext {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const ctx: QueryContext = {};
  if (typeof r.device === "string" && DEVICE_VALUES.has(r.device as DeviceType)) {
    ctx.device = r.device as DeviceType;
  }
  if (
    typeof r.time_of_day === "string" &&
    TIME_OF_DAY_VALUES.has(r.time_of_day as TimeOfDay)
  ) {
    ctx.time_of_day = r.time_of_day as TimeOfDay;
  }
  if (typeof r.weekday === "string" && WEEKDAY_VALUES.has(r.weekday as Weekday)) {
    ctx.weekday = r.weekday as Weekday;
  }
  if (Array.isArray(r.preceding_notes)) {
    ctx.preceding_notes = r.preceding_notes.filter(
      (n): n is string => typeof n === "string",
    );
  }
  if (typeof r.active_project === "string") ctx.active_project = r.active_project;
  return ctx;
}

// Re-exports so the vault-route + tests can share the same helpers.
export {
  captureEncodingContext,
  contextMatchBoost,
  timeOfDayFrom,
  weekdayFrom,
};
export type { ContextMatchResult };
