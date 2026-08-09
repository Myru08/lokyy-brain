import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AgentReviewPanel } from "./AgentReviewPanel.js";
import { api, type AgentReviewQueue, type TopicNoteItem } from "./api.js";

/**
 * Eine fehlgeschlagene Aktion muss die Liste NACHLADEN.
 *
 * DER BUG: `runAction` hat nur im Erfolgsfall aktualisiert. In Produktion sah
 * das so aus — der Nutzer nimmt drei Topic-Notizen an, alle drei laufen in
 * einen 422 ("not in agent state"), und die Karten bleiben stehen. Sie waren zu
 * dem Zeitpunkt längst nicht mehr in der Queue (die filtert auf
 * `origin === "agent"`), aber die Oberfläche zeigte weiter Karten mit einem
 * Annehmen-Knopf, der nur denselben Fehler nochmal erzeugen konnte.
 *
 * Die zweite Garantie hier ist subtil und leicht wieder kaputtzumachen:
 * `refresh` beginnt mit `setError(null)`. Wer den Refresh VOR das Setzen der
 * Meldung schiebt, bekommt die Liste zwar frisch, aber der Nutzer sieht keinen
 * Fehler mehr — nur noch verschwundene Karten ohne Erklärung.
 */

const TOPIC: TopicNoteItem = {
  id: "70_pai/topics/auto-projekt-001",
  title: "Projekt 001",
  confidence: 0.6,
  sourceNotes: ["10_projects/prj-001/projekt", "40_tasks/a", "40_tasks/b"],
  bodyPreview: "Zusammenfassung des Clusters.",
  generatedAt: "2026-08-09T03:00:15.068Z",
  communityId: "c1",
};

function queueWith(topics: TopicNoteItem[]): AgentReviewQueue {
  return { mem0: [], lint: [], topicNotes: topics, totalPending: topics.length };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AgentReviewPanel — fehlgeschlagene Aktion", () => {
  it("lädt die Queue neu und zeigt trotzdem den Fehler", async () => {
    // Erst mit Karte, nach der fehlgeschlagenen Aktion ohne — genau der
    // Server-Zustand, der den 422 ausgelöst hat.
    const getQueue = vi
      .spyOn(api, "getAgentReviewQueue")
      .mockResolvedValueOnce(queueWith([TOPIC]))
      .mockResolvedValue(queueWith([]));
    vi.spyOn(api, "acceptTopicNote").mockRejectedValue(
      new Error("topic note 70_pai/topics/auto-projekt-001 is not in agent state (origin=curated)"),
    );

    render(
      <AgentReviewPanel open onClose={() => {}} onOpenNote={() => {}} />,
    );

    await screen.findByText("Projekt 001");
    fireEvent.click(screen.getByText("Accept (move)"));

    // 1. Die Liste wurde nachgeladen und die tote Karte ist weg.
    await waitFor(() => {
      expect(screen.queryByText("Projekt 001")).toBeNull();
    });
    expect(getQueue).toHaveBeenCalledTimes(2);

    // 2. Der Fehler steht trotzdem noch da — der Refresh darf ihn nicht
    //    wegräumen (`refresh` beginnt mit setError(null)).
    expect(screen.getByText(/is not in agent state/)).toBeTruthy();
  });

  it("aktualisiert nach einer erfolgreichen Aktion wie bisher", async () => {
    const getQueue = vi
      .spyOn(api, "getAgentReviewQueue")
      .mockResolvedValueOnce(queueWith([TOPIC]))
      .mockResolvedValue(queueWith([]));
    vi.spyOn(api, "acceptTopicNote").mockResolvedValue(undefined);

    render(
      <AgentReviewPanel open onClose={() => {}} onOpenNote={() => {}} />,
    );

    await screen.findByText("Projekt 001");
    fireEvent.click(screen.getByText("Accept (move)"));

    await waitFor(() => {
      expect(screen.queryByText("Projekt 001")).toBeNull();
    });
    expect(getQueue).toHaveBeenCalledTimes(2);
  });
});
