import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateApiError, api } from "../api.js";

/**
 * Story 7.12 — the wire contract of the three update endpoints.
 *
 * These exist because of one concrete trap: the shared `json<T>()` helper in
 * `api.ts` surfaces the machine-readable `error` field and discards the rest.
 * Routed through it, a 409 would have shown the user the literal string
 * "job-running", and `retryable` — the flag that decides whether the UI keeps
 * polling through a restart — would never have reached the caller at all.
 */

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  const ok = init?.ok ?? true;
  return {
    ok,
    status: init?.status ?? (ok ? 200 : 500),
    json: async () => body,
    text: async () => JSON.stringify(body),
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

describe("capability", () => {
  it("reads capability from GET /api/system/update", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ canUpdate: true, mode: "local" }));
    const cap = await api.getUpdateCapability();
    expect(fetchMock).toHaveBeenCalledWith("/api/system/update", {
      credentials: "include",
    });
    expect(cap.canUpdate).toBe(true);
  });

  it("degrades to 'cannot update' with a German sentence when unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const cap = await api.getUpdateCapability();
    expect(cap.canUpdate).toBe(false);
    expect(cap.message).toMatch(/README/);
  });
});

describe("startUpdate", () => {
  it("returns the raw JobSnapshot on 202", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "job-1", phase: "queued" }, { status: 202 }),
    );
    await expect(api.startUpdate()).resolves.toMatchObject({ id: "job-1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/system/update", {
      method: "POST",
      credentials: "include",
    });
  });

  it("carries currentJobId out of a 409 and shows `message`, never `error`", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "job-running",
          message: "Ein Update läuft bereits.",
          currentJobId: "job-7",
        },
        { ok: false, status: 409 },
      ),
    );
    const err = await api.startUpdate().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpdateApiError);
    expect((err as UpdateApiError).currentJobId).toBe("job-7");
    // The machine-readable code must never become the user-facing text.
    expect((err as UpdateApiError).message).toBe("Ein Update läuft bereits.");
    expect((err as UpdateApiError).message).not.toContain("job-running");
  });

  it("carries reason and retryable out of a 503", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "update-unavailable",
          reason: "managed",
          message: "Updates laufen über deine Deploy-Plattform.",
          blockers: [],
          retryable: false,
        },
        { ok: false, status: 503 },
      ),
    );
    const err = (await api.startUpdate().catch((e: unknown) => e)) as UpdateApiError;
    expect(err.reason).toBe("managed");
    expect(err.retryable).toBe(false);
  });

  it("still produces a readable German sentence when the body is empty", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => {
        throw new Error("no body");
      },
    } as unknown as Response);
    const err = (await api.startUpdate().catch((e: unknown) => e)) as UpdateApiError;
    expect(err.message).toMatch(/Administratoren/);
    expect(err.retryable).toBeNull();
  });
});

describe("getUpdateJob", () => {
  it("returns the raw snapshot", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "job-1", phase: "build" }));
    await expect(api.getUpdateJob("job-1")).resolves.toMatchObject({ phase: "build" });
    expect(fetchMock).toHaveBeenCalledWith("/api/system/update/job-1", {
      credentials: "include",
    });
  });

  it("preserves `retryable: true` so the caller keeps polling through a restart", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: "updater-unreachable", retryable: true, message: "kurz weg" },
        { ok: false, status: 503 },
      ),
    );
    const err = (await api.getUpdateJob("job-1").catch((e: unknown) => e)) as UpdateApiError;
    expect(err.retryable).toBe(true);
  });

  it("encodes the job id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "x" }));
    await api.getUpdateJob("a/b");
    expect(fetchMock).toHaveBeenCalledWith("/api/system/update/a%2Fb", {
      credentials: "include",
    });
  });
});
