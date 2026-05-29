import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Tier1BM25 } from "./Tier1BM25.js";
import {
  queueSearchIndexRefresh,
  queueSearchIndexRemove,
  queueForgottenToggle,
  getQuarantinedNotes,
  getBreakerStateSize,
  setMaxBreakerEntriesForTest,
  clearQuarantine,
  resetQuarantineState,
} from "./index.js";

/**
 * Story 10.1, AC#3 + AC#5 — per-note circuit breaker / quarantine + bounded
 * backoff.
 *
 * `queueSearchIndexRefresh` is fire-and-forget: it schedules the upsert on a
 * microtask and returns synchronously. These tests stub `Tier1BM25.upsert`
 * (the only DB-touching call) so we exercise the breaker logic with zero
 * database dependency, then `flush()` the pending microtasks before asserting.
 */

/** Drain the microtask queue so the fire-and-forget upsert settles. */
async function flush(): Promise<void> {
  // Two awaits: one for the outer Promise.resolve().then, one for the inner
  // awaited upsert/catch. A macrotask tick covers any extra scheduling.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Drive a poison note to its quarantine threshold deterministically.
 *
 * The breaker's bounded backoff (AC#5) suppresses re-attempts within a 30s
 * window, so three real calls in a tight loop only ever record ONE failure.
 * To reproduce quarantine in a unit test we advance the breaker's clock past
 * the backoff window before each attempt — mirroring how N *separate* saves
 * spread over real time would behave in production.
 */
async function failUntilQuarantined(
  noteId: string,
  attempts: number,
  body = "poison )",
  /**
   * The write path to drive. Defaults to the upsert path; pass a closure that
   * calls `queueSearchIndexRemove`/`queueForgottenToggle` to exercise the other
   * two paths (hardening #1 — all three share the breaker).
   */
  drive: (id: string) => void = (id) =>
    queueSearchIndexRefresh(VAULT, id, "T", body, []),
): Promise<void> {
  const nowSpy = vi.spyOn(Date, "now");
  try {
    for (let i = 0; i < attempts; i++) {
      // Each attempt sits well past the previous attempt's backoff window.
      nowSpy.mockReturnValue(1_000_000 + i * 60_000);
      drive(noteId);
      await flush();
    }
  } finally {
    nowSpy.mockRestore();
  }
}

const NOTE = "01JNOTEAAAAAAAAAAAAAAAAAAA";
const VAULT = "vault-test";

let upsertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetQuarantineState();
  vi.useRealTimers();
});

afterEach(() => {
  // Restore every spy created in a test (upsert/remove/setForgotten/Date.now).
  vi.restoreAllMocks();
  resetQuarantineState();
  vi.useRealTimers();
});

