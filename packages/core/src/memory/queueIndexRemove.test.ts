import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CombinedProvider } from "./CombinedProvider.js";
import {
  queueIndexRemove,
  getBreakerStateSize,
  getQuarantinedNotes,
  resetQuarantineState,
} from "./index.js";

/**
 * Issue #51 — `queueIndexRemove` ist das fire-and-forget Gegenstück zu
 * `queueIndexRefresh`: es lässt `CombinedProvider.removeNote()` laufen (Tier 1
 * Index-Invalidierung + `DELETE FROM note_embeddings`), ohne dass der
 * Aufrufer je darauf wartet.
 *
 * Wir spionieren `CombinedProvider.prototype.removeNote` an — der einzige
 * DB-berührende Call — und brauchen so weder Postgres noch Ollama.
 */

const VAULT = "01KYPWCA9JA6TBRF9NFZMC47PB";
const NOTE = "10_projects/lokyy/gone";

/** Drain the microtask queue so the fire-and-forget removal settles. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetQuarantineState();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetQuarantineState();
});

describe("queueIndexRemove (Issue #51)", () => {
  it("delegates to CombinedProvider.removeNote for the given note", async () => {
    const removeNote = vi
      .spyOn(CombinedProvider.prototype, "removeNote")
      .mockResolvedValue(undefined);

    queueIndexRemove(VAULT, NOTE);
    await flush();

    expect(removeNote).toHaveBeenCalledTimes(1);
    expect(removeNote).toHaveBeenCalledWith(NOTE);
  });

  it("returns BEFORE the removal runs — der Request-Pfad wartet nie", async () => {
    let called = false;
    vi.spyOn(CombinedProvider.prototype, "removeNote").mockImplementation(async () => {
      called = true;
    });

    queueIndexRemove(VAULT, NOTE);
    // Synchron nach dem Aufruf ist noch nichts passiert.
    expect(called).toBe(false);

    await flush();
    expect(called).toBe(true);
  });

  it("swallows a rejecting provider and logs instead of throwing", async () => {
    vi.spyOn(CombinedProvider.prototype, "removeNote").mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => queueIndexRemove(VAULT, NOTE)).not.toThrow();
    await flush();

    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]![0])).toContain("removeNote failed");
  });

  it("swallows a SYNCHRONOUSLY throwing provider too", async () => {
    vi.spyOn(CombinedProvider.prototype, "removeNote").mockImplementation(() => {
      throw new Error("boom before any await");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => queueIndexRemove(VAULT, NOTE)).not.toThrow();
    await flush();

    expect(logged).toHaveBeenCalled();
  });

  it("does NOT touch the per-note circuit breaker (Story 10.1 state stays clean)", async () => {
    // WHY: der Breaker hält EINEN State-Eintrag pro noteId für den isolierten
    // BM25-Pool. Liefe Tier 2 mit hindurch, würde ein erfolgreicher Tier-2-
    // Delete eine Tier-1-Quarantäne löschen (und umgekehrt) — der State im
    // Health-Snapshot bedeutete dann nicht mehr, was er behauptet.
    vi.spyOn(CombinedProvider.prototype, "removeNote").mockRejectedValue(
      new Error("tier2 down"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < 5; i++) {
      queueIndexRemove(VAULT, NOTE);
      await flush();
    }

    expect(getBreakerStateSize()).toBe(0);
    expect(getQuarantinedNotes()).toEqual([]);
  });
});
