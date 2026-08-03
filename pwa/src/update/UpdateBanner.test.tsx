import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserContext } from "../AuthGate.js";
import { UpdateApiError, api, type SystemVersion, type UpdateJob } from "../api.js";
import { DISMISS_KEY } from "./dismissal.js";
import { UpdateBanner } from "./UpdateBanner.js";

/**
 * Story 7.12 Task 5 — the guarantees a careless refactor would break:
 * the banner stays away when it should (up to date, non-admin, dismissed),
 * dismissal is scoped to ONE version, the changelog is rendered as markdown
 * rather than printed raw, and an installation that cannot self-update gets a
 * sentence instead of a dead button.
 */

const UP_TO_DATE: SystemVersion = {
  running: "1.11.0",
  buildSha: null,
  latest: "v1.11",
  updateAvailable: false,
  highlights: [],
  checkedAt: "2026-08-03T10:00:00.000Z",
  status: "ok",
};

/** Verbatim from the live CHANGELOG.md — raw markdown, as the API delivers it. */
const AVAILABLE: SystemVersion = {
  running: "1.11.0",
  buildSha: null,
  latest: "v1.12",
  updateAvailable: true,
  highlights: [
    "### Lokyy Brain ist jetzt Open Source",
    "- **Lizenz: AGPL-3.0.** Der Quellcode ist öffentlich.",
    "- **Kein GitHub-Login mehr nötig**, um das Repo zu klonen.",
  ],
  checkedAt: "2026-08-03T10:00:00.000Z",
  status: "ok",
};

const JOB: UpdateJob = {
  id: "job-1",
  phase: "preflight",
  running: true,
  startedAt: "2026-08-03T10:00:00.000Z",
  project: "lokyy-brain",
  targetServices: ["lokyy-brain"],
  log: [],
};

