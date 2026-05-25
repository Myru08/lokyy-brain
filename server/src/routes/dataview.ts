import { Hono } from "hono";
import { queryNotes, type DataviewQuery } from "@lokyy/core";

/**
 * /api/dataview — KISS Dataview-like query endpoint.
 *
 * POST body is a `DataviewQuery` JSON object; response is `{ rows: [...] }`.
 * No GET variant — queries can carry arbitrary objects in `where`, and POSTing
 * JSON sidesteps query-string-encoding headaches.
 *
 * Auth: mounted behind the same `setupGate` as the other data routes in
 * `server/src/index.ts`.
 */
export const dataviewRoutes = new Hono();

dataviewRoutes.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "body must be a DataviewQuery object" }, 400);
  }
  try {
    const rows = await queryNotes(body as DataviewQuery);
    return c.json({ rows });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "query failed" },
      500,
    );
  }
});
