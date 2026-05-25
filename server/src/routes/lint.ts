import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";

import {
  database,
  lintFindings,
  isLintStatus,
  type LintStatus,
} from "@lokyy/core";

/**
 * Phase C Wave C1 / Story 3 — `/api/lint/*`.
 *
 *   GET  /api/lint/findings?status=open&kind=orphan  list findings
 *   POST /api/lint/findings/:id/acknowledge          status → acknowledged
 *   POST /api/lint/findings/:id/dismiss              status → dismissed
 *   POST /api/lint/findings/:id/mark-fixed           status → fixed
 *
 * Mutating routes set `resolved_at` to NOW() whenever the new status is
 * terminal (acknowledged / dismissed / fixed) — `open` is the only non-
 * terminal state. The transitions are intentionally loose: a user can
 * reopen a finding by writing back `status=open` via the (still-internal)
 * SQL path, but the public route surface only moves forward.
 */
export const lintRoutes = new Hono();

const TERMINAL_STATUSES: ReadonlySet<LintStatus> = new Set([
  "acknowledged",
  "fixed",
  "dismissed",
]);

const VALID_KINDS = new Set([
  "orphan",
  "contradiction",
  "missing_link",
  "schema_drift",
  "duplicate",
]);

lintRoutes.get("/findings", async (c) => {
  const statusParam = c.req.query("status");
  const kindParam = c.req.query("kind");
  const limitRaw = c.req.query("limit");
  const limit = (() => {
    const n = Number(limitRaw ?? "100");
    if (!Number.isFinite(n)) return 100;
    return Math.max(1, Math.min(500, Math.floor(n)));
  })();

  const conditions = [] as ReturnType<typeof eq>[];
  if (statusParam && isLintStatus(statusParam)) {
    conditions.push(eq(lintFindings.status, statusParam));
  }
  if (kindParam && VALID_KINDS.has(kindParam)) {
    conditions.push(eq(lintFindings.kind, kindParam));
  }

  const query = database()
    .select()
    .from(lintFindings)
    .orderBy(desc(lintFindings.detectedAt))
    .limit(limit);

  const rows = await (conditions.length === 0
    ? query
    : conditions.length === 1
      ? query.where(conditions[0]!)
      : query.where(and(...conditions)));

  return c.json({ findings: rows });
});

async function transitionStatus(
  id: string,
  to: LintStatus,
): Promise<{ ok: true } | { error: string }> {
  const rows = await database()
    .select()
    .from(lintFindings)
    .where(eq(lintFindings.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return { error: "finding not found" };

  const resolvedAt = TERMINAL_STATUSES.has(to) ? new Date() : null;
  await database()
    .update(lintFindings)
    .set({ status: to, resolvedAt })
    .where(eq(lintFindings.id, id));
  return { ok: true };
}

lintRoutes.post("/findings/:id/acknowledge", async (c) => {
  const id = c.req.param("id");
  const result = await transitionStatus(id, "acknowledged");
  if ("error" in result) return c.json({ error: result.error }, 404);
  return c.json(result);
});

lintRoutes.post("/findings/:id/dismiss", async (c) => {
  const id = c.req.param("id");
  const result = await transitionStatus(id, "dismissed");
  if ("error" in result) return c.json({ error: result.error }, 404);
  return c.json(result);
});

lintRoutes.post("/findings/:id/mark-fixed", async (c) => {
  const id = c.req.param("id");
  const result = await transitionStatus(id, "fixed");
  if ("error" in result) return c.json({ error: result.error }, 404);
  return c.json(result);
});
