import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, type UpdateJob } from "../api.js";
import { UpdateProgress } from "./UpdateProgress.js";
import { PHASE_STALL_MS, type VersionProbe } from "./pollState.js";

/**
 * Story 7.12 Task 5, AC#6 — the single most damaging way this feature can be
 * wrong is showing an error while the update is SUCCEEDING. During the switch
 * phase the brain restarts, the poll fails, and that must read as "startet neu".
 */

function job(over: Partial<UpdateJob> = {}): UpdateJob {
  return {
    id: "job-1",
    phase: "switch",
    running: true,
    startedAt: "2026-08-03T10:00:00.000Z",
    project: "lokyy-brain",
    targetServices: ["lokyy-brain"],
    log: [],
    ...over,
  };
}

const noRenew = async (): Promise<void> => {};
/** A version endpoint that knows nothing — the rescue line stays silent. */
const noProbe = async (): Promise<VersionProbe> => ({ running: null, latest: null });

describe("UpdateProgress", () => {
  it("reads a dropped connection as 'restarting', not as a failure (AC#6)", async () => {
    const poll = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} probeVersion={noProbe} />,
    );

    expect(await screen.findByText(/startet gerade neu/)).toBeInTheDocument();
    // Nothing on screen calls this a failure, and we keep asking.
    expect(screen.queryByText(/fehlgeschlagen/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/nicht erreichbar/)).not.toBeInTheDocument();
    await waitFor(() => expect(poll.mock.calls.length).toBeGreaterThan(2));
  });

  it("treats a 502 from the proxy in front of a booting brain the same way", async () => {
    const poll = vi.fn().mockRejectedValue(new ApiError(502, "Bad Gateway"));
    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} probeVersion={noProbe} />,
    );
    expect(await screen.findByText(/startet gerade neu/)).toBeInTheDocument();
  });

  it("clears the restart notice as soon as the brain answers again", async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(job({ phase: "verify" }));

    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} probeVersion={noProbe} />,
    );
    await screen.findByText(/startet gerade neu/);
    await waitFor(() =>
      expect(screen.queryByText(/startet gerade neu/)).not.toBeInTheDocument(),
    );
  });

  it("renews the cached shell exactly once after a successful update (AC#7b)", async () => {
    const renew = vi.fn(async () => {});
    const poll = vi
      .fn()
      .mockResolvedValue(job({ phase: "done", running: false, result: "success" }));

    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={renew} probeVersion={noProbe} />,
    );

    await waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/lädt gleich in der neuen Version neu/)).toBeInTheDocument();
    // Give the (stopped) poll loop a chance to misbehave.
    await new Promise((r) => setTimeout(r, 30));
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("says plainly that a failed build left the installation alone (AC#8a)", async () => {
    const poll = vi
      .fn()
      .mockResolvedValue(job({ phase: "build", running: false, result: "build-failed" }));
    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} probeVersion={noProbe} />,
    );
    expect(await screen.findByText(/nicht angefasst/)).toBeInTheDocument();
  });

  it("stops polling once the job is finished", async () => {
    const poll = vi
      .fn()
      .mockResolvedValue(job({ phase: "done", running: false, result: "rolled-back" }));
    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} probeVersion={noProbe} />,
    );
    await screen.findByText(/zurückgesetzt/);
    const calls = poll.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(poll.mock.calls.length).toBe(calls);
  });

  it("surfaces a lost session immediately instead of retrying forever", async () => {
    const poll = vi.fn().mockRejectedValue(new ApiError(403, "forbidden"));
    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} probeVersion={noProbe} />,
    );
    expect(await screen.findByText(/Anmeldung gilt nicht mehr/)).toBeInTheDocument();
  });

  it("attaches to a job it did not start and asks at once (409 / currentJobId)", async () => {
    // No `initialJob`: all we hold is an id, so the first poll must not wait
    // for the interval — otherwise the panel opens empty.
    const poll = vi.fn().mockResolvedValue(job({ phase: "build" }));
    render(
      <UpdateProgress jobId="running-job" onClose={() => {}} poll={poll} pollMs={5000} renew={noRenew} probeVersion={noProbe} />,
    );
    await waitFor(() => expect(poll).toHaveBeenCalledWith("running-job"));
    expect(await screen.findByText("Bauen")).toBeInTheDocument();
  });
});

