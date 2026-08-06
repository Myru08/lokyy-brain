/**
 * Story 7.12, Tasks 1 & 2 — version identity + update check.
 *
 * The two tests that actually matter here:
 *   - AC#4 numeric comparison (`v1.9 < v1.10 < v1.11`) — the lexicographic
 *     bug never shows an update and never announces itself.
 *   - AC#3 a failed check is silent and folgenlos — no throw, no
 *     `console.error`, no "update available".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_UPDATE_CHECK_INTERVAL_HOURS,
  DEFAULT_UPDATE_CHECK_URL,
  checkForUpdate,
  compareVersions,
  forceUpdateCheck,
  getBuildSha,
  getUpdateStatus,
  isUpdateAvailable,
  parseChangelog,
  parseVersion,
  readRunningVersion,
  refreshUpdateCheck,
  resetUpdateCheckCacheForTests,
  startUpdateCheckTimer,
  updateCheckConfig,
  updateCheckIntervalMs,
  type FetchLike,
} from "./index.js";

// ─── Helpers ────────────────────────────────────────────────────────────

/** Walk up to the monorepo root (the manifest named `lokyy-brain`). */
function repoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth <= 8; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        if (parsed.name === "lokyy-brain") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** A `fetch` stub that answers with a fixed body. */
function okFetch(body: string): FetchLike {
  return async () => ({ ok: true, status: 200, text: async () => body });
}

const SAMPLE_CHANGELOG = [
  "# Changelog",
  "",
  "## v1.11 — 2026-08-03",
  "",
  "- MCP-Token jetzt in der Oberfläche verwaltbar",
  "- Setup-Wizard wartet auf den Installer",
  "",
  "## v1.10 — 2026-07-12",
  "",
  "- Ältere Änderung, darf nicht auftauchen",
  "",
].join("\n");

afterEach(() => {
  resetUpdateCheckCacheForTests();
  vi.restoreAllMocks();
});

// ─── parseVersion ───────────────────────────────────────────────────────

describe("parseVersion", () => {
  it("parses the shapes this project actually uses", () => {
    expect(parseVersion("1.11.0")).toEqual([1, 11, 0]);
    expect(parseVersion("v1.11")).toEqual([1, 11]);
    expect(parseVersion("V1")).toEqual([1]);
    expect(parseVersion("  v1.11.0  ")).toEqual([1, 11, 0]);
    expect(parseVersion("1.11.0-rc1")).toEqual([1, 11, 0]);
    expect(parseVersion("1.11.0+abc123")).toEqual([1, 11, 0]);
  });

  it("refuses anything it cannot read as numbers", () => {
    for (const bad of ["", "   ", "latest", "1.x", "v1..2", "1.-1", "next", null, 42, undefined]) {
      expect(parseVersion(bad as unknown)).toBeNull();
    }
  });
});

// ─── compareVersions / isUpdateAvailable (AC#4) ─────────────────────────

describe("compareVersions", () => {
  it("orders numerically, not lexicographically — v1.9 < v1.10 < v1.11", () => {
    // The whole point of AC#4: string comparison says "1.9" > "1.10".
    expect("v1.9" > "v1.10").toBe(true); // documents the bug we avoid
    expect(compareVersions("v1.9", "v1.10")).toBe(-1);
    expect(compareVersions("v1.10", "v1.11")).toBe(-1);
    expect(compareVersions("v1.9", "v1.11")).toBe(-1);
    expect(compareVersions("v1.11", "v1.9")).toBe(1);
  });

  it("treats a missing patch segment as zero (CHANGELOG v1.11 === package.json 1.11.0)", () => {
    expect(compareVersions("1.11.0", "v1.11")).toBe(0);
    expect(compareVersions("v1.11", "1.11.1")).toBe(-1);
    expect(compareVersions("1.11.1", "v1.11")).toBe(1);
  });

  it("crosses the ten boundary in every segment", () => {
    expect(compareVersions("1.2.9", "1.2.10")).toBe(-1);
    expect(compareVersions("9.0.0", "10.0.0")).toBe(-1);
  });

  it("returns null when either side is unparsable", () => {
    expect(compareVersions("nonsense", "1.0.0")).toBeNull();
    expect(compareVersions("1.0.0", null)).toBeNull();
  });
});

