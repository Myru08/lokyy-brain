/**
 * Memory layer entrypoint. Most callers go through the CombinedProvider;
 * Tier 1 / Tier 2 are exported for tests + the future MCP package that
 * may want to bypass the Tier 1 fallback for pure-semantic queries.
 */

export type {
  MemoryProvider,
  SearchHit,
  SearchOpts,
  RelatedOpts,
} from "./MemoryProvider.js";
export { NullMemoryProvider } from "./MemoryProvider.js";
export { Tier1Provider } from "./Tier1Provider.js";
export {
  Tier2Provider,
  EmbeddingUnavailableError,
  EmbeddingInputTooLargeError,
  type Tier2Config,
} from "./Tier2Provider.js";
export { CombinedProvider } from "./CombinedProvider.js";
export { Tier1BM25, type BM25Hit } from "./Tier1BM25.js";
export {
  hybridSearch,
  resetHybridAvailabilityCache,
  type HybridOpts,
} from "./hybrid.js";

import { Tier1Provider } from "./Tier1Provider.js";
import { Tier2Provider } from "./Tier2Provider.js";
import { CombinedProvider } from "./CombinedProvider.js";
import { Tier1BM25 } from "./Tier1BM25.js";

let combined: CombinedProvider | null = null;
let activeVaultId: string | null = null;

/**
 * Build (or return) a CombinedProvider for the given vault. Once a vault
 * is active the provider is cached; passing a new vaultId resets it.
 */
export function getMemoryProvider(vaultId: string): CombinedProvider {
  if (combined && activeVaultId === vaultId) return combined;
  // Pass the vaultId + the shared Tier1BM25 singleton so the Tier-1 leg of
  // search() runs against the indexed `note_search` table (fast), scoped to
  // this vault, instead of the cold per-note in-memory rebuild. The singleton
  // is declared below; this function only runs at call time (after module
  // evaluation), so the forward reference is safe.
  combined = new CombinedProvider(
    new Tier1Provider(),
    new Tier2Provider({ vaultId }),
    vaultId,
    tier1Bm25Singleton,
  );
  activeVaultId = vaultId;
  return combined;
}

/**
 * Fire-and-forget hook (Story 5.4). Call after every successful note save.
 * Returns immediately; the Tier 2 embedding refresh runs on a microtask.
 * Never awaits the network — the request path stays fast even when Ollama
 * is slow or down.
 */
export function queueIndexRefresh(vaultId: string, noteId: string): void {
  const provider = getMemoryProvider(vaultId);
  void Promise.resolve().then(() =>
    provider
      .indexNote(noteId)
      .catch((err) =>
        console.error("[memory] indexNote failed (non-blocking)", { vaultId, noteId, err }),
      ),
  );
}

