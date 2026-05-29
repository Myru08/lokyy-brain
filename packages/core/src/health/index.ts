/**
 * Backend health snapshot (Story 10.8) — `getHealth()`.
 *
 * An agent or a monitor needs to diagnose the backend (sync state, index
 * recency, pool pressure, vault id, quarantined notes) WITHOUT waiting for a
 * total outage. The MCP `get_health()` tool (Agent C) returns this object;
 * `vault_id` is supplied by the active server/MCP context.
 *
 * AC#6 — `getHealth()` must NOT run heavy/hanging DB queries (otherwise it
 * diagnoses itself to death under load). It therefore reports the pool MAX
 * (a compile-time constant of the main pool) and leaves anything it cannot
 * read cheaply as `null`/`"unknown"` rather than guessing.
 *
 * The quarantine fields come from the Story-10.1 circuit-breaker API in
 * `memory/index.ts` (imported from the deep module path, NOT the barrel —
 * the barrel re-export is the parallel MCP-wiring agent's job).
 */

import {
  getQuarantinedNotes,
  getBreakerStateSize,
  type QuarantinedNote,
} from "../memory/index.js";

/**
 * Max size of the MAIN postgres pool (`initDb` → `postgres(url, { max: 10 })`
 * in `db/index.ts`). Mirrored as a constant here because postgres.js does not
 * expose a cheap, non-blocking "connections in use" counter, and AC#6 forbids
 * a roundtrip just to read pool stats. If `db/index.ts` changes the main
 * pool size, update this constant too.
 */
const MAIN_DB_POOL_MAX = 10;

/** Sync-state of the git/Forgejo write path, as far as health can tell. */
export type SyncState = "ok" | "degraded" | "unknown";

/** The health snapshot returned to agents/monitors. */
export interface HealthSnapshot {
  /**
   * Git/Forgejo sync health. `getHealth()` cannot cheaply probe the remote
   * without a network roundtrip, so the default is `"unknown"`; a caller
   * (server context) that already tracks the last push result may override
   * it via `opts.syncState`.
   */
  sync_state: SyncState;
  /**
   * ISO timestamp of the last successful BM25 index write, if the caller
   * tracks it. We do not persist this in core yet → `null` unless supplied.
   */
  last_successful_index_at: string | null;
  /**
   * Count of writes currently queued/in-flight on the index path. Not
   * cheaply observable without instrumenting the fire-and-forget queue →
   * `null` unless the caller supplies a tracked value.
   */
  pending_writes: number | null;
  /** In-use main-pool connections — not cheaply observable → `null` (AC#6). */
  db_pool_used: number | null;
  /** Configured max size of the main DB pool (compile-time constant). */
  db_pool_max: number;
  /** Active vault id, from the server/MCP context. `"unknown"` if unset. */
  vault_id: string;
  /** Currently quarantined notes (Story 10.1 circuit breaker). */
  quarantined: QuarantinedNote[];
  /** Total notes tracked by the breaker (quarantined or accumulating fails). */
  breaker_entries: number;
  /**
   * Multi-vault problem flag (AC#4). Additive, no hard dependency on Story
   * 10.13: when the MCP boot detected more than one vault row, the caller
   * passes a warning string here. Absent/`null` = no warning.
   */
  vault_warning: string | null;
}

/** Optional context the caller (server/MCP) can supply for fields core cannot read cheaply. */
export interface HealthContext {
  /** Active vault id from the server/MCP context. */
  vaultId?: string | null;
  /** Last known git sync state, if the caller tracks push results. */
  syncState?: SyncState;
  /** ISO timestamp of the last successful index write, if tracked. */
  lastSuccessfulIndexAt?: string | null;
  /** Count of queued/in-flight index writes, if tracked. */
  pendingWrites?: number | null;
  /** In-use main-pool connections, if the caller can observe it cheaply. */
  dbPoolUsed?: number | null;
  /** Multi-vault warning (Story 10.13) — additive. */
  vaultWarning?: string | null;
}

/**
 * Build the backend health snapshot (Story 10.8). Synchronous and cheap:
 * the only data it reads is the in-process circuit-breaker state. Everything
 * else is either a compile-time constant (pool max) or a value the caller
 * already tracks and passes via `opts`; anything else is `null`/`"unknown"`
 * — never guessed (AC#2/AC#6).
 */
export function getHealth(opts: HealthContext = {}): HealthSnapshot {
  return {
    sync_state: opts.syncState ?? "unknown",
    last_successful_index_at: opts.lastSuccessfulIndexAt ?? null,
    pending_writes: opts.pendingWrites ?? null,
    db_pool_used: opts.dbPoolUsed ?? null,
    db_pool_max: MAIN_DB_POOL_MAX,
    vault_id: opts.vaultId ?? "unknown",
    quarantined: getQuarantinedNotes(),
    breaker_entries: getBreakerStateSize(),
    vault_warning: opts.vaultWarning ?? null,
  };
}
