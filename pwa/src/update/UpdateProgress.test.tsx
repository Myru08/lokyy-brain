import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type UpdateJob } from "../api.js";
import { UpdateProgress } from "./UpdateProgress.js";

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

describe("UpdateProgress", () => {
  it("reads a dropped connection as 'restarting', not as a failure (AC#6)", async () => {
    const poll = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} />,
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
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} />,
    );
    expect(await screen.findByText(/startet gerade neu/)).toBeInTheDocument();
  });

  it("clears the restart notice as soon as the brain answers again", async () => {
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(job({ phase: "verify" }));

    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} />,
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
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={renew} />,
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
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} />,
    );
    expect(await screen.findByText(/nicht angefasst/)).toBeInTheDocument();
  });

  it("stops polling once the job is finished", async () => {
    const poll = vi
      .fn()
      .mockResolvedValue(job({ phase: "done", running: false, result: "rolled-back" }));
    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} />,
    );
    await screen.findByText(/zurückgesetzt/);
    const calls = poll.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(poll.mock.calls.length).toBe(calls);
  });

  it("surfaces a lost session immediately instead of retrying forever", async () => {
    const poll = vi.fn().mockRejectedValue(new ApiError(403, "forbidden"));
    render(
      <UpdateProgress jobId="job-1" initialJob={job()} onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} />,
    );
    expect(await screen.findByText(/Anmeldung gilt nicht mehr/)).toBeInTheDocument();
  });

  it("attaches to a job it did not start and asks at once (409 / currentJobId)", async () => {
    // No `initialJob`: all we hold is an id, so the first poll must not wait
    // for the interval — otherwise the panel opens empty.
    const poll = vi.fn().mockResolvedValue(job({ phase: "build" }));
    render(
      <UpdateProgress jobId="running-job" onClose={() => {}} poll={poll} pollMs={5000} renew={noRenew} />,
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
      <UpdateProgress jobId="job-1" onClose={() => {}} poll={poll} pollMs={5} renew={noRenew} />,
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
      />,
    );

    expect(screen.getByRole("timer")).toHaveTextContent("00:00");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole("timer")).toHaveTextContent("00:02");
  });
});
