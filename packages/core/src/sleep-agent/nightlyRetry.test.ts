import { afterEach, describe, expect, it, vi } from "vitest";

import { SleepAgent } from "./index.js";

type Internals = { running: boolean };

function agentWithSpy() {
  const agent = new SleepAgent();
  const runPhase = vi
    .spyOn(agent, "runPhase")
    .mockResolvedValue({} as Awaited<ReturnType<SleepAgent["runPhase"]>>);
  return { agent, runPhase };
}

describe("nächtlicher REM-Slot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("startet REM um 03:00, wenn nichts läuft", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 16, 2, 50)); // Fr 16.10.2026
    const { agent, runPhase } = agentWithSpy();
    agent.startScheduler({ idleMinutes: 24 * 60 });
    vi.advanceTimersByTime(10 * 60_000);
    expect(runPhase).toHaveBeenCalledWith("rem", "nightly");
    agent.stopScheduler();
  });

  it("holt REM nach, wenn um 03:00 ein NREM-Lauf aktiv ist", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 16, 2, 50));
    const { agent, runPhase } = agentWithSpy();
    agent.startScheduler({ idleMinutes: 24 * 60 });
    (agent as unknown as Internals).running = true; // NREM 02:59–03:01
    vi.advanceTimersByTime(10 * 60_000);
    expect(runPhase).not.toHaveBeenCalled();
    (agent as unknown as Internals).running = false;
    vi.advanceTimersByTime(5 * 60_000);
    expect(runPhase).toHaveBeenCalledTimes(1);
    expect(runPhase).toHaveBeenCalledWith("rem", "nightly");
    agent.stopScheduler();
  });

  it("gibt nach zwei Stunden belegt auf", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 16, 2, 50));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent, runPhase } = agentWithSpy();
    agent.startScheduler({ idleMinutes: 24 * 60 });
    (agent as unknown as Internals).running = true;
    vi.advanceTimersByTime(10 * 60_000 + 25 * 5 * 60_000);
    expect(runPhase).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[sleep-agent] nightly skipped — agent stayed busy",
    );
    agent.stopScheduler();
    warn.mockRestore();
  });
});
