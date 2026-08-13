import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./AuthGate.js";
import {
  clearDataCaches,
  DATA_RUNTIME_CACHES,
  UNAUTHENTICATED_EVENT,
} from "./api.js";

/**
 * Issue #39 — after logout / a 401 the vault-data runtime caches must be gone,
 * but a plain offline network failure must keep them (the offline mode is a
 * feature). These tests lock in both halves plus the "which caches" contract.
 *
 * Login is stubbed so the guest branch is a single, assertable node and never
 * fires its own network calls — this is a test of AuthGate's branching and of
 * `clearDataCaches`, not of the login form.
 */
vi.mock("./Login.js", () => ({
  Login: () => <div data-testid="login">Login-Formular</div>,
}));

/**
 * A minimal Cache Storage stand-in. `delete` records the names it was asked to
 * drop so a test can assert exactly which caches were purged — and, by omission,
 * which were spared (precache, fonts).
 */
function stubCaches() {
  const deleted: string[] = [];
  const del = vi.fn(async (name: string) => {
    deleted.push(name);
    return true;
  });
  vi.stubGlobal("caches", {
    delete: del,
    keys: vi.fn(async () => []),
    open: vi.fn(),
    match: vi.fn(),
    has: vi.fn(),
  } as unknown as CacheStorage);
  return { deleted, del };
}

/** 200 with a session user — the authenticated happy path. */
function authedResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      userId: "u1",
      email: "a@b.c",
      name: "Ada",
      role: "admin",
    }),
  } as unknown as Response;
}

/** A real HTTP answer that isn't OK — the expired/revoked session shape. */
function httpError(status: number) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error("json() must not be called on a non-ok response");
    },
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("clearDataCaches (issue #39)", () => {
  it("purges exactly the three vault-data caches, nothing else", async () => {
    const { deleted, del } = stubCaches();

    await clearDataCaches();

    // The exact set the logout purge is allowed to touch.
    expect(deleted).toEqual(["notes", "vault-tree", "graph"]);
    expect(deleted).toEqual([...DATA_RUNTIME_CACHES]);
    expect(del).toHaveBeenCalledTimes(3);

    // The app shell (precache) and fonts are user-data-free and must survive
    // a logout, or offline boot + font rendering break for no security gain.
    expect(del).not.toHaveBeenCalledWith(
      expect.stringContaining("workbox-precache"),
    );
    expect(del).not.toHaveBeenCalledWith("google-fonts-stylesheets");
    expect(del).not.toHaveBeenCalledWith("google-fonts-webfonts");
  });

  it("is a silent no-op when Cache Storage is unavailable (Node/insecure origin)", async () => {
    // jsdom implements no CacheStorage, so `caches` is undefined here — the
    // guard must swallow that without throwing.
    expect(typeof caches).toBe("undefined");
    await expect(clearDataCaches()).resolves.toBeUndefined();
  });

  it("never rejects when a delete throws", async () => {
    vi.stubGlobal("caches", {
      delete: vi.fn(async () => {
        throw new Error("cache backend exploded");
      }),
    } as unknown as CacheStorage);

    await expect(clearDataCaches()).resolves.toBeUndefined();
  });
});

describe("AuthGate cache purge: logout/401 vs offline", () => {
  it("clears the data caches on a 401 and shows the login screen", async () => {
    const { deleted } = stubCaches();
    fetchMock.mockResolvedValue(httpError(401));

    render(
      <AuthGate>
        <div data-testid="app-shell">Shell</div>
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("login")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(deleted).toEqual(["notes", "vault-tree", "graph"]);
  });

  it("keeps the data caches on a network failure (offline stays usable)", async () => {
    const { del } = stubCaches();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    render(
      <AuthGate>
        <div data-testid="app-shell">Shell</div>
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("login")).toBeInTheDocument();
    });
    // Offline must NOT purge — the cached vault is exactly what offline needs.
    expect(del).not.toHaveBeenCalled();
  });

  it("purges on a mid-session 401 delivered via UNAUTHENTICATED_EVENT", async () => {
    const { del } = stubCaches();
    // First /api/auth/me resolves authenticated → app shell renders, no purge.
    fetchMock.mockResolvedValueOnce(authedResponse());

    render(
      <AuthGate>
        <div data-testid="app-shell">Shell</div>
      </AuthGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    });
    expect(del).not.toHaveBeenCalled();

    // A later API call 401s → api.ts dispatches the event → AuthGate re-checks
    // /api/auth/me, which now 401s → caches are purged and login returns.
    fetchMock.mockResolvedValue(httpError(401));
    window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));

    await waitFor(() => {
      expect(screen.getByTestId("login")).toBeInTheDocument();
    });
    expect(del.mock.calls.map((c) => c[0])).toEqual([
      "notes",
      "vault-tree",
      "graph",
    ]);
  });
});
