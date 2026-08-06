import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type SystemVersion, type SystemVersionCheck } from "../api.js";
import { SystemVersionInfo } from "./SystemVersionInfo.js";
import {
  resetSystemVersionStoreForTests,
  useSystemVersion,
} from "./useSystemVersion.js";

/**
 * „Jetzt prüfen"-Button (AC#4) und Banner-Konsistenz (AC#5).
 *
 * The property that carries AC#5 is not visual: the settings tab and the
 * banner must read the SAME state, so a manual check lights the banner up
 * without a reload. `BannerProbe` stands in for the banner — it consumes the
 * hook exactly like `App.tsx` does, from a different component instance.
 */

const BASE: SystemVersion = {
  running: "1.11.0",
  buildSha: null,
  latest: "v1.11",
  updateAvailable: false,
  highlights: [],
  checkedAt: "2026-08-06T08:39:00.000Z",
  status: "ok",
};

const FRESH: SystemVersionCheck = {
  ...BASE,
  latest: "v1.12",
  updateAvailable: true,
  highlights: ["- Jetzt-prüfen-Button"],
  checkedAt: "2026-08-06T12:05:00.000Z",
  throttled: false,
  retryAfterSeconds: 0,
};

function BannerProbe() {
  const { version } = useSystemVersion();
  return (
    <div data-testid="banner">
      {version?.updateAvailable ? `neu: ${version.latest}` : "kein Update"}
    </div>
  );
}

afterEach(() => {
  resetSystemVersionStoreForTests();
  vi.restoreAllMocks();
});

describe("SystemVersionInfo — Jetzt prüfen", () => {
  it("offers the button next to the last-checked timestamp", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(BASE);
    render(<SystemVersionInfo />);

    const button = await screen.findByRole("button", { name: /jetzt prüfen/i });
    expect(button).toBeEnabled();
  });

  it("disables itself while checking and then shows the fresh answer", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(BASE);
    let release: ((value: SystemVersionCheck) => void) | null = null;
    vi.spyOn(api, "checkSystemVersionNow").mockReturnValue(
      new Promise<SystemVersionCheck>((resolve) => {
        release = resolve;
      }),
    );

    render(<SystemVersionInfo />);
    const button = await screen.findByRole("button", { name: /jetzt prüfen/i });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent(/prüfe/i);

    release?.(FRESH);
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText("v1.12")).toBeInTheDocument();
  });

  it("says so quietly when the check could not run — no alarm", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(BASE);
    vi.spyOn(api, "checkSystemVersionNow").mockResolvedValue(null);

    render(<SystemVersionInfo />);
    const button = await screen.findByRole("button", { name: /jetzt prüfen/i });
    fireEvent.click(button);

    await waitFor(() =>
      expect(screen.getByText(/prüfung gerade nicht möglich/i)).toBeInTheDocument(),
    );
    // The previous truth is still on screen — a failed check erases nothing.
    expect(screen.getByText("1.11.0")).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it("lights up the banner state without a reload (AC#5)", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(BASE);
    vi.spyOn(api, "checkSystemVersionNow").mockResolvedValue(FRESH);

    render(
      <>
        <BannerProbe />
        <SystemVersionInfo />
      </>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("banner")).toHaveTextContent("kein Update"),
    );

    fireEvent.click(await screen.findByRole("button", { name: /jetzt prüfen/i }));

    // Same store, different component instance — this is the AC#5 property.
    await waitFor(() =>
      expect(screen.getByTestId("banner")).toHaveTextContent("neu: v1.12"),
    );
  });

  it("shows no button at all when the check is switched off", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue({
      ...BASE,
      status: "disabled",
      latest: null,
    });
    render(<SystemVersionInfo />);

    await screen.findByText("Prüfung ausgeschaltet");
    // A button that cannot do anything is worse than no button.
    expect(screen.queryByRole("button", { name: /jetzt prüfen/i })).toBeNull();
  });

  it("asks the server exactly once per click", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(BASE);
    const check = vi.spyOn(api, "checkSystemVersionNow").mockResolvedValue(FRESH);

    render(<SystemVersionInfo />);
    fireEvent.click(await screen.findByRole("button", { name: /jetzt prüfen/i }));

    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
  });
});
