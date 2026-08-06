/**
 * Version identity + update check (Story 7.12, Tasks 1 & 2).
 *
 * Two questions this module answers, and nothing else:
 *
 *   1. "Which build am I?"      → `readRunningVersion()` reads the
 *      `package.json` that ships INSIDE the image (`Dockerfile` copies
 *      `/app/package.json` into all three runtime targets). Read from disk,
 *      never `import`ed — the same code path has to resolve from
 *      `server/dist` in the image and from `packages/core/src` in dev.
 *      Unreadable → `null`. Never a crash, never a fake placeholder.
 *
 *   2. "Is there a newer one?"  → `checkForUpdate()` fetches the raw
 *      `CHANGELOG.md` of the LIVE repo, parses the top `## v…` section and
 *      compares NUMERICALLY (`v1.9 < v1.10 < v1.11`).
 *
 * Hard rules (AC#3 / AC#4 of the story), all enforced here rather than at the
 * call sites:
 *   - never throws — every failure degrades to `status: "unknown"`,
 *   - 5 s timeout, at most ONE retry, then give up,
 *   - logs on info level only — never `console.error`, a user who is simply
 *     offline must not see a single scary line,
 *   - unparsable/unknown versions mean "no update", never "update available",
 *   - the result is cached in memory (6 h) and warmed ONCE at startup
 *     (`warmUpdateCheck()`), concurrently — the server boots first and no page
 *     view ever waits on a network request.
 *
 * `LOKYY_UPDATE_CHECK=off` disables the check entirely;
 * `LOKYY_UPDATE_CHECK_URL` redirects it (forks, air-gapped installs, QA).
 * The outgoing request carries no user data — a plain unauthenticated GET.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * Default source for the AVAILABLE version: the raw changelog of the LIVE
 * repo on `main`. Deliberately NOT the dev repo this code lives in, and
 * deliberately not the Releases API — there are no releases or tags, and the
 * update button pulls `main`, so checking `main` tells the truth about what
 * the button actually installs (Dev Notes → Entscheidung 2).
 */
export const DEFAULT_UPDATE_CHECK_URL =
  "https://raw.githubusercontent.com/oliverhees/lokyy-brain/main/CHANGELOG.md";

/** Hard network budget per attempt (AC#3). */
const FETCH_TIMEOUT_MS = 5_000;
/** At most one retry — a second failure is a definitive "unknown". */
const MAX_RETRIES = 1;
/** Pause between the two attempts. Short: this runs in the background. */
const RETRY_DELAY_MS = 500;
/** Server-side cache lifetime of a check result. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Default distance between two periodic re-checks — 3×/day. */
export const DEFAULT_UPDATE_CHECK_INTERVAL_HOURS = 8;
/**
 * Floor for the periodic interval. A typo in `…_INTERVAL_HOURS` must not turn
 * every installation into a polling client of raw.githubusercontent.com.
 */
const MIN_INTERVAL_HOURS = 0.25;
/** Ceiling — beyond a month the check is effectively "off", which has a flag. */
const MAX_INTERVAL_HOURS = 24 * 30;
/**
 * Smallest distance between two MANUAL force checks (AC#2). The button is a
 * user action, so the guard is short: it exists to absorb double-clicks and an
 * open tab per device, not to ration checks.
 */
const FORCE_CHECK_MIN_INTERVAL_MS = 30_000;
/** Upper bound on the changelog body we are willing to parse. */
const MAX_BODY_CHARS = 200_000;
/** Upper bound on highlight lines handed to the UI. */
const MAX_HIGHLIGHT_LINES = 20;
/** Upper bound on a single highlight line. */
const MAX_HIGHLIGHT_LINE_CHARS = 300;
/** How far up the tree we look for the monorepo root `package.json`. */
const ROOT_LOOKUP_MAX_DEPTH = 8;
/** `name` field that identifies the root manifest (vs. a workspace package). */
const ROOT_PACKAGE_NAME = "lokyy-brain";

const LOG_PREFIX = "[lokyy-brain] update-check";

// ─── Version parsing + comparison (AC#4) ────────────────────────────────