/**
 * Fire-and-forget Gegenstück zu {@link queueIndexRefresh} (Issue #51). Call
 * after every successful delete/move of a note. Returns immediately; the
 * Tier-2 removal (`DELETE FROM note_embeddings`) runs on a microtask, so the
 * request path stays fast even when Postgres is slow or down.
 *
 * WHY this exists: `CombinedProvider.removeNote()` — which deletes from BOTH
 * tiers and already carries the Tier-2 error handling — had ZERO call sites.
 * The real delete/move path only ran `queueSearchIndexRemove` (Tier 1 / BM25),
 * so every deleted or moved note left its embeddings behind as orphaned
 * vectors. This is the missing mirror of the write path.
 *
 * Deliberately NOT routed through `runGuardedIndexWrite`. Three reasons, the
 * third being the one that actually settles it:
 *
 * 1. State collision. The breaker keeps exactly ONE entry per noteId and a
 *    successful write DELETES it. Sharing that entry between two backends
 *    would let a successful Tier-2 delete clear a Tier-1 quarantine (the
 *    poison note resumes storming the BM25 pool) and a failing Tier-2 delete
 *    quarantine a perfectly healthy BM25 row. The health snapshot (Story
 *    10.8) would stop meaning what it claims to mean.
 *
 * 2. Wrong failure mode. The breaker was built for ParadeDB BM25 index
 *    maintenance blowing up on poison CONTENT (42601) — genuinely per-note.
 *    Tier 2 here is a plain parametrised DELETE with no index maintenance.
 *
 * 3. A per-note breaker is the wrong SHAPE for Tier 2 in general. Tier-2
 *    failures that reach a caller are overwhelmingly global, not per-note:
 *    `CombinedProvider.indexNote` already swallows `EmbeddingUnavailable`
 *    (Ollama down), so what actually propagates is Postgres — pool
 *    exhaustion, connection refused — which fails for EVERY note at once.
 *    Quarantine only lifts on a successful write, and a quarantined note is
 *    skipped, so nothing can ever succeed: a five-minute pool hiccup would
 *    permanently desync the embeddings of every note saved in that window.
 *    That is strictly worse than the current bare catch.
 *
 * NOTE (offen, eigene Story): the Tier-2 WRITE path (`queueIndexRefresh`) is
 * likewise unguarded — no breaker, no backoff. That is a known gap, not an
 * oversight of this change: Story 10.1 hardened Tier 1 and never covered
 * Tier 2. Closing it properly needs a GLOBAL (per-backend) breaker with
 * half-open recovery rather than this per-note one, AND staleness detection
 * in the `embeddingBackfill` sleep pass — that pass currently only finds
 * notes with NO row, so any UPDATE a breaker discards would stay stale
 * forever. Do not bolt Tier 2 onto `runGuardedIndexWrite`.
 *
 * Never throws — neither synchronously nor asynchronously. Provider
 * construction happens INSIDE the microtask so even a broken config cannot
 * bubble into `deleteEntry`/`moveEntry`.
 */
export function queueIndexRemove(vaultId: string, noteId: string): void {
  void Promise.resolve()
    .then(() => getMemoryProvider(vaultId).removeNote(noteId))
    .catch((err) =>
      console.error("[memory] removeNote failed (non-blocking)", { vaultId, noteId, err }),
    );
}

/* ────────────────────────────────────────────────────────────────────────
 *  Issue #56 — Bulk-Index-Pflege für ORDNER-Operationen
 *
 *  Beim Einzel-Delete entsteht genau EINE Bereinigung. Ein gelöschter (oder
 *  verschobener) Ordner bringt N Notizen auf einmal mit. Der naive Weg —
 *  `for (id of ids) queueBothSearchTiersRemove(id)` — feuert N unabhängige
 *  Microtasks los, von denen jeder eine eigene DB-Verbindung zieht. Das ist
 *  exakt die Form des Ausfalls vom 2026-05-28 (siehe die lange Begründung an
 *  `queueIndexRemove` oben): eine Welle fire-and-forget-Writes fuhr den
 *  Connection-Pool leer und riss das Backend mit.
 *
 *  Die Antwort auf AC#6 besteht aus zwei Teilen, die zusammen greifen:
 *
 *   1. GEBÜNDELT — pro Chunk von {@link BULK_INDEX_CHUNK} IDs geht genau EINE
 *      `DELETE ... WHERE note_id = ANY($1)` pro Tier raus. Die Query-Zahl
 *      hängt damit nicht mehr an der Ordnergröße: 500 Notizen sind 3 Queries,
 *      nicht 1000. Der Chunk existiert nur, damit ein einzelner Parameter und
 *      ein einzelnes Statement nicht beliebig groß werden.
 *
 *   2. SERIELL — ALLE Bulk-Jobs (auch die aus gleichzeitigen Requests) hängen
 *      an EINER prozessweiten Promise-Kette. Zu jedem Zeitpunkt ist höchstens
 *      eine Index-Operation in flight, egal wie viele Ordner parallel gelöscht
 *      werden. Ein Sturm ist damit strukturell unmöglich, nicht bloß
 *      unwahrscheinlich.
 *
 *  Warum NICHT durch `runGuardedIndexWrite` (den Per-Note-Breaker aus Story
 *  10.1): der Breaker hält State pro noteId und existiert gegen ein poison-
 *  CONTENT-Retry-Loop. Hier läuft pro Notiz genau EIN Versuch pro Ordner-
 *  Operation, es gibt kein Re-Firing — das Problem, gegen das der Breaker
 *  schützt, kann in diesem Pfad gar nicht entstehen. Zusätzlich sind die
 *  Bulk-Deletes reine parametrisierte DELETEs ohne Index-Maintenance über
 *  Content. Ein per-Note-Breaker über einer Bulk-Query wäre außerdem gar nicht
 *  zuordenbar. Der Einzel-Notiz-Pfad bleibt unverändert am Breaker (AC#7).
 *
 *  Fehler werden geloggt, nie geworfen — weder synchron noch asynchron. Die
 *  Git-Operation ist die Wahrheit, der Index ist abgeleitet (AC#5).
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Maximale Anzahl note_ids pro gebündelter Lösch-Query. Groß genug, dass
 * typische Ordner in EINE Query passen; klein genug, dass ein einzelnes
 * Statement/Parameter-Array beschränkt bleibt.
 */
