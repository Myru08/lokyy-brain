import { useEffect, useSyncExternalStore } from "react";
import { api, type SystemVersion, type SystemVersionCheck } from "../api.js";
import { reconcileBundleVersion } from "./cacheRenewal.js";

/**
 * Story 7.12 Task 5 — one place that asks `GET /api/system/version`.
 *
 * Besides handing the payload to the banner and the settings tab, this hook
 * performs cache-renewal path (a): compare the bundle's own build version
 * against the server's `running` and, on a mismatch, drop the service worker
 * and reload exactly once (AC#7). That check is deliberately NOT gated on a
 * role — a stale shell is a stale shell for everyone, and this is the path
 * that repairs the manual `git pull && ./install.sh` route.
 *
 * `api.getSystemVersion()` never throws, so a failed check stays invisible
 * (AC#3): the hook simply keeps `status: "unknown"`, which means "no banner".
 *
 * The payload lives in a MODULE-level store rather than in each component's
 * own state, because two independent consumers read it — the banner in
 * `App.tsx` and the settings tab — and the „Jetzt prüfen"-Button has to move
 * BOTH without a reload (AC#5 of the manual-check story). Per-component state
 * would have refreshed only the tab the button sits in and left the banner
 * showing the version from app start. It also means the initial GET happens
 * once per page load instead of once per consumer.
 */

/** The payload every consumer reads. `null` until the first GET lands. */
let current: SystemVersion | null = null;
const listeners = new Set<() => void>();
/** The one in-flight (or completed) initial load — never fetched per consumer. */
let initialLoad: Promise<void> | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `__LOKYY_BUILD_VERSION__` is a Vite `define`, i.e. a literal substitution at
 * build time — it is NOT a real global. Under vitest (its own config, no
 * `define`) the identifier simply does not exist, so it is read through
 * `typeof`, which is the one operator that tolerates an undeclared name. The
 * `""` fallback means "unknown", and `reconcileBundleVersion` refuses to
 * compare an unknown version. That is what keeps a build without version info
 * from reloading itself forever.
 */
export function bundleVersion(): string {
  return typeof __LOKYY_BUILD_VERSION__ === "string" ? __LOKYY_BUILD_VERSION__ : "";
}

/** The initial `GET`, at most once per page load. */
function loadOnce(): Promise<void> {
  if (initialLoad) return initialLoad;
  initialLoad = (async () => {
    const payload = await api.getSystemVersion();
    current = payload;
    emit();
    await reconcileBundleVersion(bundleVersion(), payload.running);
  })();
  return initialLoad;
}

/**
 * Force a check on the server and publish the answer to every consumer.
 *
 * Returns the payload, or `null` when the check could not run at all — the
 * caller renders a quiet note for that (AC#4). A throttled answer arrives as a
 * normal payload with `throttled: true` and is published like any other.
 */
export async function refreshSystemVersion(): Promise<SystemVersionCheck | null> {
  const payload = await api.checkSystemVersionNow();
  if (payload) {
    current = payload;
    emit();
  }
  return payload;
}

export function useSystemVersion(): { version: SystemVersion | null } {
  const version = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );

  useEffect(() => {
    void loadOnce();
  }, []);

  return { version };
}

/** Test-only: forget the shared payload so each test starts from scratch. */
export function resetSystemVersionStoreForTests(): void {
  current = null;
  initialLoad = null;
  listeners.clear();
}
