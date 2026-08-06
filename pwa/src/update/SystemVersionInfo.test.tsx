import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserContext } from "../AuthGate.js";
import { UpdateBanner } from "./UpdateBanner.js";
import { DISMISS_KEY } from "./dismissal.js";
import {
  UpdateApiError,
  api,
  type SystemVersion,
  type SystemVersionCheck,
  type UpdateJob,
} from "../api.js";
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  resetSystemVersionStoreForTests();
  vi.restoreAllMocks();
  localStorage.clear();
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

/**
 * „Jetzt aktualisieren" in der Version-Karte (Story „Update-Button", AC#1–#4).
 *
 * The point of these tests is not the button — it is that the button drives the
 * SAME flow the banner drives: the capability probe decides whether it exists,
 * `api.startUpdate` starts it, and the progress view that opens is the banner's
 * own. Nothing here re-implements any of that.
 */

const AVAILABLE: SystemVersion = {
  ...BASE,
  latest: "v1.12",
  updateAvailable: true,
  highlights: ["- **Update-Button** in den Einstellungen"],
};

const JOB: UpdateJob = {
  id: "job-1",
  phase: "preflight",
  running: true,
  startedAt: "2026-08-06T12:00:00.000Z",
  project: "lokyy-brain",
  targetServices: ["lokyy-brain"],
  log: ["Update angefordert"],
};

function renderCard(role: string | null = "admin"): ReturnType<typeof render> {
  const user =
    role === null ? null : { userId: "u1", email: "o@example.test", name: "Oliver", role };
  return render(
    <SessionUserContext.Provider value={user}>
      <SystemVersionInfo />
    </SessionUserContext.Provider>,
  );
}

describe("SystemVersionInfo — Jetzt aktualisieren", () => {
  it("offers the primary button when an update is available and the installation can run it (AC#1)", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({ canUpdate: true });

    renderCard();

    expect(
      await screen.findByRole("button", { name: /jetzt aktualisieren/i }),
    ).toBeEnabled();
  });

  it("no longer points at a banner that is not on this page (AC#3)", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({ canUpdate: true });

    const { container } = renderCard();
    await screen.findByRole("button", { name: /jetzt aktualisieren/i });

    expect(container.textContent).not.toMatch(/Hinweis oben/i);
    // The reassurance itself stays — it is the reason people dare to press it.
    expect(container.textContent).toMatch(/unangetastet/i);
  });

  it("replaces the button with the server's reason when it cannot self-update (AC#2)", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: false,
      mode: "managed",
      reason: "managed",
      message: "Diese Installation wird über deine Deploy-Plattform aktualisiert.",
      blockers: [],
    });

    renderCard();

    expect(await screen.findByText(/Deploy-Plattform/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /jetzt aktualisieren/i })).toBeNull();
  });

  it("shows the concrete blockers when an updater IS there but misconfigured (AC#2)", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: false,
      mode: "local",
      reason: "blocked",
      message: "Das Update ist derzeit nicht möglich.",
      blockers: ["Compose-Projektname nicht ermittelbar"],
    });

    renderCard();

    expect(
      await screen.findByText("Compose-Projektname nicht ermittelbar"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /jetzt aktualisieren/i })).toBeNull();
  });

  it("shows no button while the capability is still unknown", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    let resolve: (c: { canUpdate: boolean }) => void = () => {};
    vi.spyOn(api, "getUpdateCapability").mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    const { container } = renderCard();
    await screen.findByText("Eine neue Version steht bereit.", { exact: false });
    expect(screen.queryByRole("button", { name: /jetzt aktualisieren/i })).toBeNull();
    // …and nothing claims it is managed either, until we actually know.
    expect(container.textContent).not.toMatch(/Deploy-Plattform/);

    resolve({ canUpdate: true });
    expect(
      await screen.findByRole("button", { name: /jetzt aktualisieren/i }),
    ).toBeInTheDocument();
  });

  it("starts the existing flow and opens the known progress view (AC#1, AC#4)", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({ canUpdate: true });
    vi.spyOn(api, "startUpdate").mockResolvedValue(JOB);
    vi.spyOn(api, "getUpdateJob").mockResolvedValue({
      ...JOB,
      phase: "pull",
      log: ["Image wird geladen …"],
    });

    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /jetzt aktualisieren/i }));

    const dialog = await screen.findByRole("dialog", { name: /update läuft/i });
    expect(api.startUpdate).toHaveBeenCalledTimes(1);
    // Phase track and log tail — the banner's view, not a second one.
    expect(dialog.textContent).toMatch(/Neue Version holen/);
    expect(screen.getByText(/Update angefordert/)).toBeInTheDocument();
  });

  it("keeps the card and explains itself when the start is refused (AC#4)", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({ canUpdate: true });
    vi.spyOn(api, "startUpdate").mockRejectedValue(
      new UpdateApiError(503, "Updates laufen hier über die Deploy-Plattform.", null, "managed"),
    );

    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: /jetzt aktualisieren/i }));

    expect(
      await screen.findByText("Updates laufen hier über die Deploy-Plattform."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The old version keeps running, and the card still says which one.
    expect(screen.getByText("1.11.0")).toBeInTheDocument();
  });

  it("rejoins a job that is already running instead of offering to start another", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: true,
      currentJobId: "running-job",
    });
    vi.spyOn(api, "getUpdateJob").mockResolvedValue({ ...JOB, id: "running-job" });

    renderCard();

    expect(await screen.findByRole("dialog", { name: /update läuft/i })).toBeInTheDocument();
    await waitFor(() => expect(api.getUpdateJob).toHaveBeenCalledWith("running-job"));
  });

  it("mirrors the banner's wording when the updater is misconfigured — same message, same blockers", async () => {
    // Verbatim from the server (`BLOCKED_MESSAGE` + the token blocker in
    // `systemUpdate.ts`). The card must not paraphrase what the banner shows.
    const message =
      "Ein Updater ist installiert, kann aber noch kein Update ausführen. Bis das behoben ist, " +
      "aktualisierst du auf dem manuellen Weg (`git pull && ./install.sh`).";
    const blocker =
      "LOKYY_UPDATER_TOKEN ist im Brain nicht gesetzt — trage bei lokyy-brain und lokyy-updater denselben Wert ein und starte beide neu.";
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: false,
      mode: "local",
      reason: "blocked",
      message,
      blockers: [blocker],
    });

    renderCard();

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByText(blocker)).toBeInTheDocument();
  });

  it("never offers the button to a non-admin — and never probes the updater", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(AVAILABLE);
    const capability = vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: true,
    });

    renderCard("user");

    await screen.findByText("v1.12");
    expect(screen.queryByRole("button", { name: /jetzt aktualisieren/i })).toBeNull();
    expect(capability).not.toHaveBeenCalled();
  });
});