export const BULK_INDEX_CHUNK = 200;

/**
 * Eine Notiz, die nach einem Ordner-Move unter ihrer NEUEN ID indiziert wird.
 * `load` ist bewusst lazy: der Request-Pfad liest keine N Dateien, das
 * passiert erst im seriellen Worker. `null` ⇒ Notiz ist zwischen Move und
 * Re-Index verschwunden, wird still übersprungen.
 */
export interface BulkRefreshItem {
  noteId: string;
  load: () => Promise<{
    title: string;
    body: string;
    tags: string[];
    forgotten: boolean;
  } | null>;
}

/** Die eine prozessweite Kette. Rejected nie — jeder Job fängt selbst. */
let bulkChain: Promise<void> = Promise.resolve();

function enqueueBulk(label: string, job: () => Promise<void>): void {
  bulkChain = bulkChain
    .then(job)
    .catch((err) =>
      console.error(`[memory] bulk ${label} failed (non-blocking)`, err),
    );
}

/**
 * Test-/Shutdown-Hook: wartet, bis die aktuell eingereihten Bulk-Jobs durch
 * sind. Der Produktionspfad ruft das NIE auf — er ist fire-and-forget (AC#4).
 */
export function flushBulkIndexQueue(): Promise<void> {
  return bulkChain;
}

/**
 * Fire-and-forget-Bereinigung für ALLE Notizen eines gelöschten oder
 * verschobenen Ordners (Issue #56, AC#2). Kehrt sofort zurück; die Arbeit
 * läuft gebündelt und seriell auf der Bulk-Kette.
 */
export function queueBulkTierRemove(vaultId: string, noteIds: string[]): void {
  const ids = [...new Set(noteIds)];
  if (ids.length === 0) return;

  enqueueBulk(`remove(${ids.length})`, async () => {
    // Provider-Konstruktion INNERHALB des Jobs — eine kaputte Konfiguration
    // darf nicht in `deleteEntry` hochblubbern.
    const provider = getMemoryProvider(vaultId);

    for (let i = 0; i < ids.length; i += BULK_INDEX_CHUNK) {
      const chunk = ids.slice(i, i + BULK_INDEX_CHUNK);
      // Beide Tiers einzeln kapseln: fällt einer aus, räumt der andere
      // trotzdem ab, und die restlichen Chunks laufen weiter.
      try {
        await tier1Bm25Singleton.removeMany(chunk);
      } catch (err) {
        console.error("[memory] bulk note_search remove failed (non-blocking)", {
          vaultId,
          count: chunk.length,
          err,
        });
      }
      try {
        await provider.t2.removeNotes(chunk);
      } catch (err) {
        console.error("[memory] bulk note_embeddings remove failed (non-blocking)", {
          vaultId,
          count: chunk.length,
          err,
        });
      }
    }

    // Der strukturelle In-Memory-Index (Tier1Provider) kennt keine IDs — er
    // wird komplett verworfen und bei der nächsten Query neu gebaut. Einmal
    // pro Ordner reicht also; N Aufrufe wären N-mal dieselbe Zuweisung.
    try {
      await provider.t1.removeNote(ids[0]!);
    } catch (err) {
      console.error("[memory] structural index invalidation failed", { err });
    }
  });
}