/**
 * Parse a version string into its numeric segments.
 *
 * Tolerant on purpose about the two shapes that actually occur in this
 * project: `package.json` carries semver (`1.11.0`), the `CHANGELOG.md`
 * headings carry two parts (`v1.11`). A leading `v` is optional, a
 * prerelease/build suffix (`-rc1`, `+sha`) is ignored.
 *
 * Anything else — empty, `latest`, `1.x`, `v1..2` — is `null`, which the
 * comparison turns into "no update" rather than a guess.
 */
export function parseVersion(raw: unknown): number[] | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Drop optional leading `v`/`V` and any prerelease/build metadata.
  const core = trimmed.replace(/^[vV]/, "").split(/[-+]/, 1)[0];
  if (core === undefined || core === "") return null;

  const segments = core.split(".");
  if (segments.length === 0 || segments.length > 4) return null;

  const parts: number[] = [];
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) return null;
    const value = Number.parseInt(segment, 10);
    if (!Number.isSafeInteger(value)) return null;
    parts.push(value);
  }
  return parts;
}

/**
 * Numeric version comparison. Returns `-1 | 0 | 1`, or `null` when either
 * side is unparsable.
 *
 * This exists as its own exported function because the lexicographic version
 * of this ("v1.9" > "v1.10" — string compare says yes) is the exact bug that
 * silently never shows an update. Missing segments count as zero, so
 * `1.11` === `1.11.0` — that is what makes the two-part CHANGELOG headings
 * comparable with the three-part `package.json` value.
 */
export function compareVersions(a: unknown, b: unknown): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;

  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/**
 * `true` only when `latest` is provably newer than `running`.
 *
 * Every ambiguous case — either side missing, unparsable, equal, or the
 * remote being OLDER than what runs here — is `false`. A banner must never
 * appear on a guess (AC#4).
 */
export function isUpdateAvailable(running: unknown, latest: unknown): boolean {
  return compareVersions(running, latest) === -1;
}

// ─── Changelog parsing ──────────────────────────────────────────────────

/** Top section of a changelog: its version plus the lines beneath it. */
export interface ChangelogEntry {
  /** The version token exactly as written in the heading, e.g. `v1.11`. */
  version: string;
  /**
   * The section body as whole items — the UI shows this as "what's new".
   *
   * Hard-wrapped source lines are joined back together, so one bullet is one
   * entry. The real changelog is wrapped at ~78 columns; splitting per raw
   * line would hand the UI sentence fragments.
   */
  highlights: string[];
}

/** A line that opens a new item: sub-heading, bullet, or numbered entry. */
const ITEM_START = /^(#{3,}\s|[-*+]\s|\d+\.\s)/;

/**
 * Extract the TOPMOST `## v…` section of a changelog.
 *
 * Deliberately forgiving about the heading tail (`## v1.11 — 2026-08-03`):
 * only the first whitespace-delimited token has to look like a version, and
 * it has to parse — a `## Unreleased` heading is skipped rather than
 * mis-read as a version.
 */
export function parseChangelog(markdown: unknown): ChangelogEntry | null {
  if (typeof markdown !== "string" || markdown.trim() === "") return null;

  const lines = markdown.slice(0, MAX_BODY_CHARS).split(/\r?\n/);

  let headingIndex = -1;
  let version = "";
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^##\s+(\S+)/.exec(lines[i] ?? "");
    if (!match) continue;
    const token = (match[1] ?? "").replace(/[.,;:]+$/, "");
    if (parseVersion(token) === null) continue; // e.g. "## Unreleased"
    headingIndex = i;
    version = token;
    break;
  }
  if (headingIndex === -1) return null;

  const highlights: string[] = [];
  let current: string | null = null;

  /** Close the item being accumulated and file it under `highlights`. */
  const flush = (): void => {
    if (current === null) return;
    const item = current.trim();
    if (item !== "") {
      highlights.push(
        item.length > MAX_HIGHLIGHT_LINE_CHARS
          ? `${item.slice(0, MAX_HIGHLIGHT_LINE_CHARS - 1).trimEnd()}…`
          : item,
      );
    }
    current = null;
  };

  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^##\s/.test(line)) break; // next section — stop
    const trimmed = line.trim();

    if (trimmed === "" || /^-{3,}$/.test(trimmed)) {
      flush(); // blank line or horizontal rule ends the current item
    } else if (ITEM_START.test(trimmed)) {
      flush();
      current = trimmed;
    } else {
      // Continuation of a hard-wrapped line — glue it back on.
      current = current === null ? trimmed : `${current} ${trimmed}`;
    }

    if (highlights.length >= MAX_HIGHLIGHT_LINES) return { version, highlights };
  }
  flush();

  return { version, highlights: highlights.slice(0, MAX_HIGHLIGHT_LINES) };
}

