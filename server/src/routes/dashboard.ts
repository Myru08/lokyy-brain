import { Hono } from "hono";
import {
  queryNotes,
  findBrokenLinks,
  listTags,
  getHealth,
  vaultActivity,
  looseEnds,
  getTimezone,
  getDateParts,
  type DataviewRow,
} from "@lokyy/core";

/**
 * /api/dashboard — Lokyy-Workspace Home dashboard data (Epic 11 / Story 11.11).
 *
 * Flat, single-vault route (no `:vaultId`), camelCase JSON — house convention.
 * Mounted as `app.route("/api/dashboard", dashboardRoutes)` by the wireup step
 * in `server/src/index.ts`.
 *
 * Two latency classes (Addendum §5):
 *   GET /dashboard               → cheap tiles, SYNCHRONOUS. Schema = DashboardSummary.
 *   GET /dashboard/activity?days → expensive git-log streak/heatmap, LAZY.
 *   GET /dashboard/loose-ends    → expensive vault-wide #todo/checkbox scan, LAZY.
 *
 * Everything comes from existing @lokyy/core surfaces (queryNotes /
 * findBrokenLinks / listTags / getHealth) plus the two new read-only helpers
 * `vaultActivity` (git) + `looseEnds` (workspace). NO MCP, NO new git write path.
 *
 * Ausrichtung: Vault-Wissens-Cockpit — KEINE Projekte/Tasks/Ziele (O-5).
 *
 * [Source: epic-11-architecture-addendum.md §5 + §7 R-1/R-4; Story 11.11]
 */
export const dashboardRoutes = new Hono();

const DEFAULT_VAULT = process.env.LOKYY_DEFAULT_VAULT ?? "default";

/** Top-N broken links surfaced on the health tile. */
const BROKEN_TOP_N = 5;
/** Recently-edited notes shown on the "Zuletzt" tile. */
const RECENT_N = 8;
/** Vault folder for daily journal notes. */
const DAILY_FOLDER = "40_daily";

/** Narrow a DataviewRow string field, falling back to the empty string. */
function str(row: DataviewRow, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

/**
 * GET /api/dashboard — cheap tiles, synchronous. Exact `DashboardSummary` shape.
 *
 *   counts      { notes, byType, tags }
 *   health      { brokenLinks, brokenTop[] }
 *   recent[]    most-recently-updated notes
 *   today       today's 40_daily journal note (or null)
 *   serendipity one random note (or null)
 *   system      { syncState, vaultId } from getHealth()
 */
dashboardRoutes.get("/", async (c) => {
  try {
    // All notes once (id/title/type/updated) → drives counts + recent + today
    // + serendipity without re-walking the vault per tile.
    const all = await queryNotes({
      select: ["id", "title", "type", "updated"],
      sort: "updated",
      order: "desc",
      limit: 200,
    });

    // ── counts ────────────────────────────────────────────────────────────
    const byType: Record<string, number> = {};
    for (const row of all) {
      const t = str(row, "type") || "note";
      byType[t] = (byType[t] ?? 0) + 1;
    }
    const tags = await listTags();

    // ── health ────────────────────────────────────────────────────────────
    const broken = await findBrokenLinks();
    const brokenTop = broken.slice(0, BROKEN_TOP_N).map((b) => ({
      sourceId: b.sourceId,
      target: b.linkText,
    }));

    // ── recent ──────────────────────────────────────────────────────────────
    const recent = all.slice(0, RECENT_N).map((row) => ({
      id: str(row, "id"),
      title: str(row, "title") || str(row, "id"),
      updated: str(row, "updated"),
    }));

    // ── today (40_daily journal note for the user's local date) ───────────────
    const tz = await getTimezone().catch(() => "UTC");
    const { YYYY, MM, DD } = getDateParts(new Date(), tz);
    const todayKey = `${YYYY}-${MM}-${DD}`;
    const dailies = await queryNotes({
      from: DAILY_FOLDER,
      select: ["id", "title"],
      limit: 200,
    });
    const todayRow = dailies.find(
      (row) =>
        str(row, "id").includes(todayKey) || str(row, "title").includes(todayKey),
    );
    const today = todayRow
      ? { id: str(todayRow, "id"), title: str(todayRow, "title") || str(todayRow, "id") }
      : null;

    // ── serendipity (one random note) ─────────────────────────────────────────
    let serendipity: { id: string; title: string } | null = null;
    if (all.length > 0) {
      const pick = all[Math.floor(Math.random() * all.length)] as DataviewRow;
      serendipity = { id: str(pick, "id"), title: str(pick, "title") || str(pick, "id") };
    }

    // ── system ──────────────────────────────────────────────────────────────
    const health = getHealth({ vaultId: DEFAULT_VAULT });

    return c.json({
      counts: { notes: all.length, byType, tags: tags.length },
      health: { brokenLinks: broken.length, brokenTop },
      recent,
      today,
      serendipity,
      system: { syncState: health.sync_state, vaultId: health.vault_id },
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "dashboard summary failed" },
      500,
    );
  }
});

/**
 * GET /api/dashboard/activity?days=365 — expensive, lazy.
 * `{ days[], currentStreak, longestStreak }` (exact `DashboardActivity`).
 * Backed by the new read-only core helper `vaultActivity` (K-3).
 */
dashboardRoutes.get("/activity", async (c) => {
  const raw = c.req.query("days");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 365;
  try {
    const activity = await vaultActivity(days);
    return c.json({
      days: activity.days,
      currentStreak: activity.currentStreak,
      longestStreak: activity.longestStreak,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "activity scan failed" },
      500,
    );
  }
});

/**
 * GET /api/dashboard/loose-ends?limit=50 — expensive, lazy.
 * `{ items[], total }` (exact `DashboardLooseEnds`). Backed by the new core
 * helper `looseEnds` (open checkboxes AND `#todo`, O-4).
 */
dashboardRoutes.get("/loose-ends", async (c) => {
  const raw = c.req.query("limit");
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
  try {
    const result = await looseEnds(limit);
    return c.json({ items: result.items, total: result.total });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "loose-ends scan failed" },
      500,
    );
  }
});