/**
 * Fire-and-forget-Re-Indizierung nach einem Ordner-MOVE (Issue #56, AC#3).
 * Die `note_id` IST der Pfad ohne ".md" — ein Ordner-Move ändert also die ID
 * jeder enthaltenen Notiz. Ohne diesen Schritt wären die Notizen nach einem
 * Move semantisch unauffindbar, bis sie einzeln neu gespeichert werden.
 *
 * Läuft auf derselben seriellen Kette wie {@link queueBulkTierRemove}, also
 * garantiert NACH dem Entfernen der alten IDs und mit Nebenläufigkeit 1 — bei
 * Tier 2 hängt an jeder Notiz ein Ollama-Embedding, das parallel zu feuern
 * genau der Sturm wäre, den AC#6 verbietet.
 */
export function queueBulkTierRefresh(
  vaultId: string,
  items: BulkRefreshItem[],
): void {
  if (items.length === 0) return;

  enqueueBulk(`refresh(${items.length})`, async () => {
    const provider = getMemoryProvider(vaultId);
    for (const item of items) {
      try {
        const doc = await item.load();
        if (doc === null) continue; // Notiz ist inzwischen weg — überspringen.
        await tier1Bm25Singleton.upsert(
          item.noteId,
          vaultId,
          doc.title,
          doc.body,
          doc.tags,
          doc.forgotten,
        );
        await provider.indexNote(item.noteId);
      } catch (err) {
        // Eine kaputte Notiz darf die übrigen nicht mitreißen.
        console.error("[memory] bulk reindex failed for note (non-blocking)", {
          vaultId,
          noteId: item.noteId,
          err,
        });
      }
    }
  });
}

/** Singleton Tier1BM25 — no per-vault state, the table is keyed by note_id. */
const tier1Bm25Singleton = new Tier1BM25();

export function getTier1BM25(): Tier1BM25 {
  return tier1Bm25Singleton;
}

// ─── Per-note circuit breaker / quarantine (Story 10.1, AC#3 + AC#5) ──────
//
// WHY: a single "poison" note (content that makes ParadeDB's BM25 index
// maintenance throw 42601) used to re-fail on every save, and every failure
// re-fired the fire-and-forget upsert. With a shared pool that storm of
// failing writes exhausted connections and took the whole backend down
// (2026-05-28 outage). The breaker isolates the bad note: after N consecutive
// upsert failures it is quarantined — further refreshes are skipped until a
// successful write (or an explicit reset) clears it — so the indexer keeps
// serving every other note. AC#5: backoff prevents immediate busy-retry of a
// failing note even before the hard quarantine threshold is reached.

/** Consecutive write failures before a noteId is quarantined. */
const QUARANTINE_THRESHOLD = 3;
/** Minimum gap between retry attempts for a still-failing (not-yet-quarantined) note. */
const RETRY_BACKOFF_MS = 30_000;
/**
 * Hard cap on breaker-state entries (Story 10.1 hardening #2 — bounded memory).
 *
 * WHY: a note that fails once then goes permanently quiet leaves a breaker
 * entry that nothing ever clears (success deletes it, but there is no further
 * save to succeed). Without a cap the Map grows unbounded across the process
 * lifetime — a slow leak. We evict the least-recently-touched entry once the
 * Map exceeds this size. Quarantined entries are evicted last so the health
 * snapshot stays meaningful for the notes that actually matter; a fresh
 * failure after eviction simply re-creates the entry and re-counts from one,
 * which is acceptable for a self-healing breaker.
 */
const MAX_BREAKER_ENTRIES = 1_000;
/** Test-only override for the eviction cap; `null` means use the default. */
let breakerCapOverride: number | null = null;

interface BreakerState {
  failures: number;
  quarantined: boolean;
  lastError: string;
  /** Epoch ms of the last attempt — used to enforce bounded backoff. */
  lastAttemptAt: number;
  /** Epoch ms this entry was last created/updated — used for LRU eviction. */
  touchedAt: number;
}

const breakerByNote = new Map<string, BreakerState>();

/**
 * Evict entries when the breaker Map exceeds its cap (Story 10.1 hardening #2).
 *
 * Eviction order: non-quarantined entries first (oldest `touchedAt` wins),
 * falling back to quarantined entries only if every remaining entry is
 * quarantined. This keeps the operator-visible quarantine list alive as long
 * as possible while still guaranteeing a bounded Map.
 */