// ─── Running version (AC#1) ─────────────────────────────────────────────

let runningVersionResolved = false;
let runningVersionCache: string | null = null;

/**
 * Walk up from this module's own location looking for the monorepo root
 * `package.json` (identified by its `name`, so a workspace manifest can never
 * be mistaken for it).
 *
 * Both layouts land on the same relative distance, which is why one walk
 * covers dev and image alike:
 *   dev   `<root>/packages/core/src/version/index.ts`
 *   image `/app/packages/core/dist/version/index.js`
 */
function findRootPackageJson(): { version?: unknown } | null {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }

  for (let depth = 0; depth <= ROOT_LOOKUP_MAX_DEPTH; depth += 1) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (parsed?.name === ROOT_PACKAGE_NAME) return parsed;
    } catch {
      // No manifest here (or unreadable/invalid) — keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Version of the running build, read ONCE from the `package.json` shipped in
 * the image. `null` when it cannot be read — never a crash, never `"unknown"`
 * dressed up as a version (AC#1).
 */
export function readRunningVersion(): string | null {
  if (runningVersionResolved) return runningVersionCache;
  runningVersionResolved = true;

  const pkg = findRootPackageJson();
  const version = pkg?.version;
  runningVersionCache =
    typeof version === "string" && version.trim() !== "" ? version.trim() : null;

  if (runningVersionCache === null) {
    console.info(`${LOG_PREFIX}: running version not readable — reporting null`);
  }
  return runningVersionCache;
}

/**
 * Optional build SHA (`LOKYY_BUILD_SHA`, set as a Docker `ARG`/`ENV`).
 * Display only — NEVER part of the comparison. Unset → `null`, no placeholder.
 */
export function getBuildSha(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.LOKYY_BUILD_SHA;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

// ─── Configuration (AC#12) ──────────────────────────────────────────────

/** Resolved update-check configuration. */
export interface UpdateCheckConfig {
  /** `false` when `LOKYY_UPDATE_CHECK` is `off`/`false`/`0`/`no`. */
  enabled: boolean;
  /** Source URL — `LOKYY_UPDATE_CHECK_URL` or the live-repo default. */
  url: string;
}

const DISABLED_VALUES = new Set(["off", "false", "0", "no", "disabled"]);

/** Read `LOKYY_UPDATE_CHECK` / `LOKYY_UPDATE_CHECK_URL` from an env bag. */
export function updateCheckConfig(
  env: NodeJS.ProcessEnv = process.env,
): UpdateCheckConfig {
  const flag = (env.LOKYY_UPDATE_CHECK ?? "").trim().toLowerCase();
  const url = (env.LOKYY_UPDATE_CHECK_URL ?? "").trim();
  return {
    enabled: !DISABLED_VALUES.has(flag),
    url: url === "" ? DEFAULT_UPDATE_CHECK_URL : url,
  };
}

/**
 * Distance between two periodic re-checks, in milliseconds — `null` when the
 * check is switched off entirely (`LOKYY_UPDATE_CHECK=off`).
 *
 * `LOKYY_UPDATE_CHECK_INTERVAL_HOURS` accepts fractions (`0.5`). Anything
 * unusable — a word, a negative number, zero — falls back to the default
 * rather than disabling the check or looping tightly: there is exactly one
 * documented off switch, and this isn't it.
 */
export function updateCheckIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (!updateCheckConfig(env).enabled) return null;

  const raw = (env.LOKYY_UPDATE_CHECK_INTERVAL_HOURS ?? "").trim();
  let hours = DEFAULT_UPDATE_CHECK_INTERVAL_HOURS;
  if (raw !== "") {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      hours = Math.min(Math.max(parsed, MIN_INTERVAL_HOURS), MAX_INTERVAL_HOURS);
    } else {
      console.info(
        `${LOG_PREFIX}: unusable LOKYY_UPDATE_CHECK_INTERVAL_HOURS="${raw}" — ` +
          `using ${DEFAULT_UPDATE_CHECK_INTERVAL_HOURS}h`,
      );
    }
  }
  return Math.round(hours * 60 * 60 * 1000);
}

// ─── The check itself (AC#2, AC#3) ──────────────────────────────────────

/** What `GET /api/system/version` serves. */
export interface UpdateCheckResult {
  /** Version of the running build, or `null` if unreadable. */
  running: string | null;
  /** Build SHA, display only. `null` when the build arg wasn't set. */
  buildSha: string | null;
  /** Newest version found remotely, or `null` when unknown. */
  latest: string | null;
  /** `true` only when `latest` is provably newer than `running`. */
  updateAvailable: boolean;
  /** Changelog lines of the newest version — empty when unknown. */
  highlights: string[];
  /** ISO timestamp of the last completed check, `null` if none ran yet. */
  checkedAt: string | null;
  /**
   * `ok`       — a remote version was read and compared,
   * `disabled` — turned off via `LOKYY_UPDATE_CHECK`,
   * `unknown`  — not checked yet, or the check failed (offline, DNS, 404,
   *              429, timeout, unparsable body). Indistinguishable on
   *              purpose: all of them mean "no banner" (AC#3).
   */
  status: "ok" | "disabled" | "unknown";
}

/** Injection seam for tests — the subset of `fetch` we rely on. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Options for {@link checkForUpdate} — all optional, all test seams. */
export interface CheckForUpdateOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** Overrides the running version (tests only — production reads the image). */
  runningVersion?: string | null;
}

