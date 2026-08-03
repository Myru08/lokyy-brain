import { describe, expect, it } from "vitest";
import { ApiError, UpdateApiError, type UpdateJob } from "../api.js";
import {
  INITIAL_POLL_STATE,
  MAX_RESTART_POLLS,
  classifyPollError,
  isFinished,
  isSuccess,
  nextPollState,
  resultMessage,
} from "./pollState.js";

function job(over: Partial<UpdateJob> = {}): UpdateJob {
  return {
    id: "job-1",
    phase: "build",
    running: true,
    startedAt: "2026-08-03T10:00:00.000Z",
    project: "lokyy-brain",
    targetServices: ["lokyy-brain", "lokyy-pwa", "lokyy-mcp"],
    log: [],
    ...over,
  };
}

describe("classifyPollError (AC#6)", () => {
  it("reads a dropped connection as a restart, not an error", () => {
    // What the browser throws when the container goes away mid-poll.
    expect(classifyPollError(new TypeError("Failed to fetch"))).toEqual({
      kind: "restarting",
    });
  });

  it("reads proxy and server errors as a restart", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyPollError(new ApiError(status, "x")).kind).toBe("restarting");
    }
  });

  it("follows the server's `retryable` flag over the status code", () => {
    // Two different 503s exist. `updater-unreachable` is the restart window …
    expect(
      classifyPollError(
        new UpdateApiError(503, "Der Updater antwortet gerade nicht.", null, null, true),
      ).kind,
    ).toBe("restarting");

    // … and `update-unavailable` is structurally unfixable by waiting.
    const dead = classifyPollError(
      new UpdateApiError(
        503,
        "Für diese Installation ist kein Updater eingerichtet.",
        null,
        "managed",
        false,
      ),
    );
    expect(dead.kind).toBe("denied");
    expect(dead.kind === "denied" && dead.message).toMatch(/kein Updater/);
  });

  it("reads a 404 as terminal, NOT as a restart", () => {
    // Job state lives in the updater, which excludes itself from the restart,
    // so an id stays resolvable while the brain is down. A 404 is therefore a
    // real bug — retrying would hide it behind five minutes of spinning.
    const outcome = classifyPollError(new ApiError(404, "unknown-job"));
    expect(outcome.kind).toBe("denied");
    expect(outcome.kind === "denied" && outcome.message).toMatch(/nicht bekannt/);
  });

  it("reads a 400 as terminal — a malformed id is our own bug", () => {
    expect(classifyPollError(new ApiError(400, "invalid-job-id")).kind).toBe("denied");
  });

  it("reads 401/403 as terminal — retrying an auth failure is futile", () => {
    expect(classifyPollError(new ApiError(401, "x")).kind).toBe("denied");
    expect(classifyPollError(new ApiError(403, "x")).kind).toBe("denied");
  });

  it("says the update keeps running when the session expires", () => {
    const outcome = classifyPollError(new ApiError(401, "x"));
    expect(outcome.kind === "denied" && outcome.message).toMatch(/läuft davon unbeeindruckt/);
  });
});

describe("nextPollState (AC#6)", () => {
  it("a failed poll surfaces as 'restarting', never as an error", () => {
    const state = nextPollState(
      { ...INITIAL_POLL_STATE, job: job({ phase: "switch" }) },
      { kind: "restarting" },
    );
    expect(state.restarting).toBe(true);
    expect(state.error).toBeNull();
    // The last known phase stays on screen — no blink back to "unknown".
    expect(state.job?.phase).toBe("switch");
  });

  it("keeps retrying across a long restart and recovers cleanly", () => {
    let state: typeof INITIAL_POLL_STATE = {
      ...INITIAL_POLL_STATE,
      job: job({ phase: "switch" }),
    };
    for (let i = 0; i < 60; i += 1) {
      state = nextPollState(state, { kind: "restarting" });
      expect(state.error).toBeNull();
      expect(state.restarting).toBe(true);
    }
    // The brain is back.
    state = nextPollState(state, {
      kind: "job",
      job: job({ phase: "done", running: false, result: "success" }),
    });
    expect(state.restarting).toBe(false);
    expect(state.failures).toBe(0);
    expect(state.error).toBeNull();
    expect(isSuccess(state.job)).toBe(true);
  });

  it("gives up only after the restart window has really elapsed", () => {
    let state = { ...INITIAL_POLL_STATE, job: job() };
    for (let i = 0; i < MAX_RESTART_POLLS; i += 1) {
      state = nextPollState(state, { kind: "restarting" });
    }
    expect(state.error).toBeNull();
    state = nextPollState(state, { kind: "restarting" });
    expect(state.error).toMatch(/nicht erreichbar/);
    expect(state.restarting).toBe(false);
  });

  it("surfaces a denial immediately", () => {
    const state = nextPollState({ ...INITIAL_POLL_STATE, job: job() }, {
      kind: "denied",
      message: "Deine Anmeldung gilt nicht mehr.",
    });
    expect(state.error).toMatch(/Anmeldung/);
    expect(state.restarting).toBe(false);
  });
});

describe("job outcome helpers", () => {
  it("recognises terminal states", () => {
    expect(isFinished(job())).toBe(false);
    expect(isFinished(job({ result: "success" }))).toBe(true);
    expect(isFinished(null)).toBe(false);
  });

  it("counts 'already up to date' as a success", () => {
    expect(isSuccess(job({ result: "already-up-to-date" }))).toBe(true);
    expect(isSuccess(job({ result: "rolled-back" }))).toBe(false);
  });

  it("explains a failed build as harmless to the running installation (AC#8a)", () => {
    const msg = resultMessage(job({ result: "build-failed", running: false }));
    expect(msg.text).toMatch(/nicht angefasst/);
    expect(msg.text).toMatch(/läuft unverändert weiter/);
  });

  it("explains a rollback and reassures about the data (AC#8b)", () => {
    const msg = resultMessage(job({ result: "rolled-back", running: false }));
    expect(msg.text).toMatch(/zurückgesetzt/);
    expect(msg.text).toMatch(/Notizen/);
  });

  it("pins WHICH results pass the updater's own message through", () => {
    // The updater's `job.message` is still English (`updater/src/update.ts`),
    // so every branch that renders it is a place where a German panel flips
    // to English at the worst possible moment. This test fixes the exposure
    // surface at exactly three branches so it cannot silently widen while
    // Task 3 translates at the source.
    const foreign = "THE-UPDATERS-OWN-WORDS";

    // Ignored — these two carry their own German explanation.
    for (const result of ["build-failed", "rolled-back"] as const) {
      const msg = resultMessage(job({ result, running: false, message: foreign }));
      expect(msg.text).not.toContain(foreign);
    }

    // Passed through — the updater's reason here is specific and actionable
    // ("working copy has local changes"), and inventing a German replacement
    // in the UI would mean guessing what happened.
    for (const result of ["aborted", "failed"] as const) {
      const msg = resultMessage(job({ result, running: false, message: foreign }));
      expect(msg.text).toContain(foreign);
    }
  });

  it("never leaves a result without a next step", () => {
    for (const result of [
      "success",
      "already-up-to-date",
      "aborted",
      "build-failed",
      "rolled-back",
      "failed",
    ] as const) {
      const msg = resultMessage(job({ result, running: false }));
      expect(msg.text.trim().length).toBeGreaterThan(20);
    }
  });
});
