import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type SystemVersion, type SystemVersionCheck } from "../api.js";
import { RELOAD_GUARD_KEY } from "./cacheRenewal.js";
import {
  bundleVersion,
  refreshSystemVersion,
  resetSystemVersionStoreForTests,
  useSystemVersion,
} from "./useSystemVersion.js";

/**
 * The hook is thin, but it is the production wiring for AC#7 path (a) — and
 * for the one hazard that no type-checker catches: `__LOKYY_BUILD_VERSION__`
 * is a Vite `define`, not a real global, so reading it bare would throw a
 * ReferenceError anywhere the define does not apply (every test run, and any
 * consumer that bundles differently).
 */

function Probe() {
  const { version } = useSystemVersion();
  return (
    <div>
      <div data-testid="running">{version?.running ?? "…"}</div>
      <div data-testid="latest">
        {version?.updateAvailable ? `neu: ${version.latest}` : "kein Update"}
      </div>
    </div>
  );
}

const PAYLOAD: SystemVersion = {
  running: "1.11.0",
  buildSha: null,
  latest: "v1.11",
  updateAvailable: false,
  highlights: [],
  checkedAt: "2026-08-03T10:00:00.000Z",
  status: "ok",
};

afterEach(() => {
  // The payload lives in a module-level store shared by the banner and the
  // settings tab (AC#5 of the manual-check story), so it outlives a render —
  // including into the next test. Drop it explicitly.
  resetSystemVersionStoreForTests();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("bundleVersion", () => {
  it("does not throw when the Vite define is absent — it reports 'unknown'", () => {
    expect(() => bundleVersion()).not.toThrow();
    expect(bundleVersion()).toBe("");
  });
});

describe("useSystemVersion", () => {
  it("exposes the payload and never throws when the check failed", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(PAYLOAD);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("running")).toHaveTextContent("1.11.0"));
  });

  it("does not reload when its own build version is unknown (loop guard)", async () => {
    // `bundleVersion()` is "" in this environment, so even a wildly different
    // server version must NOT trigger a reload — "cannot tell" is not "stale".
    vi.spyOn(api, "getSystemVersion").mockResolvedValue({ ...PAYLOAD, running: "9.9.9" });
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      reload,
    } as unknown as Location);

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("running")).toHaveTextContent("9.9.9"));
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull();
  });
});

/**
 * Issue #28 — „der Banner erschien erst nach einem Hard-Reload".
 *
 * Two ways the store can be stale without one, both fixed here: a slow initial
 * GET that lands after a manual check and overwrites it, and a tab that has
 * been open since before the release existed.
 */
describe("useSystemVersion — freshness without a reload", () => {
  const FRESH: SystemVersionCheck = {
    ...PAYLOAD,
    latest: "v1.12",
    updateAvailable: true,
    checkedAt: "2026-08-03T12:00:00.000Z",
    throttled: false,
    retryAfterSeconds: 0,
  };

  it("a slow initial GET never overwrites a newer manual check", async () => {
    // The GET was computed BEFORE the user pressed „Jetzt prüfen" and lands
    // after it. Publishing it would make the update vanish again until reload.
    let landInitialGet: ((v: SystemVersion) => void) | null = null;
    vi.spyOn(api, "getSystemVersion").mockReturnValue(
      new Promise<SystemVersion>((resolve) => {
        landInitialGet = resolve;
      }),
    );
    vi.spyOn(api, "checkSystemVersionNow").mockResolvedValue(FRESH);

    render(<Probe />);
    await act(async () => {
      await refreshSystemVersion();
    });
    expect(screen.getByTestId("latest")).toHaveTextContent("neu: v1.12");

    await act(async () => {
      landInitialGet?.(PAYLOAD); // checkedAt 10:00 — older than the check
      await Promise.resolve();
    });

    expect(screen.getByTestId("latest")).toHaveTextContent("neu: v1.12");
  });

  it("catches up when the tab comes back into view — no reload needed", async () => {
    const get = vi.spyOn(api, "getSystemVersion").mockResolvedValue(PAYLOAD);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("latest")).toHaveTextContent("kein Update"));

    // Meanwhile a release happened; the server now answers differently.
    get.mockResolvedValue({ ...PAYLOAD, ...FRESH });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() =>
      expect(screen.getByTestId("latest")).toHaveTextContent("neu: v1.12"),
    );
  });
});
