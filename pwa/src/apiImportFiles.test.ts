import { describe, expect, it, vi, afterEach } from "vitest";
import { api } from "./api.js";

/**
 * Vertrags-Test für `POST /api/pipes/files`.
 *
 * Der Server-Vertrag verlangt `file` und `relativePath` je n-mal, parallel
 * und in gleicher Reihenfolge — genau das kann eine Oberfläche leise
 * verletzen, ohne dass ein Typ-Check anschlägt. Deshalb wird hier die
 * gebaute FormData selbst geprüft, nicht nur der Aufruf.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(body: unknown, status = 202) {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe("api.importFiles", () => {
  it("baut multipart/form-data mit paarweisen Feldern in Reihenfolge", async () => {
    const spy = mockFetch({ jobs: [], rejected: [] });

    const a = new File(["a"], "a.md", { type: "text/markdown" });
    const b = new File(["b"], "b.txt", { type: "text/plain" });

    await api.importFiles(
      [
        { file: a, relativePath: "" },
        { file: b, relativePath: "ordner/b.txt" },
      ],
      "30_captures/import",
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/pipes/files");
    expect(init.method).toBe("POST");
    // Kein Content-Type von Hand — der Browser setzt die multipart-Boundary.
    expect(init.headers).toBeUndefined();

    const fd = init.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect((fd.getAll("file") as File[]).map((f) => f.name)).toEqual([
      "a.md",
      "b.txt",
    ]);
    expect(fd.getAll("relativePath")).toEqual(["", "ordner/b.txt"]);
    expect(fd.getAll("targetFolder")).toEqual(["30_captures/import"]);
  });

  it("lässt targetFolder weg, wenn keiner gesetzt ist", async () => {
    const spy = mockFetch({ jobs: [], rejected: [] });
    await api.importFiles([
      { file: new File(["a"], "a.md"), relativePath: "" },
    ]);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as FormData).getAll("targetFolder")).toEqual([]);
  });

  it("gibt jobs und rejected unverändert zurück", async () => {
    mockFetch({
      jobs: [{ id: "j1", type: "url", status: "queued" }],
      rejected: [{ name: "x.png", reason: "Dateityp nicht unterstützt" }],
    });

    const res = await api.importFiles([
      { file: new File(["a"], "a.md"), relativePath: "" },
    ]);

    expect(res.jobs).toHaveLength(1);
    expect(res.rejected).toEqual([
      { name: "x.png", reason: "Dateityp nicht unterstützt" },
    ]);
  });

  it("wirft mit der Server-Meldung, wenn der Server keine Gründe mitliefert", async () => {
    mockFetch({ error: "Keine verwertbare Datei dabei" }, 400);
    await expect(
      api.importFiles([{ file: new File(["a"], "a.png"), relativePath: "" }]),
    ).rejects.toThrow("Keine verwertbare Datei dabei");
  });

  it("behält die Gründe, wenn das 400 sie mitbringt, statt sie wegzuwerfen", async () => {
    // Laut Vertrag trägt auch das 400 die `rejected`-Liste. Ein Wurf würde
    // genau das verlieren, was der Nutzer sehen muss.
    mockFetch(
      {
        error: "Keine verwertbare Datei dabei",
        jobs: [],
        rejected: [{ name: "a.png", reason: "Dateityp nicht unterstützt" }],
      },
      400,
    );

    const res = await api.importFiles([
      { file: new File(["a"], "a.png"), relativePath: "" },
    ]);

    expect(res.jobs).toEqual([]);
    expect(res.rejected).toEqual([
      { name: "a.png", reason: "Dateityp nicht unterstützt" },
    ]);
  });

  it("wirft bei einem echten Transportfehler (413) statt ihn zu verschlucken", async () => {
    mockFetch({ error: "Zu groß" }, 413);
    await expect(
      api.importFiles([{ file: new File(["a"], "a.md"), relativePath: "" }]),
    ).rejects.toThrow("Zu groß");
  });
});