/**
 * Issue #32 — a minutes-long phase with a motionless dot reads as "frozen".
 * Three signals answer that, and all three have to survive a refactor: the
 * active step MOVES, the longest step SAYS it is the longest, and a running
 * clock proves the whole thing is alive.
 */
describe("UpdateProgress — Lebenszeichen (Issue #32)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("animates the marker of the active step and leaves the others still", async () => {
    const poll = vi.fn().mockResolvedValue(job({ phase: "build" }));
    render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "build" })}
        onClose={() => {}}
        poll={poll}
        pollMs={5000}
        renew={noRenew}
        probeVersion={noProbe}
      />,
    );

    const active = screen.getByTestId("phase-marker-build");
    expect(active.style.animation).toContain("lokyy-update-pulse");
    // Neither the step already done nor the one still ahead may move.
    expect(screen.getByTestId("phase-marker-pull").style.animation).toBe("");
    expect(screen.getByTestId("phase-marker-verify").style.animation).toBe("");
  });

  it("stops the animation once the job has finished", async () => {
    const poll = vi
      .fn()
      .mockResolvedValue(job({ phase: "done", running: false, result: "success" }));
    render(
      <UpdateProgress jobId="job-1" onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} probeVersion={noProbe} />,
    );

    await screen.findByRole("heading", { name: /Update abgeschlossen/ });
    for (const phase of ["build", "switch", "done"]) {
      expect(screen.getByTestId(`phase-marker-${phase}`).style.animation).toBe("");
    }
  });

  it("warns under the build step that it takes the longest — only while it runs", async () => {
    const poll = vi.fn().mockResolvedValue(job({ phase: "build" }));
    const { rerender } = render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "build" })}
        onClose={() => {}}
        poll={poll}
        pollMs={5000}
        renew={noRenew}
        probeVersion={noProbe}
      />,
    );

    const hint = await screen.findByText(/dauert am längsten/i);
    expect(hint).toHaveTextContent(/mehrere Minuten/i);
    expect(hint).toHaveTextContent(/solange sich die zeit unten bewegt, arbeitet lokyy/i);

    // A different phase, same component — the hint belongs to „Bauen" alone.
    rerender(
      <UpdateProgress
        jobId="job-2"
        initialJob={job({ phase: "verify" })}
        onClose={() => {}}
        poll={vi.fn().mockResolvedValue(job({ phase: "verify" }))}
        pollMs={5}
        renew={noRenew}
        probeVersion={noProbe}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByText(/dauert am längsten/i)).not.toBeInTheDocument(),
    );
  });

  it("runs a clock from the job's own start time, second by second", async () => {
    // Anchor the fake clock ON the job's `startedAt`, so 0 elapsed is the truth
    // at first paint and every later value is purely the time we advance.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-03T10:00:00.000Z"));

    const poll = vi.fn().mockResolvedValue(job({ phase: "build" }));
    render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "build" })}
        onClose={() => {}}
        poll={poll}
        pollMs={60_000}
        renew={noRenew}
        probeVersion={noProbe}
      />,
    );

    const clock = screen.getByRole("timer");
    expect(clock).toHaveTextContent("00:00");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(clock).toHaveTextContent("00:01");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(64_000);
    });
    expect(clock).toHaveTextContent("01:05");
  });

  it("keeps counting past an hour instead of wrapping back to zero", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-03T10:00:00.000Z"));

    render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "build" })}
        onClose={() => {}}
        poll={vi.fn().mockResolvedValue(job({ phase: "build" }))}
        pollMs={60_000}
        renew={noRenew}
        probeVersion={noProbe}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_723_000); // 62:03
    });
    expect(screen.getByRole("timer")).toHaveTextContent("62:03");
  });

  it("falls back to the mount time when the job carries no usable start time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-03T10:00:00.000Z"));

    render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "build", startedAt: "kaputt" })}
        onClose={() => {}}
        poll={vi.fn().mockResolvedValue(job({ phase: "build", startedAt: "kaputt" }))}
        pollMs={60_000}
        renew={noRenew}
        probeVersion={noProbe}
      />,
    );

    expect(screen.getByRole("timer")).toHaveTextContent("00:00");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("00:02");
  });
});