/**
 * Pause between the two attempts.
 *
 * Deliberately a plain, ref'd timer: an `unref`'d one lets a short-lived
 * process exit in the middle of the retry pause, which abandons the check
 * halfway and shows up as an "unsettled top-level await" warning. Half a
 * second of keeping the loop alive is the cheaper trade.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One attempt: GET the changelog with a hard timeout. Throws on failure. */
async function fetchChangelogOnce(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "text/plain, text/markdown, */*" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the update check. **Never throws** — every failure path returns a
 * result with `status: "unknown"` and `updateAvailable: false`.
 */
export async function checkForUpdate(
  opts: CheckForUpdateOptions = {},
): Promise<UpdateCheckResult> {
  const env = opts.env ?? process.env;
  const running =
    opts.runningVersion !== undefined ? opts.runningVersion : readRunningVersion();
  const buildSha = getBuildSha(env);
  const config = updateCheckConfig(env);

  const base: UpdateCheckResult = {
    running,
    buildSha,
    latest: null,
    updateAvailable: false,
    highlights: [],
    checkedAt: null,
    status: "unknown",
  };

  if (!config.enabled) {
    return { ...base, status: "disabled", checkedAt: new Date().toISOString() };
  }

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== "function") {
    console.info(`${LOG_PREFIX}: no fetch implementation available — skipping`);
    return base;
  }

  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const retries = opts.retries ?? MAX_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;

  let body: string | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      body = await fetchChangelogOnce(config.url, fetchImpl, timeoutMs);
      break;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.info(
        `${LOG_PREFIX}: attempt ${attempt + 1}/${retries + 1} failed (${reason})`,
      );
      if (attempt < retries) await sleep(retryDelayMs);
    }
  }

  if (body === null) {
    // Offline, DNS dead, 404, 429, timeout — all the same: no banner (AC#3).
    return { ...base, checkedAt: new Date().toISOString() };
  }

  const entry = parseChangelog(body);
  if (entry === null) {
    console.info(`${LOG_PREFIX}: remote changelog had no parsable version heading`);
    return { ...base, checkedAt: new Date().toISOString() };
  }

  return {
    ...base,
    latest: entry.version,
    updateAvailable: isUpdateAvailable(running, entry.version),
    highlights: entry.highlights,
    checkedAt: new Date().toISOString(),
    status: "ok",
  };
}

