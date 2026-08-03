import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupGate } from "./SetupGate.js";

/**
 * Story 1.21 — the regression these tests exist for.
 *
 * `SetupGate` used to do `catch { setState("ready") }`: a FAILED
 * `/api/setup/status` fetch was read as "setup is complete", the app shell
 * rendered, and a fresh install landed on the LOGIN form with no credentials
 * to enter. On a fresh install nginx serves the static PWA long before the
 * brain has migrated, so that first fetch reliably fails (or 502s) — the bug
 * was not an edge case, it was the default path.
 *
 * The invariant locked in below: **a failing status fetch must never render
 * children.** Everything else (retry bounds, waiting text, error state) is in
 * service of that.
 *
 * The wizard is stubbed — this is a test of the gate's branching, not of
 * SetupWizard's own network calls.
 */

vi.mock("./SetupWizard.js", () => ({
  SetupWizard: () => <div data-testid="wizard">Setup-Wizard</div>,
}));

/** Tight bounds so the whole suite runs in fake-timer microseconds. */
const DELAY = 10;
const ATTEMPTS = 3;

const fetchMock = vi.fn();

function statusResponse(setupComplete: boolean) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ setupComplete }),
  } as unknown as Response;
}

/** nginx answering while the brain still boots — the production failure shape. */
function httpError(status: number) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error("json() must not be called on a non-ok response");
    },
  } as unknown as Response;
}

function renderGate() {
  return render(
    <SetupGate retryDelayMs={DELAY} maxAttempts={ATTEMPTS}>
      <div data-testid="app-shell">Login-Formular</div>
    </SetupGate>,
  );
}

/**
 * Advance fake timers *and* flush the promise chain inside `poll()`
 * (fetch → res.json → setState). `advanceTimersByTimeAsync` awaits
 * microtasks between timer callbacks, so a single call covers both.
 * RTL's `waitFor`/`findBy*` cannot be used here: they detect Jest's fake
 * timers only, and would hang on Vitest's.
 */
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The children/login branch — the one a failed fetch must never reach. */
function shellRendered() {
  return screen.queryByTestId("app-shell") !== null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("SetupGate failure path (AC#5)", () => {
  it("does not render children when the status fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    renderGate();
    await tick();

    expect(shellRendered()).toBe(false);
    expect(screen.queryByTestId("wizard")).not.toBeInTheDocument();
    expect(screen.getByText(/warte auf den Server/)).toBeInTheDocument();
  });

  it("treats a 502 from nginx as a failure, not as an answer", async () => {
    // The production shape: the proxy is up, the brain is not.
    fetchMock.mockResolvedValue(httpError(502));

    renderGate();
    await tick();

    expect(shellRendered()).toBe(false);
    expect(screen.getByText(/warte auf den Server/)).toBeInTheDocument();
  });

  it("counts attempts in the waiting state so the wait is visible", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));

    renderGate();
    await tick();

    expect(screen.getByText(`lokyy-brain · warte auf den Server … (Versuch 2/${ATTEMPTS})`))
      .toBeInTheDocument();
  });

  it("bounds the retries and ends in an explicit error state, never the login", async () => {
    fetchMock.mockRejectedValue(new Error("still booting"));

    renderGate();
    await tick();
    // Generous overshoot: proves the loop stops on its own, not that it
    // happens to be mid-flight when we stop looking.
    await tick(DELAY * (ATTEMPTS + 5));

    expect(fetchMock).toHaveBeenCalledTimes(ATTEMPTS);
    expect(shellRendered()).toBe(false);
    expect(screen.getByText(/Der Server antwortet nicht/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Erneut versuchen/ })).toBeInTheDocument();
  });

  it("recovers to children when a retry finally succeeds with setupComplete: true", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("cold boot"))
      .mockResolvedValueOnce(statusResponse(true));

    renderGate();
    await tick();
    expect(shellRendered()).toBe(false); // still waiting, not guessing

    await tick(DELAY);

    expect(shellRendered()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers to the wizard when a retry finally succeeds with setupComplete: false", async () => {
    // The fresh-install case that the bug destroyed.
    fetchMock
      .mockResolvedValueOnce(httpError(502))
      .mockResolvedValueOnce(statusResponse(false));

    renderGate();
    await tick();
    await tick(DELAY);

    expect(screen.getByTestId("wizard")).toBeInTheDocument();
    expect(shellRendered()).toBe(false);
  });

  it("retries from scratch when the user clicks 'Erneut versuchen'", async () => {
    fetchMock.mockRejectedValue(new Error("down"));

    renderGate();
    await tick();
    await tick(DELAY * ATTEMPTS);
    expect(screen.getByText(/Der Server antwortet nicht/)).toBeInTheDocument();

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(statusResponse(false));
    fireEvent.click(screen.getByRole("button", { name: /Erneut versuchen/ }));
    await tick();

    expect(screen.getByTestId("wizard")).toBeInTheDocument();
  });

  it("cancels the pending retry on unmount so no timer leaks into the next test", async () => {
    fetchMock.mockRejectedValue(new Error("down"));

    const { unmount } = renderGate();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();
    await tick(DELAY * (ATTEMPTS + 5));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("SetupGate happy paths stay untouched", () => {
  it("renders children when setup is complete", async () => {
    fetchMock.mockResolvedValue(statusResponse(true));

    renderGate();
    await tick();

    expect(shellRendered()).toBe(true);
    expect(screen.queryByTestId("wizard")).not.toBeInTheDocument();
  });

  it("renders the wizard when setup is incomplete", async () => {
    fetchMock.mockResolvedValue(statusResponse(false));

    renderGate();
    await tick();

    expect(screen.getByTestId("wizard")).toBeInTheDocument();
    expect(shellRendered()).toBe(false);
  });
});
