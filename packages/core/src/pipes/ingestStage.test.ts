import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipeJob } from "@lokyy/shared";

/**
 * Issue #67 — die Synthese-Stufe hängt IM Import-Pfad.
 *
 * DAS ANTI-KRITERIUM (AC#8): ein Fehler in der Stufe darf den Import NIE
 * fehlschlagen lassen. Der Capture ist wichtiger als die Synthese — eine
 * geteilte Sprachnotiz, die wegen eines kaputten Judge verloren geht, ist ein
 * schlimmerer Fehler als eine Notiz ohne Vorschläge.
 *
 * Geprüft wird an der Queue selbst: `save()` und die Stufe sind gemockt, der
 * Job läuft echt durch `drain()`. Der zweite Fall ist die Gegenprobe — die
 * Stufe wird wirklich aufgerufen, mit dem Body VOR dem Commit-Ergebnis, und
 * ihre Hinweise landen am Job.
 */

const save = vi.fn(async () => undefined);
vi.mock("../git/gitService.js", () => ({
  save: (...args: unknown[]) => save(...(args as [])),
}));

let synthesis = vi.fn(async () => ({
  proposals: [],
  notices: [],
  alerts: [] as string[],
  judgeCalls: 0,
  mode: "full" as const,
}));
vi.mock("../ingest/synthesis.js", () => ({
  runIngestSynthesis: (...args: unknown[]) => synthesis(...(args as [])),
}));

const { enqueue, listJobs, registerHandler } = await import("./pipeQueue.js");

registerHandler("text", async () => ({
  path: "30_captures/texte/neu.md",
  body: "# Neu\n\nInhalt.\n",
}));

/** Wartet, bis der Job die Queue verlassen hat (done/error). */
async function settled(id: string): Promise<PipeJob> {
  for (let i = 0; i < 200; i++) {
    const job = listJobs().find((j) => j.id === id);
    if (job && job.status !== "queued" && job.status !== "processing") return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Job ${id} wurde nicht fertig`);
}

beforeEach(() => {
  save.mockClear();
  synthesis = vi.fn(async () => ({
    proposals: [],
    notices: [],
    alerts: [] as string[],
    judgeCalls: 0,
    mode: "full" as const,
  }));
});

describe("Synthese-Stufe in der Pipe-Queue", () => {
  it("lässt den Import erfolgreich sein, wenn die Stufe wirft", async () => {
    synthesis = vi.fn(async () => {
      throw new Error("Judge explodiert");
    });

    const job = await settled(enqueue({ text: "irgendwas" }, "text").id);

    expect(job.status).toBe("done");
    expect(job.resultNoteId).toBe("30_captures/texte/neu");
    expect(save).toHaveBeenCalledTimes(1);
    // Nicht still: der Ausfall steht am Job.
    expect(job.notice).toMatch(/Synthese ausgefallen: Judge explodiert/);
  });

  it("sieht den Body der neuen Notiz und hängt Hinweise an den Job", async () => {
    synthesis = vi.fn(async () => ({
      proposals: [{ id: "p1" }] as never,
      notices: ["egal"],
      alerts: ["Zeitbudget (5000 ms) überschritten"],
      judgeCalls: 1,
      mode: "full" as const,
    }));

    const job = await settled(enqueue({ text: "irgendwas" }, "text").id);

    expect(job.status).toBe("done");
    expect(synthesis).toHaveBeenCalledWith({
      jobId: job.id,
      noteId: "30_captures/texte/neu",
      body: "# Neu\n\nInhalt.\n",
    });
    expect(job.notice).toMatch(/Synthese: 1 Vorschlag/);
    expect(job.notice).toMatch(/Zeitbudget/);
  });

  it("committet den Capture, bevor die Stufe läuft", async () => {
    const order: string[] = [];
    save.mockImplementationOnce(async () => {
      order.push("save");
      return undefined;
    });
    synthesis = vi.fn(async () => {
      order.push("synthese");
      return {
        proposals: [],
        notices: [],
        alerts: [] as string[],
        judgeCalls: 0,
        mode: "full" as const,
      };
    });

    await settled(enqueue({ text: "irgendwas" }, "text").id);

    expect(order).toEqual(["save", "synthese"]);
  });
});
