import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  LintFindingsPanel,
  ageLabel,
  type LintFindingWithStatements,
} from "./LintFindingsPanel.js";

/**
 * AC3 + AC4 — Funde-Liste und Auflösen-Flow.
 *
 * Die zwei Garantien, die ein unachtsamer Refactor zerstören würde:
 *   - Auflösen VERLANGT eine Entscheidung. Ohne Auswahl ist der Button tot —
 *     sonst wäre „Auflösen" nur ein Löschen des Kastens, und genau das soll
 *     die Regel „Quelle reparieren" verhindern.
 *   - Beide Aussagen stehen im Klartext in der Liste, nicht nur Note-IDs.
 */

const FINDING: LintFindingWithStatements = {
  id: "01FINDING",
  kind: "contradiction",
  noteIds: ["10_projects/a", "10_projects/b"],
  severity: "warning",
  message: "Notes scheinen widersprüchlich: Preis unterscheidet sich.",
  evidence: null,
  status: "open",
  detectedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  resolvedAt: null,
  statements: [
    { noteId: "10_projects/a", title: "Angebot A", text: "Der Preis ist 100 €." },
    { noteId: "10_projects/b", title: "Angebot B", text: "Der Preis ist 250 €." },
  ],
};

const fetchMock = vi.fn();

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (typeof url === "string" && url.includes("/api/lint/findings?")) {
      return jsonResponse({ findings: [FINDING] });
    }
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPanel(overrides: Partial<Parameters<typeof LintFindingsPanel>[0]> = {}) {
  const onOpenNote = vi.fn();
  const onClose = vi.fn();
  render(
    <LintFindingsPanel
      open
      onClose={onClose}
      onOpenNote={onOpenNote}
      {...overrides}
    />,
  );
  return { onOpenNote, onClose };
}

describe("ageLabel", () => {
  it("renders the age of a finding in plain language", () => {
    const now = Date.parse("2026-08-06T12:00:00.000Z");
    expect(ageLabel("2026-08-06T09:00:00.000Z", now)).toBe("heute entdeckt");
    expect(ageLabel("2026-08-05T09:00:00.000Z", now)).toBe("seit gestern offen");
    expect(ageLabel("2026-08-01T09:00:00.000Z", now)).toBe("seit 5 Tagen offen");
  });
});

describe("LintFindingsPanel", () => {
  it("lists open findings with both statements and the age", async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(/Preis unterscheidet sich/)).toBeInTheDocument();
    });
    expect(screen.getByText("Der Preis ist 100 €.")).toBeInTheDocument();
    expect(screen.getByText("Der Preis ist 250 €.")).toBeInTheDocument();
    expect(screen.getByText("seit 3 Tagen offen")).toBeInTheDocument();
    expect(screen.getByText(/A · Angebot A/)).toBeInTheDocument();
    expect(screen.getByText(/B · Angebot B/)).toBeInTheDocument();
  });

  it("requests only open findings, statements included", async () => {
    renderPanel();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("status=open");
    expect(url).toContain("withStatements=1");
  });

  it("opens the note when a statement heading is clicked", async () => {
    const { onOpenNote } = renderPanel();
    await waitFor(() => screen.getByText(/A · Angebot A/));

    fireEvent.click(screen.getByText(/A · Angebot A/));
    expect(onOpenNote).toHaveBeenCalledWith("10_projects/a");
  });

  it("writes the callout box into the notes", async () => {
    renderPanel();
    await waitFor(() => screen.getByText("Kasten in Notiz"));

    fireEvent.click(screen.getByText("Kasten in Notiz"));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) => url === "/api/lint/findings/01FINDING/callout",
        ),
      ).toBe(true);
    });
  });

  it("shows the repair rule so the box is not just deleted", async () => {
    renderPanel();
    expect(
      screen.getByText(/Quelle reparieren, nicht nur den Kasten löschen/),
    ).toBeInTheDocument();
  });

  it("refuses to resolve until a statement is chosen", async () => {
    renderPanel();
    await waitFor(() => screen.getByText("Auflösen"));
    fireEvent.click(screen.getByText("Auflösen"));

    const confirm = screen.getByText("Auflösen & Kasten entfernen")
      .closest("button") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(confirm);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/resolve")),
    ).toBe(false);
  });

  it("resolves with the chosen statement", async () => {
    renderPanel();
    await waitFor(() => screen.getByText("Auflösen"));
    fireEvent.click(screen.getByText("Auflösen"));

    fireEvent.click(screen.getByLabelText(/B gilt — Angebot B/));
    fireEvent.click(screen.getByText("Auflösen & Kasten entfernen"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/resolve"),
      );
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        choice: "10_projects/b",
      });
    });
  });

  it("resolves as a false alarm via 'beide ok'", async () => {
    renderPanel();
    await waitFor(() => screen.getByText("Auflösen"));
    fireEvent.click(screen.getByText("Auflösen"));

    fireEvent.click(screen.getByLabelText(/beide ok/));
    fireEvent.click(screen.getByText("Auflösen & Kasten entfernen"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/resolve"),
      );
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        choice: "both_ok",
      });
    });
  });

  it("surfaces a server error instead of failing silently", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ error: "finding not found" }, false, 404),
    );
    renderPanel();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("finding not found");
    });
  });

  it("reports the open count to the header badge", async () => {
    const onCountChange = vi.fn();
    renderPanel({ onCountChange });
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));
  });
});