function evictIfOverCap(): void {
  const cap = breakerCapOverride ?? MAX_BREAKER_ENTRIES;
  while (breakerByNote.size > cap) {
    let victim: string | null = null;
    let victimTouchedAt = Infinity;
    let victimQuarantined = true;
    for (const [noteId, st] of breakerByNote) {
      // Prefer a non-quarantined victim over a quarantined one; within the same
      // class, prefer the oldest touchedAt.
      const better =
        (victimQuarantined && !st.quarantined) ||
        (victimQuarantined === st.quarantined && st.touchedAt < victimTouchedAt);
      if (better) {
        victim = noteId;
        victimTouchedAt = st.touchedAt;
        victimQuarantined = st.quarantined;
      }
    }
    if (victim === null) return; // Map is non-empty here, but guard anyway.
    breakerByNote.delete(victim);
  }
}

export interface QuarantinedNote {
  noteId: string;
  failures: number;
  lastError: string;
}

/**
 * Snapshot of all currently quarantined notes (Story 10.1, AC#3). Consumed by
 * the future `get_health()` MCP tool (Story 10.8). Returns a copy so callers
 * cannot mutate breaker state.
 */
export function getQuarantinedNotes(): QuarantinedNote[] {
  const out: QuarantinedNote[] = [];
  for (const [noteId, st] of breakerByNote) {
    if (st.quarantined) {
      out.push({ noteId, failures: st.failures, lastError: st.lastError });
    }
  }
  return out;
}

/**
 * Clear breaker state for a note (Story 10.1). Called on a successful upsert so
 * a recovered note re-enters normal indexing; also exported so an operator /
 * the future health tool can manually un-quarantine after fixing content.
 */
export function clearQuarantine(noteId: string): void {
  breakerByNote.delete(noteId);
}

/**
 * Clear ALL breaker/quarantine state and report how many entries were dropped
 * (Gate-0 recovery). Idempotent: a second call returns 0.
 *
 * WHY this exists: the Gate-0 array-binding bug (`Tier1BM25.upsert`) made every
 * tag-less note fail its index write and get quarantined. After the fix is
 * deployed those notes will index correctly again — but the in-memory breaker
 * still holds their stale quarantine entries and SKIPS them until a successful
 * write or an explicit clear. This is the smallest correct recovery lever: call
 * it once after deploying the fix, then the next save of each affected note
 * (or a re-index) upserts successfully because the bug is gone.
 *
 * NOTE: breaker state is process-local and in-memory. Restarting the
 * server/container ALSO clears all quarantine — that is the zero-code operator
 * path; this function is the no-restart equivalent for an operator/health tool.
 */
export function clearAllQuarantine(): number {
  const cleared = breakerByNote.size;
  breakerByNote.clear();
  return cleared;
}

/** Test hook — wipe all breaker state so cases start from a clean slate. */
export function resetQuarantineState(): void {
  breakerByNote.clear();
  breakerCapOverride = null;
}

/**
 * Total number of notes currently tracked by the breaker (quarantined or just
 * accumulating failures). Useful for the future `get_health()` tool and for
 * asserting the Map stays bounded (Story 10.1 hardening #2).
 */
export function getBreakerStateSize(): number {
  return breakerByNote.size;
}

/**
 * Test hook — override the eviction cap so the bounded-Map behaviour can be
 * exercised without inserting thousands of entries. `null` restores the
 * production default.
 */
export function setMaxBreakerEntriesForTest(cap: number | null): void {
  breakerCapOverride = cap;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "unknown error");
}

/**
 * Run a fire-and-forget index write behind the per-note circuit breaker
 * (Story 10.1, AC#3/AC#5 + hardening #1).
 *
 * ALL three index-write paths — upsert, remove, and forgotten-toggle — share
 * this single guard so a poison note that fails on ANY of them is quarantined
 * and backed-off identically. Routing only `upsert` through the breaker (the
 * original implementation) left DELETE/UPDATE able to retry-storm the index
 * pool, which reopened a narrower version of the outage bug.
 *
 * Returns synchronously; `op` runs on a microtask and never blocks the caller.
 * `label` distinguishes the write kind in logs only.
 */
