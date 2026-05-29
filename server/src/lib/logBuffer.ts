/**
 * In-process log ring buffer (Diagnostics + Logs backend).
 *
 * Motivation: the operator needs to see "what's important that happened" on a
 * remote deployment WITHOUT shelling into Coolify/SSH. We keep a bounded,
 * newest-first ring of recent significant events entirely in memory.
 *
 * Design:
 *   - Fixed capacity (default 500). Oldest entries are evicted on overflow.
 *     Backed by a plain array with a head pointer — O(1) push, no array shift.
 *   - `logEvent()` NEVER throws. It is called from a patched `console.warn/error`
 *     and from fire-and-forget paths (git-save failures, Tier-2 sync failures,
 *     sleep-agent summaries, search errors). A logging buffer that can crash
 *     the thing it observes is worse than useless.
 *   - `installConsoleCapture()` monkey-patches `console.warn` + `console.error`
 *     ONCE (idempotent) so anything already logging through console lands in
 *     the buffer too — the original console behaviour is preserved (we call
 *     through to it). Installed EARLY in `index.ts` so startup warnings
 *     (LLM registry, sleep-agent scheduler) are captured.
 *
 * This module is intentionally dependency-free and node-runtime-agnostic.
 */

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  /** ISO-8601 timestamp (UTC). */
  ts: string;
  level: LogLevel;
  /** Stable service tag — `server`, `git`, `tier2`, `sleep-agent`, `search`, … */
  service?: string;
  message: string;
}

export interface LogQuery {
  /** Max entries to return (default 100, hard cap 500). */
  limit?: number;
  /** Only entries at this level. */
  level?: LogLevel;
  /** Only entries from this service tag. */
  service?: string;
}

const CAPACITY = 500;

/**
 * Ring buffer. We store entries in a fixed-size slot array and track how many
 * total have been written; `size` clamps at CAPACITY and `head` walks the
 * insertion point. Reading newest-first is a backwards walk from the most
 * recent slot.
 */
class LogRing {
  private slots: (LogEntry | undefined)[] = new Array<LogEntry | undefined>(CAPACITY);
  private head = 0; // next write index
  private size = 0; // number of populated slots (clamped at CAPACITY)

  push(entry: LogEntry): void {
    this.slots[this.head] = entry;
    this.head = (this.head + 1) % CAPACITY;
    if (this.size < CAPACITY) this.size += 1;
  }

  /** Newest-first snapshot, filtered + limited. Always returns a fresh array. */
  query(opts: LogQuery = {}): LogEntry[] {
    const limit = clampLimit(opts.limit);
    const out: LogEntry[] = [];
    // Walk backwards from the most-recently-written slot.
    for (let i = 0; i < this.size && out.length < limit; i++) {
      const idx = (this.head - 1 - i + CAPACITY * 2) % CAPACITY;
      const e = this.slots[idx];
      if (!e) continue;
      if (opts.level && e.level !== opts.level) continue;
      if (opts.service && e.service !== opts.service) continue;
      out.push(e);
    }
    return out;
  }

  get length(): number {
    return this.size;
  }

  /** Test/diagnostics helper — drop everything. */
  clear(): void {
    this.slots = new Array<LogEntry | undefined>(CAPACITY);
    this.head = 0;
    this.size = 0;
  }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(CAPACITY, Math.floor(limit)));
}

/** Process-wide singleton ring. */
const ring = new LogRing();

const MAX_MESSAGE_LEN = 2_000;
function truncate(s: string): string {
  return s.length > MAX_MESSAGE_LEN ? `${s.slice(0, MAX_MESSAGE_LEN)}…` : s;
}

/** Coerce any console argument / value into a single string. */
function coerce(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Push a structured event. Defensive: any failure (e.g. a value that can't be
 * coerced) is swallowed — the buffer must never break a caller.
 */
export function logEvent(
  level: LogLevel,
  message: string,
  service?: string,
): void {
  try {
    ring.push({
      ts: new Date().toISOString(),
      level,
      ...(service ? { service } : {}),
      message: truncate(coerce(message)),
    });
  } catch {
    // Never propagate — logging must not crash the observed code path.
  }
}

/** Convenience wrappers used by fire-and-forget call sites. */
export const logBuffer = {
  info: (message: string, service?: string) => logEvent("info", message, service),
  warn: (message: string, service?: string) => logEvent("warn", message, service),
  error: (message: string, service?: string) => logEvent("error", message, service),
  query: (opts?: LogQuery): LogEntry[] => ring.query(opts),
  size: (): number => ring.length,
  clear: (): void => ring.clear(),
};

function joinArgs(args: unknown[]): string {
  return args.map((a) => coerce(a)).join(" ");
}

/**
 * Monkey-patch `console.warn` and `console.error` so anything logged through
 * them also lands in the ring buffer. Idempotent — calling twice is a no-op.
 * The original console functions are preserved and still invoked, so terminal
 * / Coolify logs are unchanged; we only ADD the in-memory capture.
 *
 * `console.warn` → level "warn", `console.error` → level "error". All args are
 * coerced + space-joined so format-string style calls still produce a useful
 * single line.
 */
let installed = false;
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.warn = (...args: unknown[]): void => {
    origWarn(...args);
    logEvent("warn", joinArgs(args), "server");
  };
  console.error = (...args: unknown[]): void => {
    origError(...args);
    logEvent("error", joinArgs(args), "server");
  };
}
