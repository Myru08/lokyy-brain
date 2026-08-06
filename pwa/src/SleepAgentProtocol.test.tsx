import { describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchSleepAgentRuns = vi.fn();
vi.mock("./api.sleepAgent.js", () => ({
  fetchSleepAgentRuns: (limit?: number) => fetchSleepAgentRuns(limit),
}));

import { SleepAgentProtocol } from "./SleepAgentProtocol.js";
import realRuns from "./sleepAgentRuns.fixture.json";
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

  it("lässt Karten nicht zusammenquetschen (kein Clipping)", async () => {
    // Der Bug: die Liste ist eine Flex-Spalte, die Karte hat
    // `overflow: hidden` — damit fällt ihre automatische Mindesthöhe
    // (`min-height: auto`) weg und der Flex-Algorithmus staucht jede Karte
    // auf ~12px zusammen. Sichtbar bleibt eine Pille, der Text steckt
    // vollständig im DOM. Gegenmittel ist `flex-shrink: 0`.
    fetchSleepAgentRuns.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        id: `01JRUN000000000000000${String(i).padStart(4, "0")}`,
        phase: "nrem",
        trigger: "idle",
        status: "completed",
        startedAt: `2026-08-05T0${i + 1}:00:00.000Z`,
        finishedAt: `2026-08-05T0${i + 1}:00:20.000Z`,
        passesCompleted: ["importance-recompute"],
        passStats: { "importance-recompute": { processed: 2, errors: 0 } },
        notesProcessed: 2,
      })),
    );
    renderView();

    const cards = await screen.findAllByTestId("sleep-run-card");
    expect(cards).toHaveLength(6);
    for (const card of cards) {
      expect(card.style.flexShrink).toBe("0");
      expect(card.style.height).toBe("");
      expect(card.style.maxHeight).toBe("");
    }
  });

  it("zeigt einen abgebrochenen Arbeitsschritt als Fehler statt ihn zu verschlucken", async () => {
    fetchSleepAgentRuns.mockResolvedValue([
      {
        id: "01JRUN0000000000000000003",
        phase: "nrem",
        trigger: "idle",
        status: "completed",
        startedAt: "2026-08-05T01:00:00.000Z",
        finishedAt: "2026-08-05T01:00:10.000Z",
        passesCompleted: ["importance-recompute", "synaptic-pruning"],
        passStats: {
          "importance-recompute": { processed: 10, errors: 0 },
          "synaptic-pruning": {
            processed: 0,
            errors: 1,
            notes: "pass-error: Die Verbindung zur Datenbank brach ab",
          },
        },
        notesProcessed: 10,
      },
    ]);
    renderView();

    expect(
      await screen.findByText("Veraltete Verknüpfungen aufgeräumt"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Die Verbindung zur Datenbank brach ab/),
    ).toBeInTheDocument();
    // Fehleranzahl und bearbeitete Anzahl gehören beide in die Zeile.
    // Exakte Treffer, damit nicht der Fließtext weiter unten mitzählt.
    expect(screen.getByText("0 Notizen · 1 Fehler")).toBeInTheDocument();
    expect(screen.getByText("10 Notizen")).toBeInTheDocument();
    // Das technische Präfix bleibt draußen.
    expect(screen.queryByText(/pass-error/)).not.toBeInTheDocument();
  });

  it("bündelt Läufe nach Tag und blendet ältere erst auf Klick ein", async () => {
    // 12 Läufe: 11 heute, 1 gestern → initial nur 10 Karten.
    const runs = [
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `01JRUNHEUTE0000000000${String(i).padStart(4, "0")}`,
        startedAt: new Date(Date.now() - i * 1_800_000).toISOString(),
      })),
      {
        id: "01JRUNGESTERN00000000000",
        startedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
      },
    ].map((r) => ({
      ...r,
      phase: "nrem",
      trigger: "idle",
      status: "completed",
      finishedAt: r.startedAt,
      passesCompleted: ["importance-recompute"],
      passStats: { "importance-recompute": { processed: 1, errors: 0 } },
      notesProcessed: 1,
    }));
    fetchSleepAgentRuns.mockResolvedValue(runs);
    renderView();

    expect(await screen.findByText("Heute")).toBeInTheDocument();
    expect(screen.getAllByTestId("sleep-run-card")).toHaveLength(10);

    const more = screen.getByRole("button", { name: /Ältere anzeigen/ });
    fireEvent.click(more);

    await waitFor(() =>
      expect(screen.getAllByTestId("sleep-run-card")).toHaveLength(12),
    );
    expect(screen.getByText("Gestern")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Ältere anzeigen/ }),
    ).not.toBeInTheDocument();
  });

  it("rendert das ECHTE 30-Run-Fixture ohne Render-Schleife", async () => {
    // Regression: die Sichtprüfung fror den Chrome-Renderer ein, während
    // jsdom-Tests mit synthetischen Daten grün blieben. Dieser Test nimmt
    // deshalb die unveränderte Antwort von GET /api/sleep-agent/runs —
    // 30 Läufe über drei Kalendertage, jeder mit einem `errors: 1`-Schritt.
    //
    // Zwei Fangnetze: der Commit-Zähler schlägt bei einer Effekt-Schleife an
    // (die sonst nur die Zeit auffrisst), und das knappe Test-Timeout fängt
    // eine synchrone Endlosschleife.
    let commits = 0;
    fetchSleepAgentRuns.mockResolvedValue(realRuns);
    render(
      <Profiler id="protokoll" onRender={() => void commits++}>
        <SleepAgentProtocol item={ITEM} onOpenNote={vi.fn()} />
      </Profiler>,
    );

    expect(await screen.findAllByTestId("sleep-run-card")).toHaveLength(10);

    // Alle Stufen durchklicken, bis nichts mehr verborgen ist.
    for (let i = 0; i < 5; i++) {
      const more = screen.queryByRole("button", { name: /Ältere anzeigen/ });
      if (!more) break;
      fireEvent.click(more);
    }

    await waitFor(() =>
      expect(screen.getAllByTestId("sleep-run-card")).toHaveLength(
        realRuns.length,
      ),
    );
    expect(
      screen.queryByRole("button", { name: /Ältere anzeigen/ }),
    ).not.toBeInTheDocument();

    // Laden + vier Klickstufen sind eine Handvoll Commits. Dreistellig heißt
    // Schleife, nicht Nutzerinteraktion.
    expect(commits).toBeLessThan(30);
  }, 10_000);

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
