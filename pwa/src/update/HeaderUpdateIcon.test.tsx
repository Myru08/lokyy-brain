import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserContext } from "../AuthGate.js";
import {
  api,
  type SystemVersion,
  type SystemVersionCheck,
  type UpdateJob,
} from "../api.js";
import { DISMISS_KEY } from "./dismissal.js";
import { HeaderUpdateIcon } from "./HeaderUpdateIcon.js";
import { resetSystemVersionStoreForTests, useSystemVersion } from "./useSystemVersion.js";

/**
 * Story „Update-Icon in der Header-Bar" — the guarantees that matter:
 * the bar stays quiet while nothing is due, the same element both CHECKS and
 * UPDATES depending on state, an installation that cannot update itself gets a
 * sentence instead of a dead button, and all three entry points (icon, banner,
 * card) read one shared version state.
 */

const UP_TO_DATE: SystemVersion = {
  running: "1.11.0",
  buildSha: null,
  latest: "v1.11",
  updateAvailable: false,
  highlights: [],
  checkedAt: "2026-08-06T08:39:00.000Z",
  status: "ok",
};

const AVAILABLE: SystemVersion = {
  ...UP_TO_DATE,
  latest: "v1.12.4",
  updateAvailable: true,
  highlights: ["- Update-Icon in der Kopfzeile"],
};

const CHECK_UP_TO_DATE: SystemVersionCheck = {
  ...UP_TO_DATE,
  checkedAt: "2026-08-06T12:05:00.000Z",
  throttled: false,
  retryAfterSeconds: 0,
};

const CHECK_AVAILABLE: SystemVersionCheck = {
  ...AVAILABLE,
  checkedAt: "2026-08-06T12:05:00.000Z",
  throttled: false,
  retryAfterSeconds: 0,
};

const JOB: UpdateJob = {
  id: "job-1",
  phase: "preflight",
  running: true,
  startedAt: "2026-08-06T12:06:00.000Z",
  project: "lokyy-brain",
  targetServices: ["lokyy-brain"],
  log: [],
};

/** The banner/card stand-in: a second consumer of the shared version state. */
function VersionProbe() {
  const { version } = useSystemVersion();
  return (
    <div data-testid="probe">
      {version?.updateAvailable ? `neu: ${version.latest}` : "kein Update"}
    </div>
  );
}

function renderIcon(role: string | null = "admin", extra?: React.ReactNode) {
  const user =
    role === null ? null : { userId: "u1", email: "o@example.test", name: "Oliver", role };
  return render(
    <SessionUserContext.Provider value={user}>
      <HeaderUpdateIcon />
      {extra}
    </SessionUserContext.Provider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api, "getUpdateCapability").mockResolvedValue({ canUpdate: true });
});

afterEach(() => {
  resetSystemVersionStoreForTests();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("HeaderUpdateIcon — Normalzustand (AC1)", () => {
  it("renders a quiet icon without a version number next to it", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(UP_TO_DATE);
    renderIcon();

    const button = await screen.findByRole("button", { name: /nach updates suchen/i });
    // The bar stays calm: no version text rides along in the normal state.
    expect(button.textContent ?? "").not.toMatch(/1\.11/);
  });

  it("runs the forced check on click and reports that everything is current", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(UP_TO_DATE);
    const check = vi
      .spyOn(api, "checkSystemVersionNow")
      .mockResolvedValue(CHECK_UP_TO_DATE);

    renderIcon();
    fireEvent.click(await screen.findByRole("button", { name: /nach updates suchen/i }));

    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await screen.findByText(/alles aktuell — version 1\.11\.0, zuletzt geprüft \d{2}:\d{2}/i);
  });

  it("marks itself busy while the check is in flight (the spinning icon)", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(UP_TO_DATE);
    let release: ((value: SystemVersionCheck) => void) | null = null;
    vi.spyOn(api, "checkSystemVersionNow").mockReturnValue(
      new Promise<SystemVersionCheck>((resolve) => {
        release = resolve;
      }),
    );

    renderIcon();
    const button = await screen.findByRole("button", { name: /nach updates suchen/i });
    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toBeDisabled();

    release?.(CHECK_UP_TO_DATE);
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAttribute("aria-busy", "false");
  });

  it("says so quietly when the check could not run at all", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(UP_TO_DATE);
    vi.spyOn(api, "checkSystemVersionNow").mockResolvedValue(null);

    renderIcon();
    fireEvent.click(await screen.findByRole("button", { name: /nach updates suchen/i }));

    await screen.findByText(/prüfung gerade nicht möglich/i);
  });
});