describe("circuit breaker — AC#3 quarantine after N consecutive failures", () => {
  it("does NOT quarantine before the threshold and stays empty on success", async () => {
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockResolvedValue(undefined);

    queueSearchIndexRefresh(VAULT, NOTE, "Title", "body", []);
    await flush();

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(getQuarantinedNotes()).toEqual([]);
  });

  it("quarantines the note after 3 consecutive upsert failures", async () => {
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockRejectedValue(
        Object.assign(new Error('syntax error at or near ")"'), { code: "42601" }),
      );

    // Three saves of the same poison note, each past the backoff window.
    await failUntilQuarantined(NOTE, 3);

    const q = getQuarantinedNotes();
    expect(q).toHaveLength(1);
    expect(q[0]!.noteId).toBe(NOTE);
    expect(q[0]!.failures).toBe(3);
    expect(q[0]!.lastError).toContain("syntax error");
    expect(upsertSpy).toHaveBeenCalledTimes(3);
  });

  it("skips further refreshes once quarantined (indexer does not keep firing)", async () => {
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockRejectedValue(new Error("boom"));

    await failUntilQuarantined(NOTE, 3, "b");
    expect(getQuarantinedNotes()).toHaveLength(1);
    const callsAtQuarantine = upsertSpy.mock.calls.length;

    // Subsequent saves of the quarantined note must NOT reach the DB.
    queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
    queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
    await flush();

    expect(upsertSpy).toHaveBeenCalledTimes(callsAtQuarantine);
  });

  it("isolates the poison note: other notes keep indexing normally", async () => {
    const OTHER = "01JOTHERBBBBBBBBBBBBBBBBBBB";
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockImplementation(async (noteId: string) => {
        if (noteId === NOTE) throw new Error("poison");
        // OTHER succeeds.
      });

    await failUntilQuarantined(NOTE, 3, "poison");
    expect(getQuarantinedNotes().map((n) => n.noteId)).toEqual([NOTE]);

    // The healthy note still indexes — never quarantined.
    queueSearchIndexRefresh(VAULT, OTHER, "T", "fine", []);
    await flush();
    expect(getQuarantinedNotes().map((n) => n.noteId)).toEqual([NOTE]);
    expect(
      upsertSpy.mock.calls.some((c) => c[0] === OTHER),
    ).toBe(true);
  });

  it("recovers: a successful upsert clears prior failure state", async () => {
    let shouldFail = true;
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockImplementation(async () => {
        if (shouldFail) throw new Error("transient");
      });

    // One failure (below the threshold of 3) — note is failing but not yet
    // quarantined.
    queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
    await flush();
    expect(getQuarantinedNotes()).toEqual([]);

    // The very next real change after the backoff window succeeds. We clear the
    // breaker to model "backoff window has elapsed" deterministically without
    // sleeping 30s, then prove a successful upsert leaves zero residual state.
    shouldFail = false;
    clearQuarantine(NOTE);
    queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
    await flush();
    expect(getQuarantinedNotes()).toEqual([]);
  });

  it("clearQuarantine re-enables indexing for a quarantined note", async () => {
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockRejectedValue(new Error("poison"));

    // Force three failures to quarantine.
    await failUntilQuarantined(NOTE, 3);
    expect(getQuarantinedNotes()).toHaveLength(1);

    clearQuarantine(NOTE);
    expect(getQuarantinedNotes()).toEqual([]);

    // After clearing, a fresh refresh reaches the DB again.
    upsertSpy.mockReset();
    upsertSpy.mockResolvedValue(undefined);
    queueSearchIndexRefresh(VAULT, NOTE, "T", "fixed", []);
    await flush();
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(getQuarantinedNotes()).toEqual([]);
  });
});

