import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchSleepAgentRuns = vi.fn();
vi.mock("./api.sleepAgent.js", () => ({
  fetchSleepAgentRuns: (limit?: number) => fetchSleepAgentRuns(limit),
}));

import { SleepAgentProtocol } from "./SleepAgentProtocol.js";
import type { MenuItem } from "./sidebar/views/registry.js";

/**
 * Render-Smoke-Test der Nacht-Protokoll-Ansicht (Story C1, AC2).
 *
 * Prüft die drei Zustände, die dem Nutzer sonst als weißer Bildschirm
 * begegnen — leer, Fehler, gefüllt — und dass ein Klick auf eine berührte
 * Notiz den Öffnen-Callback mit der Notiz-Kennung aufruft. Bewusst kein
 * Snapshot: getestet wird Verhalten, nicht Pixel.
 */

const ITEM: MenuItem = {
  id: "system:sleep-agent",
  label: "Nacht-Protokoll",
  icon: "Moon",
  folder: "",
  // Die Ansicht wertet `item` nicht aus (kein Ordner-Bezug); der View-Typ ist
  // hier belanglos und bleibt auf einem existierenden Wert, solange
  // "sleepAgent" noch nicht in der Registry-Union steht (WIRING-TODO).
  viewType: "tree",
  shortcut: null,
  kind: "system",
};

function renderView(onOpenNote = vi.fn()) {
  render(<SleepAgentProtocol item={ITEM} onOpenNote={onOpenNote} />);
  return onOpenNote;
}

describe("SleepAgentProtocol", () => {
  it("zeigt einen gestalteten Leerzustand statt eines leeren Bildschirms", async () => {
    fetchSleepAgentRuns.mockResolvedValue([]);
    renderView();

    expect(
      await screen.findByText("Noch kein Lauf protokolliert"),
    ).toBeInTheDocument();
  });

  it("zeigt bei nicht erreichbarer API einen gestalteten Fehlerzustand", async () => {
    fetchSleepAgentRuns.mockRejectedValue(new Error("Failed to fetch"));
    renderView();

    expect(
      await screen.findByText("Das Protokoll ist gerade nicht erreichbar"),
    ).toBeInTheDocument();
    expect(screen.getByText("Erneut versuchen")).toBeInTheDocument();
  });

  it("listet Läufe mit deutschem Klartext statt technischer Namen", async () => {
    fetchSleepAgentRuns.mockResolvedValue([
      {
        id: "01JRUN0000000000000000001",
        phase: "nrem",
        trigger: "nightly",
        status: "completed",
        startedAt: "2026-08-05T01:00:00.000Z",
        finishedAt: "2026-08-05T01:02:30.000Z",
        passesCompleted: ["karpathy-lint"],
        passStats: { "karpathy-lint": { processed: 4, errors: 0 } },
        notesProcessed: 4,
      },
    ]);
    renderView();

    // Erste Karte ist aufgeklappt → der Arbeitsschritt ist direkt sichtbar.
    expect(
      await screen.findByText("Vault auf Lücken und Widersprüche geprüft"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("4 Notizen bearbeitet · 1 Arbeitsschritt"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/karpathy-lint/)).not.toBeInTheDocument();
  });

  it("öffnet eine berührte Notiz über den Callback", async () => {
    fetchSleepAgentRuns.mockResolvedValue([
      {
        id: "01JRUN0000000000000000002",
        phase: "rem",
        trigger: "idle",
        status: "completed",
        startedAt: "2026-08-05T01:00:00.000Z",
        finishedAt: "2026-08-05T01:00:20.000Z",
        passesCompleted: ["topic-synthesis"],
        passStats: {
          "topic-synthesis": {
            processed: 1,
            errors: 0,
            notePaths: ["20_topics/ki-agenten.md"],
          },
        },
        notesProcessed: 1,
      },
    ]);
    const onOpenNote = renderView();

    const label = await screen.findByText("ki-agenten");
    const button = label.closest("button");
    expect(button).not.toBeNull();
    fireEvent.click(button as HTMLButtonElement);

    await waitFor(() =>
      expect(onOpenNote).toHaveBeenCalledWith("20_topics/ki-agenten.md"),
    );
  });
});