describe("HeaderUpdateIcon — Update verfügbar (AC2)", () => {
  it("shows the target version next to the icon", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    renderIcon();

    await screen.findByText("→ v1.12.4");
    expect(
      screen.getByRole("button", { name: /update verfügbar.*v1\.12\.4/i }),
    ).toBeInTheDocument();
  });

  it("starts the existing update flow on click — same call as the banner button", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    const start = vi.spyOn(api, "startUpdate").mockResolvedValue(JOB);
    vi.spyOn(api, "getUpdateJob").mockResolvedValue(JOB);
    const check = vi.spyOn(api, "checkSystemVersionNow");

    renderIcon();
    const button = await screen.findByRole("button", { name: /update verfügbar/i });
    // Wait for the capability probe to land — before it, we do not claim.
    await waitFor(() => expect(api.getUpdateCapability).toHaveBeenCalled());
    fireEvent.click(button);

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // The update path is NOT the check path.
    expect(check).not.toHaveBeenCalled();
    // The banner's own progress view takes over.
    await screen.findByRole("dialog", { name: /update läuft/i });
  });

  it("drops the version text in compact mode but keeps the update action", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    render(
      <SessionUserContext.Provider
        value={{ userId: "u1", email: "o@example.test", name: "Oliver", role: "admin" }}
      >
        <HeaderUpdateIcon compact />
      </SessionUserContext.Provider>,
    );

    await screen.findByRole("button", { name: /update verfügbar.*v1\.12\.4/i });
    expect(screen.queryByText("→ v1.12.4")).not.toBeInTheDocument();
  });

  it("stays a plain check icon for a non-admin — no update action is offered", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    renderIcon("user");

    await screen.findByRole("button", { name: /nach updates suchen/i });
    expect(api.getUpdateCapability).not.toHaveBeenCalled();
    expect(screen.queryByText("→ v1.12.4")).not.toBeInTheDocument();
  });
});

describe("HeaderUpdateIcon — canUpdate=false (AC3)", () => {
  it("shows the reason instead of starting a flow — never a dead button", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: false,
      reason: "managed",
      message: "Diese Installation wird über deine Deploy-Plattform aktualisiert.",
    });
    const start = vi.spyOn(api, "startUpdate");

    renderIcon();
    const button = await screen.findByRole("button", { name: /update verfügbar/i });
    await waitFor(() => expect(api.getUpdateCapability).toHaveBeenCalled());
    fireEvent.click(button);

    await screen.findByText(/über deine deploy-plattform aktualisiert/i);
    expect(start).not.toHaveBeenCalled();
  });

  it("lists the concrete blockers when an updater exists but is misconfigured", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: false,
      reason: "blocked",
      message: "Der Updater ist nicht einsatzbereit.",
      blockers: ["Docker-Socket fehlt"],
    });

    renderIcon();
    const button = await screen.findByRole("button", { name: /update verfügbar/i });
    await waitFor(() => expect(api.getUpdateCapability).toHaveBeenCalled());
    fireEvent.click(button);

    await screen.findByText(/docker-socket fehlt/i);
  });
});

describe("HeaderUpdateIcon — ein gemeinsamer Version-State (AC4)", () => {
  it("moves every other consumer when the icon runs a check — no reload", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(UP_TO_DATE);
    vi.spyOn(api, "checkSystemVersionNow").mockResolvedValue(CHECK_AVAILABLE);

    renderIcon("admin", <VersionProbe />);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("kein Update"));

    fireEvent.click(await screen.findByRole("button", { name: /nach updates suchen/i }));

    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("neu: v1.12.4"),
    );
    // And the icon itself has flipped over to the update state.
    await screen.findByText("→ v1.12.4");
  });

  it("lifts an earlier dismissal of exactly that version, like the settings card", async () => {
    localStorage.setItem(DISMISS_KEY, "1.12.4");
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(UP_TO_DATE);
    vi.spyOn(api, "checkSystemVersionNow").mockResolvedValue(CHECK_AVAILABLE);

    renderIcon();
    fireEvent.click(await screen.findByRole("button", { name: /nach updates suchen/i }));

    await waitFor(() => expect(localStorage.getItem(DISMISS_KEY)).toBeNull());
  });
});
