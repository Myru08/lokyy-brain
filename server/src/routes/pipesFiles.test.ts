import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { PipeJob, PipeType, SharePayload } from "@lokyy/shared";

/**
 * Issue #63 — `POST /api/pipes/files`.
 *
 * Geprüft wird der API-Vertrag der Route, nicht die Pipe-Handler: N Dateien →
 * N Jobs, alles Abgewiesene benannt in `rejected`, und — der eigentliche
 * Grund für diese Datei — dass ein client-gelieferter Pfad den Vault nicht
 * verlassen kann.
 *
 * `enqueue` ist gemockt und protokolliert nur, WAS in die Queue ginge. Damit
 * misst der Test die Entscheidung der Route (Typ, Zielordner, Ablehnung) und
 * nicht das Verhalten von git oder pdf.js.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

const VAULT_DIR = "/srv/lokyy/vault";

/** Jeder Job, der die Route verlassen hat — Payload inklusive. */
let enqueued: { type: PipeType | undefined; payload: SharePayload }[] = [];

vi.mock("@lokyy/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Die Pfad-/Typ-Prüfungen bleiben echt — sie sind der Prüfgegenstand.
    coreConfig: () => ({
      vaultDir: VAULT_DIR,
      gitRemote: "",
      gitBranch: "main",
      gitAuthorName: "test",
      gitAuthorEmail: "test@localhost",
    }),
    enqueue: (payload: SharePayload, type?: PipeType): PipeJob => {
      enqueued.push({ type, payload });
      return {
        id: `job-${enqueued.length}`,
        type: type ?? "unknown",
        status: "queued",
        payload,
        createdAt: new Date().toISOString(),
      };
    },
    listJobs: () => [],
  };
});

vi.mock("../settings/importDefaults.js", () => ({
  resolveDefaultImportFolder: async () => "30_captures",
}));

let app: Hono;

beforeAll(async () => {
  const mod = await import("./pipes.js");
  app = new Hono();
  app.route("/api/pipes", mod.pipesRoutes);
});

beforeEach(() => {
  enqueued = [];
});

/** multipart-Body bauen: Dateien plus die parallelen `relativePath`-Felder. */
function filesForm(
  files: { name: string; mime: string; content: string | Uint8Array; relativePath?: string }[],
  targetFolder?: string,
): FormData {
  const form = new FormData();
  for (const f of files) {
    const bytes =
      typeof f.content === "string"
        ? new TextEncoder().encode(f.content)
        : f.content;
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    form.append("file", new File([ab], f.name, { type: f.mime }));
    form.append("relativePath", f.relativePath ?? "");
  }
  if (targetFolder !== undefined) form.append("targetFolder", targetFolder);
  return form;
}

function post(form: FormData): Promise<Response> {
  return app.request("/api/pipes/files", { method: "POST", body: form });
}

describe("POST /api/pipes/files — der Normalfall", () => {
  it("legt je Datei einen Job an", async () => {
    const res = await post(
      filesForm([
        { name: "eins.md", mime: "text/markdown", content: "# Eins" },
        { name: "zwei.txt", mime: "text/plain", content: "zwei" },
        { name: "drei.md", mime: "application/octet-stream", content: "# Drei" },
      ]),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobs: PipeJob[]; rejected: unknown[] };
    expect(body.jobs).toHaveLength(3);
    expect(body.rejected).toEqual([]);
    // Auch die `.md` mit octet-stream muss als Text erkannt worden sein.
    expect(enqueued.map((e) => e.type)).toEqual(["text", "text", "text"]);
  });

  it("erhält die Ordnerstruktur unter dem Zielordner", async () => {
    await post(
      filesForm(
        [
          {
            name: "notiz.md",
            mime: "text/markdown",
            content: "# n",
            relativePath: "Vault/Projekte/notiz.md",
          },
          {
            name: "oben.md",
            mime: "text/markdown",
            content: "# o",
            relativePath: "Vault/oben.md",
          },
        ],
        "20_notes",
      ),
    );

    expect(enqueued.map((e) => e.payload.targetFolder)).toEqual([
      "20_notes/Vault/Projekte",
      "20_notes/Vault",
    ]);
    expect(enqueued[0]!.payload.relativePath).toBe("Vault/Projekte/notiz.md");
  });

  it("nimmt den Settings-Default, wenn kein targetFolder mitkommt", async () => {
    await post(filesForm([{ name: "a.md", mime: "text/markdown", content: "# a" }]));
    expect(enqueued[0]!.payload.targetFolder).toBe("30_captures");
  });

  it("erkennt PDF und reicht die Bytes durch", async () => {
    await post(filesForm([{ name: "b.pdf", mime: "application/pdf", content: "%PDF-1.4" }]));
    expect(enqueued[0]!.type).toBe("pdf");
    expect(
      Buffer.from(enqueued[0]!.payload.file!.dataBase64, "base64").toString("utf8"),
    ).toBe("%PDF-1.4");
  });
});

