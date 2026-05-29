import { Hono } from "hono";
import { logBuffer, type LogLevel } from "../lib/logBuffer.js";

/**
 * `GET /api/logs` — recent important events from the in-process ring buffer.
 *
 * Query params (all optional):
 *   limit   number   max entries (default 100, hard cap 500)
 *   level   string   "info" | "warn" | "error" — filter by level
 *   service string   filter by service tag (e.g. "git", "tier2", "sleep-agent")
 *
 * Response: `{ logs: [{ ts, level, service?, message }] }`, newest-first.
 *
 * The buffer is populated by `installConsoleCapture()` (console.warn/error)
 * plus explicit `logBuffer.*` calls at significant fire-and-forget sites
 * (git-save failures, Tier-2 sync failures, sleep-agent run summaries, search
 * errors). No Coolify/SSH needed to read it.
 *
 * Defensive: never throws — a malformed query param degrades to the default
 * rather than a 400/500.
 */
export const logsRoutes = new Hono();

const VALID_LEVELS: ReadonlySet<LogLevel> = new Set(["info", "warn", "error"]);

function parseLevel(raw: string | undefined): LogLevel | undefined {
  return raw && VALID_LEVELS.has(raw as LogLevel) ? (raw as LogLevel) : undefined;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

logsRoutes.get("/", (c) => {
  const level = parseLevel(c.req.query("level"));
  const service = c.req.query("service")?.trim() || undefined;
  const limit = parseLimit(c.req.query("limit"));

  const logs = logBuffer.query({
    ...(limit !== undefined ? { limit } : {}),
    ...(level ? { level } : {}),
    ...(service ? { service } : {}),
  });

  return c.json({ logs });
});
