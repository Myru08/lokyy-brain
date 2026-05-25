import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { isRetrievalSource, logRetrieval } from "@lokyy/core";

/**
 * Phase A Wave A1 / Story 3 — Retrieval-Trace-Log API.
 *
 * `POST /api/traces` is the PWA-facing endpoint for non-API retrieval
 * sources (cmd-k, cmd-o, wikilink-click, hover, embed). Server-side
 * sources (`/api/notes/:id`) call `logRetrieval` directly — they don't
 * round-trip through HTTP.
 *
 * The handler is intentionally permissive: malformed bodies are rejected
 * with 400, but the underlying `logRetrieval` is itself fire-and-forget,
 * so the response shape is `{ ok: true }` even if the DB write failed
 * (the PWA must not block on telemetry).
 */
export const tracesRoutes = new Hono();

/** Hard cap on `preceding[]` — defends against a misbehaving client. */
const PRECEDING_CAP = 5;

interface TracePostBody {
  noteId?: unknown;
  source?: unknown;
  query?: unknown;
  preceding?: unknown;
  context?: unknown;
}

// POST /api/traces { noteId, source, query?, preceding?, context? }
tracesRoutes.post("/", async (c) => {
  let body: TracePostBody;
  try {
    body = (await c.req.json()) as TracePostBody;
  } catch {
    return c.json({ error: "invalid-json" }, 400);
  }

  if (typeof body.noteId !== "string" || !body.noteId) {
    return c.json({ error: "noteId (non-empty string) required" }, 400);
  }
  if (!isRetrievalSource(body.source)) {
    return c.json({ error: "source must be a known RetrievalSource" }, 400);
  }

  const query =
    typeof body.query === "string" && body.query.length > 0
      ? body.query
      : undefined;

  const preceding = Array.isArray(body.preceding)
    ? body.preceding
        .filter((x): x is string => typeof x === "string")
        .slice(-PRECEDING_CAP)
    : undefined;

  const context =
    body.context &&
    typeof body.context === "object" &&
    !Array.isArray(body.context)
      ? (body.context as Record<string, unknown>)
      : undefined;

  const sessionId = getCookie(c, "lokyy_session");

  // Fire-and-forget — logRetrieval swallows its own errors. We do not
  // await it: a slow DB must not stall the PWA's UI thread waiting on
  // an HTTP round-trip for telemetry. Returning 202 with `{ ok: true }`
  // is the right shape; the client treats this as best-effort.
  void logRetrieval({
    noteId: body.noteId,
    source: body.source,
    sessionId: sessionId,
    query,
    preceding,
    context,
  });

  return c.json({ ok: true }, 202);
});