/**
 * Issue #36 — observed v1.12.3 → v1.12.4: the dialog sat on „Prüfen" from the
 * first frame to the end while the update completed perfectly in the
 * background. Everything below is about never showing a dead process again.
 */
describe("UpdateProgress — Stillstand (Issue #36)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * The regression test for the actual bug, and the reason it does NOT pass a
   * `poll` prop: the fault lived in the DEFAULT parameter. A test that hands in
   * its own stable function reproduces nothing — which is exactly why every
   * existing test here was green while production froze.
   */
  it("keeps polling although the clock re-renders it every second (root cause)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-03T10:00:00.000Z"));
    const getJob = vi
      .spyOn(api, "getUpdateJob")
      .mockResolvedValue(job({ phase: "preflight" }));
    vi.spyOn(api, "getSystemVersion").mockResolvedValue({
      running: "1.12.3",
      buildSha: null,
      latest: "1.12.4",
      updateAvailable: true,
      highlights: [],
      checkedAt: null,
      status: "ok",
    });

    // No `poll`, no `pollMs`: the production wiring, verbatim (UpdateBanner.tsx).
    render(<UpdateProgress jobId="job-1" initialJob={job({ phase: "preflight" })} onClose={() => {}} />);

    // ONE SECOND PER STEP, and that is the whole point. A single nine-second
    // advance would pass even with the bug, because `act` holds every render
    // back until its scope closes and the poll timers then run undisturbed —
    // the browser has no such mercy. Stepping makes the clock's render land
    // BETWEEN the poll timers, which is exactly the interleaving that starved
    // the loop in production: with the bug this ends at 0 calls.
    for (let second = 0; second < 9; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(getJob.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("shows a calm notice once a phase overruns its budget (AC#2)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-03T10:00:00.000Z"));
    const poll = vi.fn().mockResolvedValue(job({ phase: "preflight" }));

    render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "preflight" })}
        onClose={() => {}}
        poll={poll}
        pollMs={1000}
        renew={noRenew}
        probeVersion={noProbe}
      />,
    );

    // Well inside the budget: nothing is said, because nothing is wrong yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.queryByText(/dauert länger als üblich/)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHASE_STALL_MS.preflight);
    });
    expect(screen.getByText(/dauert länger als üblich/)).toBeInTheDocument();
    // A notice, not a failure — and the dialog keeps working in the background.
    expect(screen.queryByText(/fehlgeschlagen/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hintergrund/ })).toBeInTheDocument();
  });

  it("leaves the long build alone for as long as a build takes (AC#2)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const poll = vi.fn().mockResolvedValue(job({ phase: "build" }));

    render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "build" })}
        onClose={() => {}}
        poll={poll}
        pollMs={5000}
        renew={noRenew}
        probeVersion={noProbe}
      />,
    );

    // Three minutes into „Bauen" is normal and must stay silent — the same
    // three minutes in „Prüfen" would already have raised the notice.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(screen.queryByText(/dauert länger als üblich/)).not.toBeInTheDocument();
  });

  it("declares success when the server reports the new version (AC#3)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The job never moves and never finishes — the phases are useless here.
    const poll = vi.fn().mockResolvedValue(job({ phase: "preflight" }));
    const probeVersion = vi
      .fn<() => Promise<VersionProbe>>()
      .mockResolvedValueOnce({ running: "1.12.3", latest: "1.12.4" }) // baseline
      .mockResolvedValue({ running: "1.12.4", latest: "1.12.4" }); // it landed

    render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "preflight" })}
        onClose={() => {}}
        poll={poll}
        pollMs={1000}
        renew={noRenew}
        probeVersion={probeVersion}
        versionProbeMs={10_000}
      />,
    );

    // Two advances on purpose: `act` commits the render that starts the rescue
    // line only when its scope closes, so the probe's own timer belongs to the
    // next one. A browser has no such boundary — it fires straight away.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHASE_STALL_MS.preflight + 2000);
    });
    expect(screen.getByText(/dauert länger als üblich/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.getByRole("heading", { name: /Update abgeschlossen/ })).toBeInTheDocument();
    expect(screen.getByText(/neue Version läuft bereits/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Jetzt neu laden/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Schließen/ })).toBeInTheDocument();

    // Verdict reached — nothing keeps asking.
    const pollCalls = poll.mock.calls.length;
    const probeCalls = probeVersion.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(poll.mock.calls.length).toBeLessThanOrEqual(pollCalls + 1);
    expect(probeVersion.mock.calls.length).toBe(probeCalls);
  });

  it("offers the reload rather than performing it (AC#3)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const renew = vi.fn(async () => {});
    const probeVersion = vi
      .fn<() => Promise<VersionProbe>>()
      .mockResolvedValueOnce({ running: "1.12.3", latest: "1.12.4" })
      .mockResolvedValue({ running: "1.12.4", latest: "1.12.4" });

    render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "preflight" })}
        onClose={() => {}}
        poll={vi.fn().mockResolvedValue(job({ phase: "preflight" }))}
        pollMs={1000}
        renew={renew}
        probeVersion={probeVersion}
        versionProbeMs={10_000}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHASE_STALL_MS.preflight + 2000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // The job never confirmed, so the page is not yanked out from under anyone.
    expect(renew).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByRole("button", { name: /Jetzt neu laden/ }).click();
    });
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("ends honestly when neither the job nor the version ever answers (AC#4)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const poll = vi.fn().mockResolvedValue(job({ phase: "preflight" }));
    // The server keeps answering, and keeps saying the old version.
    const probeVersion = vi
      .fn<() => Promise<VersionProbe>>()
      .mockResolvedValue({ running: "1.12.3", latest: "1.12.4" });

    const pollMs = 500;
    render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "preflight" })}
        onClose={() => {}}
        poll={poll}
        pollMs={pollMs}
        renew={noRenew}
        probeVersion={probeVersion}
        versionProbeMs={10_000}
      />,
    );

    // Stall threshold plus one full restart window (150 × 500 ms).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHASE_STALL_MS.preflight + 150 * pollMs + 2000);
    });

    expect(screen.getByText(/nicht sicher feststellen/)).toBeInTheDocument();
    expect(screen.getByText(/Einstellungen → System/)).toBeInTheDocument();
    // No spinner-forever, no invented verdict.
    expect(screen.getByRole("button", { name: /Schließen/ })).toBeInTheDocument();
    expect(screen.queryByText(/abgeschlossen/i)).not.toBeInTheDocument();

    const calls = poll.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(poll.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });

  it("keeps a real phase change clear of all of it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const poll = vi
      .fn()
      .mockResolvedValueOnce(job({ phase: "preflight" }))
      .mockResolvedValue(job({ phase: "build" }));

    render(
      <UpdateProgress
        jobId="job-1"
        initialJob={job({ phase: "preflight" })}
        onClose={() => {}}
        poll={poll}
        pollMs={1000}
        renew={noRenew}
        probeVersion={noProbe}
      />,
    );

    // Moves into „Bauen" early, so the phase clock restarts against the build's
    // own budget — a healthy update never sees a word of this.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHASE_STALL_MS.preflight + 30_000);
    });
    expect(screen.queryByText(/dauert länger als üblich/)).not.toBeInTheDocument();
    expect(screen.queryByText(/nicht sicher feststellen/)).not.toBeInTheDocument();
  });
});