describe("isUpdateAvailable", () => {
  it("is true only when the remote is provably newer", () => {
    expect(isUpdateAvailable("1.10.0", "v1.11")).toBe(true);
    expect(isUpdateAvailable("v1.9", "v1.10")).toBe(true);
  });

  it("is false for equal, older, missing and unparsable values", () => {
    expect(isUpdateAvailable("1.11.0", "v1.11")).toBe(false);
    expect(isUpdateAvailable("1.11.0", "v1.10")).toBe(false);
    expect(isUpdateAvailable(null, "v1.11")).toBe(false);
    expect(isUpdateAvailable("1.11.0", null)).toBe(false);
    expect(isUpdateAvailable("1.11.0", "latest")).toBe(false);
    expect(isUpdateAvailable("garbage", "garbage")).toBe(false);
  });
});

// ─── parseChangelog ─────────────────────────────────────────────────────

describe("parseChangelog", () => {
  it("returns the top section and stops at the next heading", () => {
    const entry = parseChangelog(SAMPLE_CHANGELOG);
    expect(entry?.version).toBe("v1.11");
    expect(entry?.highlights).toEqual([
      "- MCP-Token jetzt in der Oberfläche verwaltbar",
      "- Setup-Wizard wartet auf den Installer",
    ]);
  });

  it("joins hard-wrapped bullets back into whole items", () => {
    // The real CHANGELOG.md is wrapped at ~78 columns; splitting per raw line
    // would hand the UI sentence fragments.
    const entry = parseChangelog(
      [
        "## v1.11 — 2026-08-03",
        "",
        "### Neu",
        "- **Lizenz: AGPL-3.0.** Der Quellcode ist öffentlich. Du darfst Lokyy",
        "  Brain nutzen, verändern und weitergeben.",
        "- Zweiter Punkt",
        "",
        "## v1.10",
        "- alt",
      ].join("\n"),
    );
    expect(entry?.highlights).toEqual([
      "### Neu",
      "- **Lizenz: AGPL-3.0.** Der Quellcode ist öffentlich. Du darfst Lokyy Brain nutzen, verändern und weitergeben.",
      "- Zweiter Punkt",
    ]);
  });

  it("skips a Roadmap heading above the newest version (real changelog shape)", () => {
    const entry = parseChangelog(
      [
        "# Changelog",
        "",
        "## Roadmap — woran gerade gearbeitet wird",
        "",
        "- Update-Knopf direkt in Lokyy.",
        "",
        "---",
        "",
        "## v1.11 — 2026-08-03",
        "",
        "- echter Eintrag",
      ].join("\n"),
    );
    expect(entry?.version).toBe("v1.11");
    expect(entry?.highlights).toEqual(["- echter Eintrag"]);
  });

  it("skips headings that are not versions", () => {
    const entry = parseChangelog("## Unreleased\n\n- wip\n\n## v2.0 — soon\n\n- real\n");
    expect(entry?.version).toBe("v2.0");
    expect(entry?.highlights).toEqual(["- real"]);
  });

  it("returns null when there is nothing version-shaped", () => {
    expect(parseChangelog("# Changelog\n\nNothing here yet.\n")).toBeNull();
    expect(parseChangelog("")).toBeNull();
    expect(parseChangelog(null)).toBeNull();
  });
});

// ─── Running version (AC#1) ─────────────────────────────────────────────

describe("readRunningVersion", () => {
  it("reads the version out of the monorepo root package.json", () => {
    const root = repoRoot();
    expect(root).not.toBeNull();
    const pkg = JSON.parse(readFileSync(join(root as string, "package.json"), "utf8")) as {
      version: string;
    };
    expect(readRunningVersion()).toBe(pkg.version);
  });

  it("returns a version that parses (so the comparison can ever fire)", () => {
    expect(parseVersion(readRunningVersion())).not.toBeNull();
  });
});

describe("getBuildSha", () => {
  it("is null when unset or empty — never a placeholder", () => {
    expect(getBuildSha({})).toBeNull();
    expect(getBuildSha({ LOKYY_BUILD_SHA: "" })).toBeNull();
    expect(getBuildSha({ LOKYY_BUILD_SHA: "   " })).toBeNull();
  });

  it("passes a set value through, trimmed", () => {
    expect(getBuildSha({ LOKYY_BUILD_SHA: " abc1234 " })).toBe("abc1234");
  });
});

// ─── Configuration (AC#12) ──────────────────────────────────────────────

