import { describe, expect, it, vi } from "vitest";
import {
  RELOAD_GUARD_KEY,
  reconcileBundleVersion,
  renewServiceWorker,
  versionsDiffer,
  type GuardStorage,
} from "./cacheRenewal.js";

/** In-memory stand-in for `sessionStorage`. */
function memoryStorage(seed: Record<string, string> = {}): GuardStorage & {
  data: Record<string, string>;
} {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

describe("versionsDiffer", () => {
  it("treats a missing patch place as zero", () => {
    expect(versionsDiffer("1.11", "1.11.0")).toBe(false);
    expect(versionsDiffer("v1.11.0", "1.11")).toBe(false);
  });

  it("detects a real mismatch", () => {
    expect(versionsDiffer("1.11.0", "1.12.0")).toBe(true);
    expect(versionsDiffer("1.9.0", "1.10.0")).toBe(true);
  });

  it("says 'no difference' whenever a side is unusable", () => {
    // "" is the documented 'unknown' value of __LOKYY_BUILD_VERSION__.
    expect(versionsDiffer("", "1.11.0")).toBe(false);
    expect(versionsDiffer("1.11.0", null)).toBe(false);
    expect(versionsDiffer("dev", "1.11.0")).toBe(false);
    expect(versionsDiffer(undefined, undefined)).toBe(false);
  });
});

describe("reconcileBundleVersion", () => {
  it("does nothing when the bundle version is unknown", async () => {
    const reload = vi.fn();
    const clear = vi.fn(async () => {});
    const outcome = await reconcileBundleVersion("", "1.12.0", {
      storage: memoryStorage(),
      clear,
      reload,
    });
    expect(outcome).toBe("unknown");
    expect(reload).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("does nothing and clears the guard when both sides agree", async () => {
    const reload = vi.fn();
    const storage = memoryStorage({ [RELOAD_GUARD_KEY]: "1.11.0" });
    const outcome = await reconcileBundleVersion("1.11.0", "1.11.0", {
      storage,
      clear: async () => {},
      reload,
    });
    expect(outcome).toBe("in-sync");
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(RELOAD_GUARD_KEY)).toBeNull();
  });

  it("clears caches and reloads exactly ONCE on a permanent mismatch (AC#7)", async () => {
    const reload = vi.fn();
    const clear = vi.fn(async () => {});
    const storage = memoryStorage();

    // First load after a manual `git pull && ./install.sh`: stale shell.
    const first = await reconcileBundleVersion("1.11.0", "1.12.0", {
      storage,
      clear,
      reload,
    });
    expect(first).toBe("reloaded");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);

    // The reload did NOT fix it (e.g. a proxy pins the old bundle). Ten more
    // passes must not produce a second reload — that would be the loop.
    for (let i = 0; i < 10; i += 1) {
      const again = await reconcileBundleVersion("1.11.0", "1.12.0", {
        storage,
        clear,
        reload,
      });
      expect(again).toBe("already-reloaded");
    }
    expect(reload).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("reloads again when the server moves to a NEWER version", async () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    await reconcileBundleVersion("1.11.0", "1.12.0", {
      storage,
      clear: async () => {},
      reload,
    });
    await reconcileBundleVersion("1.11.0", "1.13.0", {
      storage,
      clear: async () => {},
      reload,
    });
    expect(reload).toHaveBeenCalledTimes(2);
    expect(storage.getItem(RELOAD_GUARD_KEY)).toBe("1.13.0");
  });

  it("refuses to reload when there is nowhere to store the guard", async () => {
    const reload = vi.fn();
    const outcome = await reconcileBundleVersion("1.11.0", "1.12.0", {
      storage: null,
      clear: async () => {},
      reload,
    });
    expect(outcome).toBe("no-guard");
    expect(reload).not.toHaveBeenCalled();
  });

  it("refuses to reload when writing the guard throws (private mode)", async () => {
    const reload = vi.fn();
    const storage: GuardStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    const outcome = await reconcileBundleVersion("1.11.0", "1.12.0", {
      storage,
      clear: async () => {},
      reload,
    });
    expect(outcome).toBe("no-guard");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("renewServiceWorker", () => {
  it("reloads immediately when there is no service worker registration", async () => {
    const reload = vi.fn();
    await renewServiceWorker({ reload, fallbackMs: 1 });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads only once even when the fallback timer also fires", async () => {
    const reload = vi.fn();
    await renewServiceWorker({ reload, fallbackMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
