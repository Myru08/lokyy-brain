import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Story „Ingest-Time-Synthese" (#67), AC 10 + 11.
 *
 * Geprüft wird die eine Zusage, an der die ganze Stufe hängt: **nichts wird
 * ohne Freigabe geschrieben**, und der Nutzer sieht, was er freigibt.
 *
 *   - Begründung (`rationale`) steht in der Karte, nicht nur die Note-IDs.
 *     Ohne sie wäre ein Haken ein Blindflug.
 *   - Freigabe und Ablehnung landen GETRENNT im `apply`-Vertrag. Unentschieden
 *     ist eine dritte Lage und wird gar nicht gesendet — ein Vorschlag, den
 *     niemand angesehen hat, ist nicht abgelehnt.
 *   - `skipped` wird mit Grund angezeigt. Ein Vorschlag, der nicht angewandt
 *     werden konnte, darf nicht still verschwinden.
 *   - Keine Vorschläge ist der Normalfall → keine leere, ratlose Karte.
 */

const listIngestProposals = vi.fn();
const applyIngestProposals = vi.fn();

vi.mock("./api.js", () => ({
  api: {
    listIngestProposals: (status?: string) => listIngestProposals(status),
    applyIngestProposals: (body: unknown) => applyIngestProposals(body),
  },
}));

import { IngestProposalsPanel } from "./IngestProposalsPanel.js";
import type { IngestProposal } from "./api.js";

function proposal(over: Partial<IngestProposal> = {}): IngestProposal {
  return {
    id: "01LINK",
    vaultId: "vault-1",
    jobId: "job-1",
    action: "link",
    sourceNoteId: "30_captures/urls/neu",
    targetNoteId: "10_projects/alt",
    rationale: "Beide Notizen sprechen über denselben Anbieter.",
    status: "pending",
    evidence: null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    ...over,
  };
}

const MERGE = proposal({
  id: "01MERGE",
  action: "merge",
  rationale: "Die neue Notiz wiederholt die bestehende fast wörtlich.",
});

beforeEach(() => {
  listIngestProposals.mockResolvedValue([]);
  applyIngestProposals.mockResolvedValue({ applied: [], skipped: [] });
});

async function renderPanel() {
  const onClose = vi.fn();
  const onOpenNote = vi.fn();
  render(<IngestProposalsPanel open onClose={onClose} onOpenNote={onOpenNote} />);
  await act(async () => {});
  return { onClose, onOpenNote };
}

describe("IngestProposalsPanel", () => {
  it("zeigt jeden Vorschlag mit Begründung und einem Haken", async () => {
    listIngestProposals.mockResolvedValue([proposal()]);
    await renderPanel();

    await waitFor(() =>
      expect(
        screen.getByText(/Beide Notizen sprechen über denselben Anbieter/),
      ).toBeInTheDocument(),
    );
    // Der Haken je Vorschlag — nicht der Sammel-Haken im Fuß.
    const tick = screen.getByTestId("approve-01LINK");
    expect(tick).toHaveAttribute("type", "checkbox");
    expect(tick).not.toBeChecked();
    expect(screen.getByText("30_captures/urls/neu")).toBeInTheDocument();
    expect(screen.getByText("10_projects/alt")).toBeInTheDocument();
  });

  it("trennt Freigabe und Ablehnung im apply-Vertrag; Unentschiedenes bleibt draußen", async () => {
    listIngestProposals.mockResolvedValue([
      proposal({ id: "01A" }),
      proposal({ id: "01B" }),
      proposal({ id: "01C" }),
    ]);
    await renderPanel();

    await waitFor(() => expect(screen.getAllByTestId(/^proposal-/)).toHaveLength(3));

    fireEvent.click(screen.getByTestId("approve-01A"));
    fireEvent.click(screen.getByTestId("reject-01B"));
    // 01C bleibt unentschieden.

    await act(async () => {
      fireEvent.click(screen.getByTestId("apply-decisions"));
    });

    expect(applyIngestProposals).toHaveBeenCalledWith({
      approved: ["01A"],
      rejected: ["01B"],
    });
  });

  it("macht sichtbar, dass Ablehnen nichts löscht", async () => {
    listIngestProposals.mockResolvedValue([proposal()]);
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId("reject-01LINK")).toBeInTheDocument());

    // An der Karte selbst UND im Kopf des Panels — die Aussage darf nicht nur
    // im Kleingedruckten stehen, sondern dort, wo geklickt wird.
    expect(
      screen.getAllByText(/bleib\w* im Protokoll/i).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(/Ablehnen löscht nichts/i),
    ).toBeInTheDocument();
  });

  it("unterscheidet folgenschwere von ergänzenden Vorschlägen", async () => {
    listIngestProposals.mockResolvedValue([proposal(), MERGE]);
    await renderPanel();

    await waitFor(() => expect(screen.getByTestId("proposal-01MERGE")).toBeInTheDocument());

    expect(screen.getByTestId("proposal-01MERGE")).toHaveAttribute(
      "data-impact",
      "heavy",
    );
    expect(screen.getByTestId("proposal-01LINK")).toHaveAttribute(
      "data-impact",
      "additive",
    );

    // Der Sammel-Haken greift NUR die ergänzenden — ein „merge" bekommt seine
    // Freigabe einzeln oder gar nicht.
    fireEvent.click(screen.getByTestId("approve-additive"));
    expect(screen.getByTestId("approve-01LINK")).toBeChecked();
    expect(screen.getByTestId("approve-01MERGE")).not.toBeChecked();
  });

  it("zeigt skipped samt Grund aus der Antwort", async () => {
    listIngestProposals.mockResolvedValue([proposal()]);
    applyIngestProposals.mockResolvedValue({
      applied: [],
      skipped: [{ id: "01LINK", reason: "Zielnotiz wurde zwischenzeitlich gelöscht" }],
    });
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId("approve-01LINK")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("approve-01LINK"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("apply-decisions"));
    });

    expect(
      screen.getByText(/Zielnotiz wurde zwischenzeitlich gelöscht/),
    ).toBeInTheDocument();
  });

  it("zeigt bei keinen Vorschlägen keine Karte und keinen Freigabe-Knopf", async () => {
    listIngestProposals.mockResolvedValue([]);
    await renderPanel();

    await waitFor(() => expect(screen.getByTestId("proposals-none")).toBeInTheDocument());
    expect(screen.queryAllByTestId(/^proposal-/)).toHaveLength(0);
    expect(screen.queryByTestId("apply-decisions")).not.toBeInTheDocument();
  });

  it("sendet nichts, solange keine Entscheidung gefallen ist", async () => {
    listIngestProposals.mockResolvedValue([proposal()]);
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId("apply-decisions")).toBeInTheDocument());

    expect(screen.getByTestId("apply-decisions")).toBeDisabled();
    expect(applyIngestProposals).not.toHaveBeenCalled();
  });
});