describe("updateCheckConfig", () => {
  it("defaults to enabled against the live repo changelog", () => {
    const config = updateCheckConfig({});
    expect(config.enabled).toBe(true);
    expect(config.url).toBe(DEFAULT_UPDATE_CHECK_URL);
    // The check must target the LIVE repo, not this dev repo.
    expect(config.url).toContain("oliverhees/lokyy-brain/main/CHANGELOG.md");
  });

  it("is switched off by LOKYY_UPDATE_CHECK", () => {
    for (const value of ["off", "OFF", "false", "0", "no", " disabled "]) {
      expect(updateCheckConfig({ LOKYY_UPDATE_CHECK: value }).enabled).toBe(false);
    }
    expect(updateCheckConfig({ LOKYY_UPDATE_CHECK: "on" }).enabled).toBe(true);
  });

  it("is redirected by LOKYY_UPDATE_CHECK_URL", () => {
    expect(
      updateCheckConfig({ LOKYY_UPDATE_CHECK_URL: "https://example.test/CHANGELOG.md" }).url,
    ).toBe("https://example.test/CHANGELOG.md");
  });
});

// ─── checkForUpdate (AC#2, AC#3) ────────────────────────────────────────

describe("checkForUpdate", () => {
  it("reports an available update from the remote changelog", async () => {
    const result = await checkForUpdate({
      env: {},
      runningVersion: "1.10.0",
      fetchImpl: okFetch(SAMPLE_CHANGELOG),
    });
    expect(result.status).toBe("ok");
    expect(result.latest).toBe("v1.11");
    expect(result.updateAvailable).toBe(true);
    expect(result.highlights).toHaveLength(2);
    expect(result.checkedAt).not.toBeNull();
  });

  it("reports no update when the running build is already current", async () => {
    const result = await checkForUpdate({
      env: {},
      runningVersion: "1.11.0",
      fetchImpl: okFetch(SAMPLE_CHANGELOG),
    });
    expect(result.status).toBe("ok");
    expect(result.updateAvailable).toBe(false);
  });

  it("never fetches and reports `disabled` when LOKYY_UPDATE_CHECK=off", async () => {
    const fetchImpl = vi.fn(okFetch(SAMPLE_CHANGELOG));
    const result = await checkForUpdate({
      env: { LOKYY_UPDATE_CHECK: "off" },
      runningVersion: "1.0.0",
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.status).toBe("disabled");
    expect(result.updateAvailable).toBe(false);
  });

  it("uses LOKYY_UPDATE_CHECK_URL when set", async () => {
    const fetchImpl = vi.fn(okFetch(SAMPLE_CHANGELOG));
    await checkForUpdate({
      env: { LOKYY_UPDATE_CHECK_URL: "https://example.test/CHANGELOG.md" },
      runningVersion: "1.0.0",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://example.test/CHANGELOG.md");
  });

  // ── AC#3: a failed check is invisible and folgenlos ──────────────────

  it("stays silent and shows no update when the network is dead", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    const fetchImpl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com");
    };
    const result = await checkForUpdate({
      env: {},
      runningVersion: "1.0.0",
      fetchImpl,
      retryDelayMs: 0,
    });

    expect(result.status).toBe("unknown");
    expect(result.updateAvailable).toBe(false);
    expect(result.latest).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("treats 404 and 429 as `unknown`, not as an update", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (const status of [404, 429, 500]) {
      const result = await checkForUpdate({
        env: {},
        runningVersion: "1.0.0",
        retryDelayMs: 0,
        fetchImpl: async () => ({ ok: false, status, text: async () => "" }),
      });
      expect(result.status).toBe("unknown");
      expect(result.updateAvailable).toBe(false);
    }
  });

  it("retries exactly once, then gives up", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn<Parameters<FetchLike>, ReturnType<FetchLike>>(async () => {
      throw new Error("boom");
    });
    await checkForUpdate({ env: {}, runningVersion: "1.0.0", fetchImpl, retryDelayMs: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the retry when the first attempt fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) throw new Error("flaky");
      return { ok: true, status: 200, text: async () => SAMPLE_CHANGELOG };
    };
    const result = await checkForUpdate({
      env: {},
      runningVersion: "1.10.0",
      fetchImpl,
      retryDelayMs: 0,
    });
    expect(calls).toBe(2);
    expect(result.updateAvailable).toBe(true);
  });

  it("aborts a hanging request within the timeout budget", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const started = Date.now();
    const result = await checkForUpdate({
      env: {},
      runningVersion: "1.0.0",
      fetchImpl,
      timeoutMs: 30,
      retryDelayMs: 0,
    });
    expect(result.status).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("treats an unparsable body as `unknown`", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const result = await checkForUpdate({
      env: {},
      runningVersion: "1.0.0",
      fetchImpl: okFetch("<html>404: Not Found</html>"),
    });
    expect(result.status).toBe("unknown");
    expect(result.updateAvailable).toBe(false);
  });
});

// ─── Cache behaviour ────────────────────────────────────────────────────

describe("update-check cache", () => {
  it("serves the cached result without a second fetch", async () => {
    const fetchImpl = vi.fn(okFetch(SAMPLE_CHANGELOG));
    await refreshUpdateCheck({ env: {}, runningVersion: "1.10.0", fetchImpl });

    const first = getUpdateStatus();
    const second = getUpdateStatus();
    expect(first.latest).toBe("v1.11");
    expect(second.latest).toBe("v1.11");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns a safe empty result before any check has run", () => {
    resetUpdateCheckCacheForTests();
    const status = getUpdateStatus();
    expect(status.updateAvailable).toBe(false);
    expect(status.latest).toBeNull();
    expect(["unknown", "disabled"]).toContain(status.status);
  });

  it("collapses concurrent refreshes into a single fetch", async () => {
    const fetchImpl = vi.fn(okFetch(SAMPLE_CHANGELOG));
    const opts = { env: {}, runningVersion: "1.10.0", fetchImpl };
    await Promise.all([
      refreshUpdateCheck(opts),
      refreshUpdateCheck(opts),
      refreshUpdateCheck(opts),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ─── Force check (Story „Update-Check manuell + periodisch", AC#1/AC#2) ──

/** Newer changelog, used to prove that a force check really re-fetched. */
const NEWER_CHANGELOG = [
  "# Changelog",
  "",
  "## v1.12 — 2026-08-06",
  "",
  "- Jetzt-prüfen-Button",
  "",
].join("\n");

describe("forceUpdateCheck", () => {
  it("bypasses the cache — a warm cache does not stop a fresh fetch", async () => {
    const first = vi.fn(okFetch(SAMPLE_CHANGELOG));
    await refreshUpdateCheck({ env: {}, runningVersion: "1.10.0", fetchImpl: first });
    expect(getUpdateStatus().latest).toBe("v1.11");

    const second = vi.fn(okFetch(NEWER_CHANGELOG));
    const forced = await forceUpdateCheck({
      env: {},
      runningVersion: "1.10.0",
      fetchImpl: second,
    });

    expect(second).toHaveBeenCalledTimes(1);
    expect(forced.throttled).toBe(false);
    expect(forced.result.latest).toBe("v1.12");
    // …and the shared cache moved with it, so GET /version sees the new answer.
    expect(getUpdateStatus().latest).toBe("v1.12");
  });

  it("refreshes checkedAt even when there is no update (AC#1)", async () => {
    const fetchImpl = vi.fn(okFetch(SAMPLE_CHANGELOG));
    const forced = await forceUpdateCheck({
      env: {},
      runningVersion: "1.11.0",
      fetchImpl,
    });

    expect(forced.result.updateAvailable).toBe(false);
    expect(forced.result.status).toBe("ok");
    expect(typeof forced.result.checkedAt).toBe("string");
  });

  it("stays silent and update-free when the fetch blows up", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const forced = await forceUpdateCheck({
      env: {},
      runningVersion: "1.10.0",
      fetchImpl: async () => {
        throw new Error("ENOTFOUND");
      },
      retries: 0,
    });

    expect(forced.result.status).toBe("unknown");
    expect(forced.result.updateAvailable).toBe(false);
    expect(typeof forced.result.checkedAt).toBe("string");
    expect(error).not.toHaveBeenCalled();
  });

  it("does not touch the network when the check is disabled", async () => {
    const fetchImpl = vi.fn(okFetch(SAMPLE_CHANGELOG));
    const forced = await forceUpdateCheck({
      env: { LOKYY_UPDATE_CHECK: "off" },
      runningVersion: "1.10.0",
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(forced.result.status).toBe("disabled");
    expect(forced.throttled).toBe(false);
  });
});

describe("forceUpdateCheck rate limit (AC#2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves the cached result instead of a second fetch within 30 s", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(okFetch(SAMPLE_CHANGELOG));
    const opts = { env: {}, runningVersion: "1.10.0", fetchImpl };

    const first = await forceUpdateCheck(opts);
    expect(first.throttled).toBe(false);

    vi.advanceTimersByTime(5_000);
    const second = await forceUpdateCheck(opts);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.throttled).toBe(true);
    // The answer is still the truthful one, just not freshly fetched.
    expect(second.result.latest).toBe("v1.11");
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it("allows the next force check once the window has passed", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(okFetch(SAMPLE_CHANGELOG));
    const opts = { env: {}, runningVersion: "1.10.0", fetchImpl };

    await forceUpdateCheck(opts);
    vi.advanceTimersByTime(31_000);
    const third = await forceUpdateCheck(opts);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(third.throttled).toBe(false);
    expect(third.retryAfterSeconds).toBe(0);
  });
});

// ─── Periodic re-check (AC#3) ───────────────────────────────────────────

describe("updateCheckIntervalMs", () => {
  it("defaults to 8 hours", () => {
    expect(updateCheckIntervalMs({})).toBe(
      DEFAULT_UPDATE_CHECK_INTERVAL_HOURS * 60 * 60 * 1000,
    );
  });

  it("honours LOKYY_UPDATE_CHECK_INTERVAL_HOURS", () => {
    expect(updateCheckIntervalMs({ LOKYY_UPDATE_CHECK_INTERVAL_HOURS: "2" })).toBe(
      2 * 60 * 60 * 1000,
    );
  });

  it("falls back to the default on garbage rather than hammering the remote", () => {
    const fallback = DEFAULT_UPDATE_CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
    expect(updateCheckIntervalMs({ LOKYY_UPDATE_CHECK_INTERVAL_HOURS: "soon" })).toBe(
      fallback,
    );
    expect(updateCheckIntervalMs({ LOKYY_UPDATE_CHECK_INTERVAL_HOURS: "-3" })).toBe(
      fallback,
    );
    expect(updateCheckIntervalMs({ LOKYY_UPDATE_CHECK_INTERVAL_HOURS: "0" })).toBe(
      fallback,
    );
  });

  it("clamps an absurdly small interval to the 15-minute floor", () => {
    expect(updateCheckIntervalMs({ LOKYY_UPDATE_CHECK_INTERVAL_HOURS: "0.0001" })).toBe(
      15 * 60 * 1000,
    );
  });

  it("is null when the check is switched off entirely", () => {
    expect(updateCheckIntervalMs({ LOKYY_UPDATE_CHECK: "off" })).toBeNull();
    expect(
      updateCheckIntervalMs({
        LOKYY_UPDATE_CHECK: "off",
        LOKYY_UPDATE_CHECK_INTERVAL_HOURS: "1",
      }),
    ).toBeNull();
  });
});

describe("startUpdateCheckTimer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-checks once per interval and stops on demand", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(okFetch(SAMPLE_CHANGELOG));
    const handle = startUpdateCheckTimer({
      env: {},
      runningVersion: "1.10.0",
      fetchImpl,
      intervalMs: 60_000,
    });

    expect(handle.intervalMs).toBe(60_000);
    // Arming the timer must not fire a check — the startup warm-up does that.
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    handle.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("arms nothing when the check is disabled", () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(okFetch(SAMPLE_CHANGELOG));
    const handle = startUpdateCheckTimer({
      env: { LOKYY_UPDATE_CHECK: "off" },
      fetchImpl,
    });

    expect(handle.intervalMs).toBeNull();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => handle.stop()).not.toThrow();
  });

  it("swallows a failing periodic check — no throw, no console.error", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = startUpdateCheckTimer({
      env: {},
      runningVersion: "1.10.0",
      fetchImpl: async () => {
        throw new Error("offline");
      },
      retries: 0,
      intervalMs: 30_000,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(error).not.toHaveBeenCalled();
    expect(getUpdateStatus().updateAvailable).toBe(false);
    handle.stop();
  });

  it("reads the interval from the environment when none is passed", () => {
    vi.useFakeTimers();
    const handle = startUpdateCheckTimer({
      env: { LOKYY_UPDATE_CHECK_INTERVAL_HOURS: "3" },
      fetchImpl: okFetch(SAMPLE_CHANGELOG),
    });
    expect(handle.intervalMs).toBe(3 * 60 * 60 * 1000);
    handle.stop();
  });
});

// ─── Drift guard (AC#1) ─────────────────────────────────────────────────

describe("version drift guard", () => {
  it("keeps package.json.version in sync with the top CHANGELOG heading", () => {
    const root = repoRoot();
    expect(root).not.toBeNull();
    const changelogPath = join(root as string, "CHANGELOG.md");

    if (!existsSync(changelogPath)) {
      // The DEV repo has no CHANGELOG.md — only the live repo does. Skipping
      // here is the whole point: this guard must not turn the dev suite red.
      console.info("[drift-guard] no CHANGELOG.md in this repo — skipped");
      expect(true).toBe(true);
      return;
    }

    const pkg = JSON.parse(readFileSync(join(root as string, "package.json"), "utf8")) as {
      version: string;
    };
    const entry = parseChangelog(readFileSync(changelogPath, "utf8"));
    expect(entry).not.toBeNull();
    expect(compareVersions(pkg.version, entry?.version)).toBe(0);
  });
});
