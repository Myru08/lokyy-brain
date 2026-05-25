import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import {
  getSurfaceRecommendations,
  workingMemory,
} from "@lokyy/core";

/**
 * Phase B Wave B2 / Story 2 — Working-Memory + Spacing-Effect-Surfacing API.
 *
 * Two distinct mountpoints because the concepts move at different cadences:
 *
 *   /api/surface/*          — runtime computation of "you forgot this"
 *                             recommendations. Reads only.
 *   /api/working-memory/*   — explicit record/boost endpoints for the PWA
 *                             ranker. Stateful in-process; no DB.
 *
 * For both, the `sessionId` is derived from the `lokyy_session` cookie if
 * present, else from a query/body field. Working-memory is per-session, so
 * a missing sessionId is a 400 — we never silently degrade to a global
 * cache (that would leak retrieval signal across users).
 */

// ─── /api/surface/* ──────────────────────────────────────────────────────

export const surfaceRoutes = new Hono();

/**
 * GET /api/surface/recommendations
 *
 * Query params:
 *   limit     default 5,  cap 50
 *   hotDays   default 7
 *   coldDays  default 30
 */
surfaceRoutes.get("/recommendations", async (c) => {
  const limit = clampInt(c.req.query("limit"), 5, 1, 50);
  const hotDays = clampInt(c.req.query("hotDays"), 7, 1, 365);
  const coldDays = clampInt(c.req.query("coldDays"), 30, 1, 3650);
  try {
    const recs = await getSurfaceRecommendations(hotDays, coldDays, limit);
    return c.json({ recommendations: recs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ─── /api/working-memory/* ───────────────────────────────────────────────

export const workingMemoryRoutes = new Hono();

interface RecordBody {
  noteId?: unknown;
  sessionId?: unknown;
}

/**
 * POST /api/working-memory/record { noteId, sessionId? }
 *
 * `sessionId` falls back to the `lokyy_session` cookie. Either source must
 * yield a non-empty string — we never accept a global / null-keyed cache.
 */
workingMemoryRoutes.post("/record", async (c) => {
  let body: RecordBody;
  try {
    body = (await c.req.json()) as RecordBody;
  } catch {
    return c.json({ error: "invalid-json" }, 400);
  }

  const noteId = typeof body.noteId === "string" ? body.noteId : "";
  if (!noteId) {
    return c.json({ error: "noteId (non-empty string) required" }, 400);
  }

  const sessionId = resolveSessionId(c, body.sessionId);
  if (!sessionId) {
    return c.json(
      { error: "sessionId required (cookie or body)" },
      400,
    );
  }

  workingMemory().record(noteId, sessionId);
  return c.json({ ok: true });
});

/**
 * GET /api/working-memory/boosts
 *
 * Query params:
 *   sessionId         optional if `lokyy_session` cookie is set
 *   candidateIds      comma-separated list (max 200)
 *
 * Returns `[]` if no entries for the session — never throws "session
 * not found", because the ranker calls this on every query and the
 * empty-set case is the dominant one.
 */
workingMemoryRoutes.get("/boosts", async (c) => {
  const sessionId = resolveSessionId(c, c.req.query("sessionId"));
  if (!sessionId) {
    return c.json(
      { error: "sessionId required (cookie or query param)" },
      400,
    );
  }

  const raw = c.req.query("candidateIds") ?? "";
  const candidates = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 200);

  const boosts = workingMemory().getBoosts(candidates, sessionId);
  return c.json({ boosts });
});

/**
 * POST /api/working-memory/clear { sessionId? }
 *
 * If no sessionId is given, clears the caller's own session only — never
 * the global cache (that would require admin scope; deliberately omitted
 * from this story).
 */
workingMemoryRoutes.post("/clear", async (c) => {
  const body = await c.req
    .json<RecordBody>()
    .catch(() => ({}) as RecordBody);
  const sessionId = resolveSessionId(c, body.sessionId);
  if (!sessionId) {
    return c.json(
      { error: "sessionId required (cookie or body)" },
      400,
    );
  }
  workingMemory().clear(sessionId);
  return c.json({ ok: true });
});

/**
 * GET /api/working-memory/stats — telemetry / debug helper.
 *
 * Intentionally not session-scoped (returns global counts only, no
 * noteIds). Useful for the Pulse dashboard / health check.
 */
workingMemoryRoutes.get("/stats", async (c) => {
  const wm = workingMemory();
  return c.json({
    entries: wm.size(),
    sessions: wm.sessionCount(),
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve sessionId from (in priority order): explicit value > cookie.
 * Empty strings count as "missing".
 */
function resolveSessionId(c: Context, explicit: unknown): string | null {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const cookie = getCookie(c, "lokyy_session");
  return cookie && cookie.length > 0 ? cookie : null;
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}
