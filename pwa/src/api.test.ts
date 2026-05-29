import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api.js";

/**
 * `api.ts` is a thin fetch wrapper. These tests pin the wire contract that
 * the server depends on — exact URL, HTTP method, headers and JSON body —
 * plus the error path (`json<T>` → ApiError) that the UI branches on. All
 * network I/O is mocked; nothing hits a real server.
 */

/** Build a Response-like stub good enough for the wrapper's `.ok`/`.json()`/`.text()` reads. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  const ok = init?.ok ?? true;
  return {
    ok,
    status: init?.status ?? (ok ? 200 : 500),
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // putNote inspects navigator.onLine; default to online so the happy path runs.
  vi.stubGlobal("navigator", { onLine: true, userAgent: "vitest" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("api GET wrappers", () => {
  it("listNotes hits GET /api/notes and returns the parsed body", async () => {
    const notes = [{ id: "a", title: "A" }];
    fetchMock.mockResolvedValueOnce(jsonResponse(notes));

    const result = await api.listNotes();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes");
    expect(result).toEqual(notes);
  });

  it("getNote encodes the id straight into the path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "20_notes/x" }));

    await api.getNote("20_notes/x");

    expect(fetchMock).toHaveBeenCalledWith("/api/notes/20_notes/x");
  });
});

describe("api POST wrappers — method + body construction", () => {
  it("search posts query + limit as JSON to /api/search", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await api.search("hippocampus", 5);

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/search");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(opts.body as string)).toEqual({
      query: "hippocampus",
      limit: 5,
    });
  });

  it("search defaults limit to 20 when omitted", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await api.search("q");

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toEqual({ query: "q", limit: 20 });
  });

  it("createFolder posts the path to /api/vault/folder", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.createFolder("70_pai/notes");

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/vault/folder");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({ path: "70_pai/notes" });
  });
});

describe("api DELETE wrapper — query-string construction", () => {
  it("remove encodes path + kind into the query string", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.remove("a b/c.md", "note");

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/vault/entry?path=a%20b%2Fc.md&kind=note");
    expect(opts.method).toBe("DELETE");
  });
});

describe("error handling via json<T>", () => {
  it("throws ApiError with the server-supplied message on a non-ok JSON body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "boom" }, { ok: false, status: 500 }),
    );

    const err = await api.listNotes().catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toBe("boom");
  });

  it("falls back to statusText when the error body has no `error` field", async () => {
    fetchMock.mockResolvedValueOnce(
      // json() rejects → wrapper uses { error: res.statusText }
      {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => {
          throw new Error("not json");
        },
      } as unknown as Response,
    );

    await expect(api.graph()).rejects.toMatchObject({
      status: 503,
      message: "Service Unavailable",
    });
  });

  it("marks 409 responses as conflicts via ApiError.isConflict", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "merge conflict" }, { ok: false, status: 409 }),
    );

    const err = await api.listNotes().catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.isConflict).toBe(true);
  });

  it("non-409 errors are not flagged as conflicts", () => {
    expect(new ApiError(404, "nope").isConflict).toBe(false);
  });
});

describe("putNote", () => {
  it("PUTs the body as JSON to /api/notes/:id on the happy path", async () => {
    const note = { id: "x", body: "hello" };
    fetchMock.mockResolvedValueOnce(jsonResponse(note));

    const result = await api.putNote("x", "hello");

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/notes/x");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body as string)).toEqual({ body: "hello" });
    expect(result).toEqual(note);
  });
});