/**
 * Der Live-Befund zu Issue #28: nach „Jetzt prüfen" erschien der Banner auf der
 * Hauptansicht erst nach einem Hard-Reload.
 *
 * `AppLike` reproduziert den echten Aufbau von `App.tsx`: EIN Consumer des
 * Version-States, der bei geöffneten Einstellungen einen anderen Teilbaum
 * rendert (`if (settingsOpen) return <Settings/>`) — der Banner ist währenddessen
 * ausgehängt. Der Test verlangt: prüfen, zurück zur Hauptansicht, Banner da.
 * Kein Reload, kein Neu-Mounten des App-Knotens.
 */
describe("Banner ohne Reload (Issue #28)", () => {
  function AppLike() {
    const { version } = useSystemVersion();
    const [settingsOpen, setSettingsOpen] = useState(true);

    if (settingsOpen) {
      return (
        <div>
          <button type="button" onClick={() => setSettingsOpen(false)}>
            Einstellungen schließen
          </button>
          <SystemVersionInfo />
        </div>
      );
    }
    return <UpdateBanner version={version} />;
  }

  function renderApp(): ReturnType<typeof render> {
    return render(
      <SessionUserContext.Provider
        value={{ userId: "u1", email: "o@example.test", name: "Oliver", role: "admin" }}
      >
        <AppLike />
      </SessionUserContext.Provider>,
    );
  }

  it("shows the banner after a manual check, without a reload", async () => {
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(BASE);
    vi.spyOn(api, "checkSystemVersionNow").mockResolvedValue(FRESH);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({ canUpdate: true });

    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /jetzt prüfen/i }));
    await screen.findByText("v1.12");

    fireEvent.click(screen.getByRole("button", { name: /einstellungen schließen/i }));

    expect(await screen.findByText("Neue Version verfügbar")).toBeInTheDocument();
  });

  it("a manual check lifts a dismissal the user made earlier for that version", async () => {
    // Pressing „Jetzt prüfen" is intent. Staying silent because the banner was
    // closed an hour ago is how the notice gets lost — and no reload would have
    // brought it back, since the dismissal lives in localStorage.
    localStorage.setItem(DISMISS_KEY, "1.12");
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(BASE);
    vi.spyOn(api, "checkSystemVersionNow").mockResolvedValue(FRESH);
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({ canUpdate: true });

    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /jetzt prüfen/i }));
    await screen.findByText("v1.12");
    fireEvent.click(screen.getByRole("button", { name: /einstellungen schließen/i }));

    expect(await screen.findByText("Neue Version verfügbar")).toBeInTheDocument();
    expect(localStorage.getItem(DISMISS_KEY)).toBeNull();
  });

  it("a check that finds nothing leaves an existing dismissal alone", async () => {
    localStorage.setItem(DISMISS_KEY, "1.11");
    vi.spyOn(api, "getSystemVersion").mockResolvedValue(BASE);
    vi.spyOn(api, "checkSystemVersionNow").mockResolvedValue({
      ...FRESH,
      latest: "v1.11",
      updateAvailable: false,
    });

    render(<SystemVersionInfo />);
    fireEvent.click(await screen.findByRole("button", { name: /jetzt prüfen/i }));

    await waitFor(() => expect(api.checkSystemVersionNow).toHaveBeenCalled());
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1.11");
  });
});
