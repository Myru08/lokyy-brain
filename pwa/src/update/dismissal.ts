/**
 * Story 7.12 Task 5, AC#5 — the banner must not become permanent noise.
 *
 * Dismissal is stored PER VERSION: closing the notice for v1.12 stores
 * `"1.12"`, so when v1.13 appears the stored value no longer matches and the
 * banner comes back. A boolean "hidden" flag would silence every future
 * release, which is the failure mode this design exists to avoid.
 *
 * `localStorage`, not `sessionStorage`: dismissing should survive a browser
 * restart — otherwise the notice returns every morning and the user learns to
 * ignore it.
 */

export const DISMISS_KEY = "lokyy.updateBannerDismissed";

export type DismissStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): DismissStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Normalize so `v1.12` and `1.12` are the same dismissal. */
function key(version: unknown): string | null {
  if (typeof version !== "string") return null;
  const trimmed = version.trim().replace(/^v/i, "");
  return trimmed === "" ? null : trimmed;
}

/** `true` when THIS version was dismissed. Unknown versions are never hidden. */
export function isDismissed(
  version: unknown,
  storage: DismissStorage | null = defaultStorage(),
): boolean {
  const k = key(version);
  if (k === null || !storage) return false;
  try {
    return storage.getItem(DISMISS_KEY) === k;
  } catch {
    return false;
  }
}

/**
 * Forget the dismissal — the banner for this version may show again.
 *
 * Called when the user runs an explicit „Jetzt prüfen" and the answer is "yes,
 * there is an update": pressing that button is intent, and honouring a
 * dismissal from an hour ago would swallow the very answer they asked for. Only
 * the matching version is lifted, so this can never resurrect an unrelated one.
 */
export function undismiss(
  version: unknown,
  storage: DismissStorage | null = defaultStorage(),
): void {
  const k = key(version);
  if (k === null || !storage) return;
  try {
    if (storage.getItem(DISMISS_KEY) === k) storage.removeItem(DISMISS_KEY);
  } catch {
    /* storage blocked — nothing was stored either */
  }
}

/** Remember that this version's banner was closed. Storage failure = no-op. */
export function dismiss(
  version: unknown,
  storage: DismissStorage | null = defaultStorage(),
): void {
  const k = key(version);
  if (k === null || !storage) return;
  try {
    storage.setItem(DISMISS_KEY, k);
  } catch {
    /* storage blocked — the banner simply reappears next load */
  }
}