function renderBanner(
  version: SystemVersion | null,
  role: string | null = "admin",
): ReturnType<typeof render> {
  const user =
    role === null ? null : { userId: "u1", email: "o@example.test", name: "Oliver", role };
  return render(
    <SessionUserContext.Provider value={user}>
      <UpdateBanner version={version} />
    </SessionUserContext.Provider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api, "getUpdateCapability").mockResolvedValue({ canUpdate: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("UpdateBanner", () => {
  it("stays hidden when the installation is up to date (AC#3)", () => {
    const { container } = renderBanner(UP_TO_DATE);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden while the version payload is still unknown", () => {
    const { container } = renderBanner(null);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden when the check failed — 'unknown' never means 'update' (AC#3)", () => {
    const { container } = renderBanner({
      ...UP_TO_DATE,
      latest: null,
      status: "unknown",
      checkedAt: null,
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("is never shown to a non-admin (AC#10)", () => {
    const { container } = renderBanner(AVAILABLE, "user");
    expect(container).toBeEmptyDOMElement();
  });

  it("shows running and available version to an admin (AC#2)", async () => {
    renderBanner(AVAILABLE);
    expect(await screen.findByText("Neue Version verfügbar")).toBeInTheDocument();
    expect(screen.getByText(/1\.11\.0\s*→\s*v1\.12/)).toBeInTheDocument();
  });

  it("renders the changelog as markdown, not as raw source", async () => {
    const { container } = renderBanner(AVAILABLE);
    await screen.findByText("Neue Version verfügbar");

    // The heading text is there …
    expect(screen.getByText("Lokyy Brain ist jetzt Open Source")).toBeInTheDocument();
    // … and its markers are not.
    expect(container.textContent).not.toContain("###");
    expect(container.textContent).not.toContain("**");
    // `**Lizenz: AGPL-3.0.**` became real emphasis.
    const strong = screen.getByText("Lizenz: AGPL-3.0.");
    expect(strong.tagName).toBe("STRONG");
  });

  it("promises that notes and data stay untouched, and that it takes minutes", async () => {
    renderBanner(AVAILABLE);
    const text = (await screen.findByRole("status")).textContent ?? "";
    expect(text).toMatch(/Notizen/);
    expect(text).toMatch(/unangetastet/);
    expect(text).toMatch(/mehrere Minuten/);
  });

  it("dismissal is per version — closing v1.12 does not silence v1.13 (AC#5)", async () => {
    const first = renderBanner(AVAILABLE);
    fireEvent.click(await screen.findByLabelText("Hinweis schließen"));
    expect(first.container).toBeEmptyDOMElement();
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1.12");
    first.unmount();

    // Same version again → still dismissed.
    const again = renderBanner(AVAILABLE);
    expect(again.container).toBeEmptyDOMElement();
    again.unmount();

    // A NEWER version lifts the dismissal.
    renderBanner({ ...AVAILABLE, latest: "v1.13" });
    expect(await screen.findByText("Neue Version verfügbar")).toBeInTheDocument();
  });

  it("offers the button when the installation can update itself", async () => {
    renderBanner(AVAILABLE);
    expect(await screen.findByText("Jetzt aktualisieren")).toBeInTheDocument();
  });

  it("shows the server's sentence instead of a dead button on Coolify (AC#11)", async () => {
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: false,
      mode: "managed",
      reason: "managed",
      message: "Diese Installation wird über deine Deploy-Plattform aktualisiert.",
      blockers: [],
    });
    renderBanner(AVAILABLE);
    expect(await screen.findByText(/Deploy-Plattform/)).toBeInTheDocument();
    expect(screen.queryByText("Jetzt aktualisieren")).not.toBeInTheDocument();
  });

  it("shows the concrete blockers when an updater IS there but misconfigured", async () => {
    // `blocked` is actionable — a misconfiguration to fix, not "your platform
    // handles it". The admin gets the updater's own reasons.
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: false,
      mode: "local",
      reason: "blocked",
      message: "Das Update ist derzeit nicht möglich.",
      blockers: ["Compose-Projektname nicht ermittelbar"],
    });
    renderBanner(AVAILABLE);
    expect(
      await screen.findByText("Compose-Projektname nicht ermittelbar"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Jetzt aktualisieren")).not.toBeInTheDocument();
  });

  it("does not dress an 'off' or 'unreachable' answer up as 'managed'", async () => {
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: false,
      mode: "off",
      reason: "off",
      message: "Updates über die Oberfläche sind ausgeschaltet.",
      blockers: [],
    });
    renderBanner(AVAILABLE);
    expect(await screen.findByText(/ausgeschaltet/)).toBeInTheDocument();
    expect(screen.queryByText(/Deploy-Plattform/)).not.toBeInTheDocument();
  });

  it("rejoins a job that is already running instead of offering to start one", async () => {
    // The tab was reloaded mid-update, or the brain restarted under us.
    vi.spyOn(api, "getUpdateCapability").mockResolvedValue({
      canUpdate: true,
      currentJobId: "running-job",
    });
    vi.spyOn(api, "getUpdateJob").mockResolvedValue({ ...JOB, id: "running-job" });
    renderBanner(AVAILABLE);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(api.getUpdateJob).toHaveBeenCalledWith("running-job"));
  });

  it("shows no button while the capability is still unknown", async () => {
    let resolve: (c: { canUpdate: boolean }) => void = () => {};
    vi.spyOn(api, "getUpdateCapability").mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderBanner(AVAILABLE);
    await screen.findByText("Neue Version verfügbar");
    expect(screen.queryByText("Jetzt aktualisieren")).not.toBeInTheDocument();
    // …and nothing claims it is managed either, until we actually know.
    expect(screen.queryByText(/Deploy-Plattform/)).not.toBeInTheDocument();
    resolve({ canUpdate: true });
    expect(await screen.findByText("Jetzt aktualisieren")).toBeInTheDocument();
  });

  it("starting the update opens the progress view (AC#6)", async () => {
    vi.spyOn(api, "startUpdate").mockResolvedValue(JOB);
    vi.spyOn(api, "getUpdateJob").mockResolvedValue(JOB);
    renderBanner(AVAILABLE);
    fireEvent.click(await screen.findByText("Jetzt aktualisieren"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(api.startUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps the banner and explains itself when the start is refused", async () => {
    vi.spyOn(api, "startUpdate").mockRejectedValue(
      new UpdateApiError(503, "Updates laufen hier über die Deploy-Plattform.", null, "managed"),
    );
    renderBanner(AVAILABLE);
    fireEvent.click(await screen.findByText("Jetzt aktualisieren"));
    expect(
      await screen.findByText("Updates laufen hier über die Deploy-Plattform."),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("a 409 attaches to the running job — that is not an error (AC#6)", async () => {
    vi.spyOn(api, "startUpdate").mockRejectedValue(
      new UpdateApiError(409, "Ein Update läuft bereits.", "other-job"),
    );
    vi.spyOn(api, "getUpdateJob").mockResolvedValue({ ...JOB, id: "other-job" });
    renderBanner(AVAILABLE);
    fireEvent.click(await screen.findByText("Jetzt aktualisieren"));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(api.getUpdateJob).toHaveBeenCalledWith("other-job"));
    // The refusal never reaches the user as a failure.
    expect(screen.queryByText("Ein Update läuft bereits.")).not.toBeInTheDocument();
  });
});
