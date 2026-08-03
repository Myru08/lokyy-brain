/**
 * Story 7.12 Task 5, AC#7 — cache renewal on TWO independent paths.
 *
 * (a) **Version mismatch.** The bundle knows its own build version
 *     (`__LOKYY_BUILD_VERSION__`, injected by Vite from the root
 *     `package.json`) and compares it on load against `running` from
 *     `GET /api/system/version` — the same single source, read at runtime by
 *     the server. Different → the browser is holding a stale shell, so drop
 *     the service worker + every cache and reload. This path is why the
 *     feature matters beyond the update button: it repairs the MANUAL update
 *     route (`git pull && ./install.sh`), where users have been sitting on an
 *     old UI and were told to press Ctrl+Shift+R.
 *
 * (b) **Service-worker lifecycle.** After a finished update, ask the
 *     registration to look for a new worker and reload once the new one takes
 *     control.
 *
 * The clearing itself is deliberately the SAME sequence as
 * `pwa/src/VaultSwitcher.tsx:50-60` — unregister all registrations, delete
 * all caches, reload, everything inside a `try` because the SW/caches APIs are
 * absent on insecure origins and in jsdom. One pattern, one place to fix.
 */

/**
 * Session-scoped guard. Holds the server version we have ALREADY reloaded for
 * in this tab. A permanent mismatch (e.g. a proxy serving an ancient bundle)
 * must cost exactly one reload, not an endless loop — AC#7 demands a guard and
 * a test for it.
 */
export const RELOAD_GUARD_KEY = "lokyy.updateReloadedFor";

/** The slice of `Storage` we use — keeps the tests free of a jsdom global. */
export type GuardStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface ReconcileDeps {
  storage?: GuardStorage | null;
  /** Clears SW + caches. Injected so tests never touch the real APIs. */
  clear?: () => Promise<void>;
  reload?: () => void;
}

/**
 * Outcome of one reconciliation — returned rather than logged so the caller
 * (and the tests) can assert on it.
 *
 * - `unknown`        — one side has no usable version; comparing is forbidden.
 * - `in-sync`        — versions match; the guard is cleared.
 * - `already-reloaded` — mismatch, but this tab already reloaded for it.
 * - `no-guard`       — sessionStorage unavailable; we refuse to reload blind.
 * - `reloaded`       — caches dropped, reload issued.
 */
export type ReconcileOutcome =
  | "unknown"
  | "in-sync"
  | "already-reloaded"
  | "no-guard"
  | "reloaded";

/** `1.11`, `v1.11.0` → `[1, 11, 0]`. `null` when it isn't a version at all. */
function parts(raw: unknown): number[] | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^v/i, "");
  if (trimmed === "") return null;
  const chunks = trimmed.split(".");
  if (chunks.length === 0 || chunks.length > 4) return null;
  const nums = chunks.map((c) => (/^\d+$/.test(c) ? Number(c) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  while (nums.length < 3) nums.push(0);
  return nums;
}

/**
 * `true` only when both sides parse AND differ. An unparsable or missing value
 * yields `false`: "cannot tell" must never be read as "stale", or a build
 * without version info would reload itself forever.
 */
export function versionsDiffer(bundle: unknown, running: unknown): boolean {
  const a = parts(bundle);
  const b = parts(running);
  if (a === null || b === null) return false;
  return a.join(".") !== b.join(".");
}

/** Unregister every service worker and delete every cache. Never throws. */
export async function clearServiceWorkerCaches(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* SW/caches API unavailable — the plain reload still helps */
  }
}

function defaultStorage(): GuardStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null; // storage blocked (private mode, third-party context)
  }
}

/**
 * Compare the bundle's build version against the server's `running` and, on a
 * mismatch, renew the cache exactly once per (tab, server version).
 */
export async function reconcileBundleVersion(
  bundleVersion: unknown,
  running: unknown,
  deps: ReconcileDeps = {},
): Promise<ReconcileOutcome> {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const clear = deps.clear ?? clearServiceWorkerCaches;
  const reload = deps.reload ?? (() => window.location.reload());

  if (parts(bundleVersion) === null || parts(running) === null) return "unknown";

  if (!versionsDiffer(bundleVersion, running)) {
    // Back in sync — forget the guard so a LATER mismatch may reload again.
    try {
      storage?.removeItem(RELOAD_GUARD_KEY);
    } catch {
      /* storage went away mid-session — nothing to clean up */
    }
    return "in-sync";
  }

  const target = String(running).trim();
  let seen: string | null = null;
  try {
    seen = storage?.getItem(RELOAD_GUARD_KEY) ?? null;
  } catch {
    seen = null;
  }
  if (seen === target) return "already-reloaded";

  // No place to remember the attempt → refuse to reload. An unguarded reload
  // on a permanent mismatch is an infinite loop, which is strictly worse than
  // a stale shell the user can refresh by hand.
  if (!storage) return "no-guard";
  try {
    storage.setItem(RELOAD_GUARD_KEY, target);
  } catch {
    return "no-guard";
  }

  await clear();
  reload();
  return "reloaded";
}

export interface RenewDeps {
  reload?: () => void;
  /** Hard stop in case `controllerchange` never fires. */
  fallbackMs?: number;
}

/**
 * Path (b): after a successful update, pull the new worker in and reload as
 * soon as it takes control. `vite-plugin-pwa` runs in `autoUpdate` mode, which
 * refreshes the cache in the background but leaves the OPEN page on the old
 * shell — that is the gap this closes.
 *
 * Resolves once a reload has been issued (or the fallback fired), so the
 * caller can keep the progress dialog on screen until the page goes away.
 */
export async function renewServiceWorker(deps: RenewDeps = {}): Promise<void> {
  const reload = deps.reload ?? (() => window.location.reload());
  const fallbackMs = deps.fallbackMs ?? 8000;

  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    reload();
  };

  try {
    const container = navigator.serviceWorker;
    const reg = await container?.getRegistration?.();
    if (!container || !reg) {
      once();
      return;
    }
    container.addEventListener("controllerchange", once, { once: true });
    await reg.update();
  } catch {
    /* fall through to the fallback timer */
  }

  await new Promise<void>((resolve) => {
    setTimeout(() => {
      once();
      resolve();
    }, fallbackMs);
  });
}
