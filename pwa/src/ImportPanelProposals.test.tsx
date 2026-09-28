import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PipeJob } from "@lokyy/shared";

/**
 * Story „Ingest-Time-Synthese" (#67), AC 12 — der bestehende Import-Ablauf
 * bleibt unverändert bedienbar.
 *
 * Die Brücke zur Approval-Karte hängt an der OPTIONALEN Prop
 * `onOpenProposals`. Ohne sie fragt das Panel Vorschläge gar nicht ab — genau
 * das prüft der erste Test, und zwar hart: der api-Mock kennt
 * `listIngestProposals` nicht, ein Aufruf würde also werfen. So kann die neue
 * Stufe den Import auch dann nicht beschädigen, wenn sie serverseitig
 * abgeschaltet oder gar nicht deployed ist.
 */

const pipes = vi.fn();
const tree = vi.fn();
const getImportDefaults = vi.fn();
const importUrl = vi.fn();
const importFiles = vi.fn();
const listIngestProposals = vi.fn();

vi.mock("./api.js", () => ({
  api: {
    pipes: () => pipes(),
    tree: () => tree(),
    getImportDefaults: () => getImportDefaults(),
    importUrl: (req: unknown) => importUrl(req),
    importFiles: (files: unknown, folder?: string) => importFiles(files, folder),
    listIngestProposals: (status?: string) => listIngestProposals(status),
  },
}));

import { ImportPanel } from "./ImportPanel.js";

const JOB: PipeJob = {
  id: "job-1",
  type: "url",
  status: "done",
  payload: { url: "https://example.com/a" },
  resultNoteId: "30_captures/urls/a",
} as unknown as PipeJob;

function proposal(jobId: string, id: string) {
  return {
    id,
    vaultId: "vault-1",
    jobId,
    action: "link" as const,
    sourceNoteId: "30_captures/urls/a",
    targetNoteId: "10_projects/alt",
    rationale: "Gleicher Anbieter.",
    status: "pending" as const,
    evidence: null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
}

beforeEach(() => {
  pipes.mockResolvedValue([JOB]);
  tree.mockResolvedValue([]);
  getImportDefaults.mockResolvedValue({ defaultImportFolder: "30_captures" });
  importUrl.mockResolvedValue({ id: "job-1" });
  listIngestProposals.mockResolvedValue([]);
});

async function renderPanel(props: Record<string, unknown> = {}) {
  render(
    <ImportPanel open onClose={vi.fn()} onImported={vi.fn()} {...props} />,
  );
  await act(async () => {});
}

describe("ImportPanel — Brücke zur Approval-Karte", () => {
  it("fragt ohne onOpenProposals keine Vorschläge ab und importiert wie bisher", async () => {
    await renderPanel();

    fireEvent.change(screen.getByPlaceholderText("https://…"), {
      target: { value: "https://example.com/x" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Importieren" }));
    });

    expect(importUrl).toHaveBeenCalledWith({
      url: "https://example.com/x",
      type: undefined,
      targetFolder: "30_captures",
    });
    expect(listIngestProposals).not.toHaveBeenCalled();
    expect(screen.queryByTestId("job-proposals-job-1")).not.toBeInTheDocument();
  });

  it("zeigt den Hinweis an der Job-Zeile und öffnet die Karte", async () => {
    listIngestProposals.mockResolvedValue([
      proposal("job-1", "01A"),
      proposal("job-1", "01B"),
      proposal("job-other", "01C"),
    ]);
    const onOpenProposals = vi.fn();
    await renderPanel({ onOpenProposals });

    const hint = await waitFor(() => screen.getByTestId("job-proposals-job-1"));
    expect(hint).toHaveTextContent("2");

    fireEvent.click(hint);
    expect(onOpenProposals).toHaveBeenCalled();
  });

  it("zeigt bei keinen Vorschlägen keinen Hinweis", async () => {
    listIngestProposals.mockResolvedValue([]);
    await renderPanel({ onOpenProposals: vi.fn() });

    await waitFor(() => expect(listIngestProposals).toHaveBeenCalled());
    expect(screen.queryByTestId("job-proposals-job-1")).not.toBeInTheDocument();
  });

  it("lässt den Import laufen, wenn die Vorschlags-Abfrage scheitert", async () => {
    listIngestProposals.mockRejectedValue(new Error("503"));
    await renderPanel({ onOpenProposals: vi.fn() });

    await waitFor(() => expect(listIngestProposals).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Importieren" })).toBeInTheDocument();
    expect(screen.queryByTestId("job-proposals-job-1")).not.toBeInTheDocument();
  });
});