// ─── Server-side cache + startup warm-up ────────────────────────────────

let cached: UpdateCheckResult | null = null;
let cachedAtMs = 0;
let inFlight: Promise<UpdateCheckResult> | null = null;

function emptyResult(): UpdateCheckResult {
  const config = updateCheckConfig();
  return {
    running: readRunningVersion(),
    buildSha: getBuildSha(),
    latest: null,
    updateAvailable: false,
    highlights: [],
    checkedAt: null,
    status: config.enabled ? "unknown" : "disabled",
  };
}

/**
 * Run the check and store the result. Concurrent callers share one run — the
 * remote is never hit twice in parallel.
 */
export async function refreshUpdateCheck(
  opts: CheckForUpdateOptions = {},
): Promise<UpdateCheckResult> {
  if (inFlight) return inFlight;
  inFlight = checkForUpdate(opts)
    .then((result) => {
      cached = result;
      cachedAtMs = Date.now();
      return result;
    })
    .catch(() => {
      // `checkForUpdate` does not throw; this is belt-and-braces so a future
      // change can never turn a background refresh into an unhandled rejection.
      const fallback = emptyResult();
      cached = fallback;
      cachedAtMs = Date.now();
      return fallback;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Synchronous, non-blocking read for the request path.
 *
 * Returns whatever the cache holds and kicks off a background refresh when
 * the entry is older than the TTL (or missing). A page view therefore NEVER
 * waits on GitHub — the worst case is one stale-but-honest answer.
 */
export function getUpdateStatus(): UpdateCheckResult {
  const stale = cached === null || Date.now() - cachedAtMs > CACHE_TTL_MS;
  if (stale && updateCheckConfig().enabled) {
    void refreshUpdateCheck();
  }
  return cached ?? emptyResult();
}

/**
 * Warm the cache once at startup (AC#2 "beim Start wird immer geprüft").
 *
 * Fire-and-forget by design: the caller does not await it, so the server has
 * already finished booting and is accepting requests while this runs.
 */
export async function warmUpdateCheck(): Promise<void> {
  const config = updateCheckConfig();
  if (!config.enabled) {
    console.info(`${LOG_PREFIX}: disabled via LOKYY_UPDATE_CHECK`);
    cached = emptyResult();
    cachedAtMs = Date.now();
    return;
  }
  try {
    const result = await refreshUpdateCheck();
    console.info(
      `${LOG_PREFIX}: running=${result.running ?? "unknown"} latest=${
        result.latest ?? "unknown"
      } updateAvailable=${result.updateAvailable} status=${result.status}`,
    );
  } catch {
    // Unreachable in practice (refreshUpdateCheck swallows), and still not
    // allowed to surface. A failed check is a non-event.
  }
}

// ─── Manual force check (AC#1, AC#2) ────────────────────────────────────

/** When the last accepted force check ran. `0` = none since process start. */
let lastForceAtMs = 0;

/** What {@link forceUpdateCheck} answers — the result plus WHY it is that. */
export interface ForceUpdateCheckResult {
  /** The freshly fetched result, or the cached one when `throttled`. */
  result: UpdateCheckResult;
  /** `true` when the 30 s guard swallowed this call. */
  throttled: boolean;
  /** Seconds until the next force check is accepted. `0` when not throttled. */
  retryAfterSeconds: number;
}

/** Options for {@link forceUpdateCheck}. */
export interface ForceUpdateCheckOptions extends CheckForUpdateOptions {
  /** Overrides the 30 s guard (tests). */
  minIntervalMs?: number;
}

/**
 * Check NOW, ignoring the 6 h cache — what the „Jetzt prüfen" button calls.
 *
 * Unlike {@link getUpdateStatus} this really goes to the network, and it
 * writes the result back into the shared cache, so the banner and the settings
 * tab see the same answer immediately afterwards.
 *
 * Guarded to at most one real fetch per 30 s. Being throttled is NOT an error:
 * the caller gets the cached result — at most 30 s old — plus `throttled: true`
 * so it can say so if it wants to. Same hard rules as everywhere in this
 * module: never throws, `checkedAt` moves on every completed check (including
 * "no update"), a failure degrades to `status: "unknown"`.
 */
export async function forceUpdateCheck(
  opts: ForceUpdateCheckOptions = {},
): Promise<ForceUpdateCheckResult> {
  const { minIntervalMs = FORCE_CHECK_MIN_INTERVAL_MS, ...checkOpts } = opts;
  const env = checkOpts.env ?? process.env;

  if (!updateCheckConfig(env).enabled) {
    // Off means off — answer honestly, do not open a socket, do not throttle.
    const result = await checkForUpdate(checkOpts);
    cached = result;
    cachedAtMs = Date.now();
    return { result, throttled: false, retryAfterSeconds: 0 };
  }

  const sinceMs = Date.now() - lastForceAtMs;
  if (lastForceAtMs !== 0 && sinceMs < minIntervalMs) {
    return {
      result: cached ?? emptyResult(),
      throttled: true,
      retryAfterSeconds: Math.max(1, Math.ceil((minIntervalMs - sinceMs) / 1000)),
    };
  }

  lastForceAtMs = Date.now();
  const result = await refreshUpdateCheck(checkOpts);
  return { result, throttled: false, retryAfterSeconds: 0 };
}

// ─── Periodic re-check (AC#3) ───────────────────────────────────────────

/** Handle for the periodic re-check timer. */
export interface UpdateCheckTimerHandle {
  /** Interval in ms, or `null` when nothing was armed (check disabled). */
  intervalMs: number | null;
  /** Idempotent — safe to call on a disabled handle and twice in a row. */
  stop(): void;
}

/** Options for {@link startUpdateCheckTimer}. */
export interface UpdateCheckTimerOptions extends CheckForUpdateOptions {
  /** Overrides `LOKYY_UPDATE_CHECK_INTERVAL_HOURS` (tests). */
  intervalMs?: number;
}

/**
 * Arm the periodic re-check — default every 8 h, i.e. 3×/day (AC#3).
 *
 * Deliberately does NOT fire immediately: the startup `warmUpdateCheck()` is
 * the first check, this one takes over afterwards. The timer is `unref`'d, so
 * it neither keeps the process alive nor delays a shutdown, and every failure
 * is swallowed exactly like the warm-up swallows it — a user who is offline
 * still never sees a scary line.
 */
export function startUpdateCheckTimer(
  opts: UpdateCheckTimerOptions = {},
): UpdateCheckTimerHandle {
  const { intervalMs: override, ...checkOpts } = opts;
  const env = checkOpts.env ?? process.env;
  const intervalMs = override ?? updateCheckIntervalMs(env);

  if (intervalMs === null) {
    console.info(`${LOG_PREFIX}: periodic re-check not armed — check is disabled`);
    return { intervalMs: null, stop: () => {} };
  }

  const timer = setInterval(() => {
    void refreshUpdateCheck(checkOpts)
      .then((result) => {
        console.info(
          `${LOG_PREFIX}: periodic re-check — latest=${result.latest ?? "unknown"} ` +
            `updateAvailable=${result.updateAvailable} status=${result.status}`,
        );
      })
      .catch(() => {
        // `refreshUpdateCheck` already swallows; this keeps a future change
        // from turning a background tick into an unhandled rejection.
      });
  }, intervalMs);

  // A background nicety must never be the reason a process refuses to exit.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  console.info(
    `${LOG_PREFIX}: periodic re-check armed — every ${(intervalMs / 3_600_000).toFixed(2)}h`,
  );
  return { intervalMs, stop: () => clearInterval(timer) };
}

/** Test-only: drop the cached result so each test starts from a clean slate. */
export function resetUpdateCheckCacheForTests(): void {
  cached = null;
  cachedAtMs = 0;
  inFlight = null;
  lastForceAtMs = 0;
}