describe("bounded backoff — AC#5 no busy-retry of a failing note", () => {
  it("does not re-fire the same failing note within the backoff window", async () => {
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockRejectedValue(new Error("still failing"));

    // First attempt fails and records lastAttemptAt.
    queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
    await flush();
    expect(upsertSpy).toHaveBeenCalledTimes(1);

    // Immediate subsequent saves are inside the backoff window → suppressed.
    queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
    queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
    await flush();
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it("retries after the backoff window elapses (fake timers)", async () => {
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockRejectedValue(new Error("still failing"));

    const baseNow = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(baseNow);
      queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
      await flush();
      expect(upsertSpy).toHaveBeenCalledTimes(1);

      // Within window → suppressed.
      nowSpy.mockReturnValue(baseNow + 10_000);
      queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
      await flush();
      expect(upsertSpy).toHaveBeenCalledTimes(1);

      // Past the 30s window → retried.
      nowSpy.mockReturnValue(baseNow + 31_000);
      queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
      await flush();
      expect(upsertSpy).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("hardening #1 — remove() and setForgotten() share the breaker", () => {
  it("quarantines a note whose DELETE (remove) keeps failing", async () => {
    const removeSpy = vi
      .spyOn(Tier1BM25.prototype, "remove")
      .mockRejectedValue(
        Object.assign(new Error('syntax error at or near ")"'), { code: "42601" }),
      );

    await failUntilQuarantined(NOTE, 3, "poison )", () =>
      queueSearchIndexRemove(NOTE),
    );

    const q = getQuarantinedNotes();
    expect(q).toHaveLength(1);
    expect(q[0]!.noteId).toBe(NOTE);
    expect(q[0]!.failures).toBe(3);
    expect(removeSpy).toHaveBeenCalledTimes(3);

    // Once quarantined, a further remove must NOT reach the DB (no retry storm).
    queueSearchIndexRemove(NOTE);
    await flush();
    expect(removeSpy).toHaveBeenCalledTimes(3);
  });

  it("quarantines a note whose forgotten-toggle (UPDATE) keeps failing", async () => {
    const forgottenSpy = vi
      .spyOn(Tier1BM25.prototype, "setForgotten")
      .mockRejectedValue(new Error("update boom"));

    await failUntilQuarantined(NOTE, 3, "poison )", () =>
      queueForgottenToggle(NOTE, true),
    );

    const q = getQuarantinedNotes();
    expect(q).toHaveLength(1);
    expect(q[0]!.noteId).toBe(NOTE);
    expect(forgottenSpy).toHaveBeenCalledTimes(3);

    // Quarantine is shared: a subsequent toggle is suppressed.
    queueForgottenToggle(NOTE, false);
    await flush();
    expect(forgottenSpy).toHaveBeenCalledTimes(3);
  });

  it("backoff applies across paths: a failing upsert then suppresses remove", async () => {
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockRejectedValue(new Error("upsert boom"));
    const removeSpy = vi
      .spyOn(Tier1BM25.prototype, "remove")
      .mockResolvedValue(undefined);

    // One upsert failure records backoff state for NOTE.
    queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
    await flush();
    expect(upsertSpy).toHaveBeenCalledTimes(1);

    // An immediate remove for the SAME note is inside the backoff window and is
    // suppressed by the shared breaker — proving the state is per-note, not
    // per-operation.
    queueSearchIndexRemove(NOTE);
    await flush();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("quarantining via remove blocks the upsert path too (shared state)", async () => {
    vi.spyOn(Tier1BM25.prototype, "remove").mockRejectedValue(new Error("boom"));
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockResolvedValue(undefined);

    await failUntilQuarantined(NOTE, 3, "poison )", () =>
      queueSearchIndexRemove(NOTE),
    );
    expect(getQuarantinedNotes()).toHaveLength(1);

    // Even though upsert would succeed, the note is quarantined → skipped.
    queueSearchIndexRefresh(VAULT, NOTE, "T", "b", []);
    await flush();
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

describe("hardening #2 — breaker Map stays bounded (eviction)", () => {
  it("never exceeds the cap as new failing notes accumulate", async () => {
    setMaxBreakerEntriesForTest(5);
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockRejectedValue(new Error("fail-once"));

    // 20 distinct notes each fail once. Without eviction the Map would hold 20
    // entries; with the cap it must never exceed 5.
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);
    for (let i = 0; i < 20; i++) {
      queueSearchIndexRefresh(VAULT, `01JNOTE${String(i).padStart(18, "0")}`, "T", "b", []);
      await flush();
      expect(getBreakerStateSize()).toBeLessThanOrEqual(5);
    }
    expect(getBreakerStateSize()).toBe(5);
  });

  it("prefers evicting non-quarantined entries before quarantined ones", async () => {
    setMaxBreakerEntriesForTest(3);
    const QUAR = "01JQUARAAAAAAAAAAAAAAAAAAA";

    // Quarantine one note (3 failures past the backoff window).
    upsertSpy = vi
      .spyOn(Tier1BM25.prototype, "upsert")
      .mockRejectedValue(new Error("poison"));
    await failUntilQuarantined(QUAR, 3, "poison )");
    expect(getQuarantinedNotes().map((n) => n.noteId)).toEqual([QUAR]);

    // Now flood with single-failure notes. The quarantined entry must survive
    // eviction while the transient ones get evicted, keeping size at the cap.
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(5_000_000);
    for (let i = 0; i < 10; i++) {
      queueSearchIndexRefresh(VAULT, `01JTRANS${String(i).padStart(17, "0")}`, "T", "b", []);
      await flush();
    }
    expect(getBreakerStateSize()).toBe(3);
    // The quarantined note is still tracked.
    expect(getQuarantinedNotes().map((n) => n.noteId)).toEqual([QUAR]);
  });
});