function runGuardedIndexWrite(
  noteId: string,
  label: string,
  op: () => Promise<void>,
): void {
  const state = breakerByNote.get(noteId);

  // Quarantined: skip entirely until a successful write (or explicit reset).
  if (state?.quarantined) return;

  // Bounded backoff (AC#5): if this note is mid-failure, don't re-attempt until
  // the backoff window has elapsed. A genuinely-changed note still eventually
  // retries; a poison note no longer busy-loops.
  if (
    state &&
    state.failures > 0 &&
    Date.now() - state.lastAttemptAt < RETRY_BACKOFF_MS
  ) {
    return;
  }

  void Promise.resolve().then(async () => {
    try {
      await op();
      // Success → recover. Clears any accumulated failure/backoff state.
      if (breakerByNote.has(noteId)) breakerByNote.delete(noteId);
    } catch (err) {
      const prior = breakerByNote.get(noteId);
      const failures = (prior?.failures ?? 0) + 1;
      const lastError = errorMessage(err);
      const quarantined = failures >= QUARANTINE_THRESHOLD;
      const now = Date.now();
      breakerByNote.set(noteId, {
        failures,
        quarantined,
        lastError,
        lastAttemptAt: now,
        touchedAt: now,
      });
      // Hardening #2: keep the breaker Map bounded.
      evictIfOverCap();

      if (quarantined && !prior?.quarantined) {
        // Loud, ONCE — on the transition into quarantine (AC#3). This is the
        // signal an operator needs; subsequent saves are silently skipped.
        console.error(
          `[memory] QUARANTINE: note ${noteId} disabled from search indexing after ` +
            `${failures} consecutive ${label} failures. Search/reads stay up; this ` +
            `note is excluded from the BM25 index until its content is fixed. ` +
            `lastError=${lastError}`,
          { noteId, label, failures },
        );
      } else if (!quarantined) {
        // Pre-quarantine failures stay at the original non-blocking log level.
        console.error(`[memory] note_search ${label} failed (non-blocking)`, {
          noteId,
          failures,
          err,
        });
      }
    }
  });
}

/**
 * Fire-and-forget upsert into the `note_search` BM25 corpus (Phase A Wave A1
 * / Story 2). Call after every successful saveNote with the freshly read
 * note (title + body + parsed tags). Never blocks the save path.
 *
 * `forgotten` (Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive)
 * defaults to `false` so existing call-sites stay compatible. notesService
 * passes the live value derived from the frontmatter's `forgotten:` field.
 *
 * Story 10.1: guarded by the per-note circuit breaker. Quarantined notes are
 * skipped; failing-but-not-quarantined notes respect a backoff window so a
 * poison note can never spin into a retry storm.
 */
export function queueSearchIndexRefresh(
  vaultId: string,
  noteId: string,
  title: string,
  body: string,
  tags: string[],
  forgotten = false,
): void {
  runGuardedIndexWrite(noteId, "upsert", () =>
    tier1Bm25Singleton.upsert(noteId, vaultId, title, body, tags, forgotten),
  );
}

/**
 * Phase C Wave C3 / Story 2 — Fire-and-forget toggle of the `forgotten`
 * flag on the existing `note_search` row. Used by the forget/unforget
 * route after the note's frontmatter has been updated on disk. Returns
 * immediately. If the row is missing (e.g. BM25 first-index has not yet
 * run after a fresh import) the update is a no-op and the next normal
 * BM25 upsert will reconcile the column from the frontmatter.
 *
 * Story 10.1 hardening #1: shares the per-note circuit breaker so a poison
 * note that fails on UPDATE cannot retry-storm the isolated index pool.
 */
export function queueForgottenToggle(noteId: string, forgotten: boolean): void {
  runGuardedIndexWrite(noteId, "forgotten toggle", async () => {
    await tier1Bm25Singleton.setForgotten(noteId, forgotten);
  });
}

/**
 * Fire-and-forget removal from the BM25 corpus. Call after every successful
 * deleteEntry of a note.
 *
 * Story 10.1 hardening #1: shares the per-note circuit breaker so a poison
 * note that fails on DELETE cannot retry-storm the isolated index pool.
 */
export function queueSearchIndexRemove(noteId: string): void {
  runGuardedIndexWrite(noteId, "remove", () => tier1Bm25Singleton.remove(noteId));
}
