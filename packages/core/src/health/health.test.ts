import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { getHealth } from "./index.js";
import { Tier1BM25 } from "../memory/Tier1BM25.js";
import {
  queueSearchIndexRefresh,
  getQuarantinedNotes,
  resetQuarantineState,
} from "../memory/index.js";

/**
 * Story 10.8 — `getHealth()` snapshot. The only live data the snapshot reads
 * is the in-process circuit-breaker state (Story 10.1); everything else is a
 * constant or caller-supplied. We reuse the circuit-breaker test technique:
 * stub `Tier1BM25.upsert` to fail and advance `Date.now` past the breaker's
 * 30s backoff window so three failures quarantine the note deterministically.
 */

const VAULT = "vault-health";
const POISON = "01JHEALTHAAAAAAAAAAAAAAAAA";

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Drive a poison note to quarantine (3 failures, each past the backoff window). */
async function quarantine(noteId: string): Promise<void> {
  const nowSpy = vi.spyOn(Date, "now");
  try {
    for (let i = 0; i < 3; i++) {
      nowSpy.mockReturnValue(2_000_000 + i * 60_000);
      queueSearchIndexRefresh(VAULT, noteId, "T", "poison )", []);
      await flush();
    }
  } finally {
    nowSpy.mockRestore();
  }
}

beforeEach(() => {
  resetQuarantineState();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetQuarantineState();
});

describe("getHealth (Story 10.8)", () => {
  it("returns all documented fields with sane defaults when nothing is supplied", () => {
    const h = getHealth();
    expect(h).toMatchObject({
      sync_state: "unknown",
      last_successful_index_at: null,
      pending_writes: null,
      db_pool_used: null,
      db_pool_max: 10,
      vault_id: "unknown",
      quarantined: [],
      breaker_entries: 0,
      vault_warning: null,
    });
  });

  it("reflects caller-supplied context (vault id, sync state, pool used, warning)", () => {
    const h = getHealth({
      vaultId: "lokyy-prod",
      syncState: "ok",
      lastSuccessfulIndexAt: "2026-05-29T10:00:00.000Z",
      pendingWrites: 2,
      dbPoolUsed: 4,
      vaultWarning: "multiple vault rows detected",
    });
    expect(h.vault_id).toBe("lokyy-prod");
    expect(h.sync_state).toBe("ok");
    expect(h.last_successful_index_at).toBe("2026-05-29T10:00:00.000Z");
    expect(h.pending_writes).toBe(2);
    expect(h.db_pool_used).toBe(4);
    expect(h.db_pool_max).toBe(10);
    expect(h.vault_warning).toBe("multiple vault rows detected");
  });

  it("surfaces a quarantined note via getQuarantinedNotes (Story 10.1 breaker)", async () => {
    vi.spyOn(Tier1BM25.prototype, "upsert").mockRejectedValue(
      Object.assign(new Error('syntax error at or near ")"'), { code: "42601" }),
    );

    await quarantine(POISON);

    // Sanity: the breaker really did quarantine the note.
    expect(getQuarantinedNotes().map((n) => n.noteId)).toEqual([POISON]);

    const h = getHealth({ vaultId: "lokyy-prod" });
    expect(h.quarantined).toHaveLength(1);
    expect(h.quarantined[0]!.noteId).toBe(POISON);
    expect(h.quarantined[0]!.failures).toBe(3);
    expect(h.quarantined[0]!.lastError).toContain("syntax error");
    expect(h.breaker_entries).toBe(1);
  });
});