describe("POST /api/pipes/files — Pfad-Ausbruch", () => {
  const attempts = [
    { label: "relatives ..", relativePath: "../../etc/passwd" },
    { label: "absoluter Pfad", relativePath: "/etc/passwd" },
    { label: "Laufwerksbuchstabe", relativePath: "C:\\Windows\\notiz.md" },
    { label: "tief verschachteltes ..", relativePath: "a/b/../../../../root/notiz.md" },
  ];

  for (const attempt of attempts) {
    it(`weist ${attempt.label} ab und legt KEINEN Job an`, async () => {
      const res = await post(
        filesForm([
          {
            name: "notiz.md",
            mime: "text/markdown",
            content: "# x",
            relativePath: attempt.relativePath,
          },
        ]),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        jobs: PipeJob[];
        rejected: { name: string; reason: string }[];
      };
      expect(body.jobs).toEqual([]);
      expect(body.rejected).toHaveLength(1);
      expect(body.rejected[0]!.reason).toBeTruthy();
      expect(enqueued).toHaveLength(0);
    });
  }

  it("kein akzeptierter Job zeigt je aus dem Vault heraus", async () => {
    await post(
      filesForm([
        { name: "gut.md", mime: "text/markdown", content: "# gut", relativePath: "ordner/gut.md" },
        { name: "boese.md", mime: "text/markdown", content: "# b", relativePath: "../../boese.md" },
      ]),
    );

    expect(enqueued).toHaveLength(1);
    const { resolveInsideVault } = await import("@lokyy/core");
    for (const job of enqueued) {
      expect(resolveInsideVault(VAULT_DIR, job.payload.targetFolder!)).not.toBeNull();
    }
  });
});

describe("POST /api/pipes/files — nichts wird still verschluckt", () => {
  it("gemischt gültig/ungültig: beides steht in der Antwort", async () => {
    const res = await post(
      filesForm([
        { name: "gut.md", mime: "text/markdown", content: "# gut" },
        { name: "foto.png", mime: "image/png", content: "\u0089PNG" },
        { name: "archiv.zip", mime: "application/zip", content: "PK" },
      ]),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      jobs: PipeJob[];
      rejected: { name: string; reason: string }[];
    };
    expect(body.jobs).toHaveLength(1);
    expect(body.rejected.map((r) => r.name)).toEqual(["foto.png", "archiv.zip"]);
    for (const r of body.rejected) expect(r.reason).toMatch(/nicht unterstützt/);
  });

  it("eine zu grosse Datei wird benannt abgewiesen statt zu werfen", async () => {
    const { config } = await import("../config.js");
    const tooBig = "x".repeat(config.importMaxFileBytes + 1);

    const res = await post(
      filesForm([
        { name: "klein.md", mime: "text/markdown", content: "# ok" },
        { name: "riesig.md", mime: "text/markdown", content: tooBig },
      ]),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      jobs: PipeJob[];
      rejected: { name: string; reason: string }[];
    };
    expect(body.jobs).toHaveLength(1);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.name).toBe("riesig.md");
    expect(body.rejected[0]!.reason).toMatch(/zu gross/);
  });

  it("weist eine leere Datei benannt ab", async () => {
    const res = await post(filesForm([{ name: "leer.md", mime: "text/markdown", content: "" }]));
    const body = (await res.json()) as { rejected: { reason: string }[] };
    expect(res.status).toBe(400);
    expect(body.rejected[0]!.reason).toMatch(/leer/);
  });
});

describe("POST /api/pipes/files — Fehlerfälle", () => {
  it("400, wenn gar keine Datei dabei ist", async () => {
    const form = new FormData();
    form.append("targetFolder", "30_captures");
    const res = await post(form);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; jobs: unknown[] };
    expect(body.error).toBe("no-files");
    expect(body.jobs).toEqual([]);
  });

  it("400 bei falschem Content-Type", async () => {
    const res = await app.request("/api/pipes/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad-content-type");
  });

  it("413, wenn die Anfrage laut Content-Length die Obergrenze reisst", async () => {
    const { config } = await import("../config.js");
    const res = await app.request("/api/pipes/files", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(config.importMaxRequestBytes + 1),
      },
      body: "--x--",
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("request-too-large");
    // Entscheidend: der Body wurde gar nicht erst geparst.
    expect(enqueued).toHaveLength(0);
  });
});
