import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Verhaltens-Tests des Import-Panels für den Datei-/Ordner-Import
 * (Story „Dateien und Ordner vom Rechner importieren", AC 11–15).
 *
 * Der Endpunkt wird gemockt — geprüft wird, was die Oberfläche daraus
 * macht: der Vertrag der Anfrage, die Anzeige abgewiesener Dateien, das
 * Verstecken der Ordner-Auswahl ohne Browser-Unterstützung und dass der
 * bestehende URL-Import davon unberührt bleibt.
 */

const pipes = vi.fn();
const tree = vi.fn();
const getImportDefaults = vi.fn();
const importUrl = vi.fn();
const importFiles = vi.fn();

vi.mock("./api.js", () => ({
  api: {
    pipes: () => pipes(),
    tree: () => tree(),
    getImportDefaults: () => getImportDefaults(),
    importUrl: (req: unknown) => importUrl(req),
    importFiles: (files: unknown, folder?: string) => importFiles(files, folder),
  },
}));

import { ImportPanel } from "./ImportPanel.js";

async function renderPanel() {
  const onImported = vi.fn();
  const onClose = vi.fn();
  render(<ImportPanel open onClose={onClose} onImported={onImported} />);
  // Defaults + Ordnerbaum einfließen lassen, damit ihre Zusagen INNERHALB
  // von act() landen — sonst warnt React über State-Updates nach dem Test.
  await act(async () => {});
  return { onImported, onClose };
}

/** Wechselt auf den Datei-Reiter. */
function openFilesTab() {
  fireEvent.click(screen.getByRole("tab", { name: /Dateien/ }));
}

/** Setzt eine Auswahl auf ein verstecktes File-Input, wie es der Dialog täte. */
function chooseFiles(testId: string, files: File[]) {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

function withRelativePath(file: File, path: string): File {
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

/** Blendet `webkitdirectory` ein — simuliert einen Desktop-Browser. */
function enableDirectoryPicker() {
  Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
    value: false,
    configurable: true,
    writable: true,
  });
}

function disableDirectoryPicker() {
  delete (HTMLInputElement.prototype as unknown as Record<string, unknown>)
    .webkitdirectory;
}

beforeEach(() => {
  // Nie auflösen: die Job-Liste ist hier nicht der Prüfgegenstand, und ein
  // spät auflösender Poll setzt State außerhalb von act() — reines Rauschen.
  pipes.mockReturnValue(new Promise(() => {}));
  tree.mockResolvedValue([]);
  getImportDefaults.mockResolvedValue({ defaultImportFolder: "30_captures" });
  importFiles.mockResolvedValue({ jobs: [], rejected: [] });
  importUrl.mockResolvedValue({ id: "job-1" });
  disableDirectoryPicker();
});

describe("ImportPanel — Datei-Import", () => {
  it("bietet ohne webkitdirectory keinen Ordner-Knopf, sagt das aber ehrlich", async () => {
    await renderPanel();
    openFilesTab();

    expect(screen.getByRole("button", { name: "Dateien auswählen" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Ordner auswählen" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/kann keine Ordner auswählen/i)).toBeInTheDocument();
  });

  it("zeigt den Ordner-Knopf, wo der Browser Verzeichnisse auswählen kann", async () => {
    enableDirectoryPicker();
    try {
      await renderPanel();
      openFilesTab();

      expect(
        screen.getByRole("button", { name: "Ordner auswählen" }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("lokyy-import-folder-input")).toHaveAttribute(
        "webkitdirectory",
      );
    } finally {
      disableDirectoryPicker();
    }
  });

  it("schickt Datei und relativePath paarweise in gleicher Reihenfolge", async () => {
    await renderPanel();
    await waitFor(() => expect(getImportDefaults).toHaveBeenCalled());
    openFilesTab();

    const a = new File(["a"], "a.md", { type: "text/markdown" });
    const b = withRelativePath(
      new File(["b"], "b.md", { type: "text/markdown" }),
      "notizen/unter/b.md",
    );
    chooseFiles("lokyy-import-file-input", [a, b]);

    fireEvent.click(await screen.findByRole("button", { name: /2 Dateien importieren/ }));

    await waitFor(() => expect(importFiles).toHaveBeenCalledTimes(1));
    const [payload, folder] = importFiles.mock.calls[0]!;
    expect(payload).toEqual([
      { file: a, relativePath: "" },
      { file: b, relativePath: "notizen/unter/b.md" },
    ]);
    expect(folder).toBe("30_captures");
  });

  it("nennt abgewiesene Dateien mit Namen und Grund", async () => {
    importFiles.mockResolvedValue({
      jobs: [],
      rejected: [{ name: "bild.png", reason: "Dateityp nicht unterstützt" }],
    });
    await renderPanel();
    openFilesTab();

    chooseFiles("lokyy-import-file-input", [
      new File(["x"], "bild.png", { type: "image/png" }),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: /1 Datei importieren/ }));

    expect(await screen.findByText("bild.png")).toBeInTheDocument();
    expect(
      await screen.findByText(/Dateityp nicht unterstützt/),
    ).toBeInTheDocument();
  });

  it("meldet einen Fehlschlag lesbar statt als rohen Netzwerkfehler", async () => {
    importFiles.mockRejectedValue(new Error("Failed to fetch"));
    await renderPanel();
    openFilesTab();

    chooseFiles("lokyy-import-file-input", [new File(["x"], "a.md")]);
    fireEvent.click(await screen.findByRole("button", { name: /1 Datei importieren/ }));

    expect(await screen.findByText(/Failed to fetch/)).toBeInTheDocument();
  });
});

describe("ImportPanel — URL-Import bleibt unverändert", () => {
  it("startet den URL-Import mit Ziel-Ordner wie bisher", async () => {
    await renderPanel();
    await waitFor(() => expect(getImportDefaults).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText("https://…"), {
      target: { value: "https://example.com/a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importieren" }));

    await waitFor(() => expect(importUrl).toHaveBeenCalledTimes(1));
    expect(importUrl).toHaveBeenCalledWith({
      url: "https://example.com/a",
      type: undefined,
      targetFolder: "30_captures",
    });
    expect(importFiles).not.toHaveBeenCalled();
  });

  it("hält den Web-Reiter beim Öffnen aktiv", async () => {
    await renderPanel();
    expect(screen.getByRole("tab", { name: /Web/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("ImportPanel — Drag & Drop", () => {
  /** Fake-Entry-Baum: jsdom kennt weder DataTransfer noch webkitGetAsEntry. */
  function fileEntry(name: string) {
    return {
      isFile: true,
      isDirectory: false,
      name,
      file: (cb: (f: File) => void) => cb(new File(["x"], name)),
    };
  }
  function dirEntry(name: string, children: unknown[]) {
    return {
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => {
        let done = false;
        return {
          readEntries: (cb: (e: unknown[]) => void) => {
            cb(done ? [] : children);
            done = true;
          },
        };
      },
    };
  }

  it("nimmt einen gedroppten Ordner an, wechselt auf den Datei-Reiter und behält die Struktur", async () => {
    await renderPanel();
    const panel = document.querySelector("aside")!;

    fireEvent.drop(panel, {
      dataTransfer: {
        items: [
          {
            kind: "file",
            webkitGetAsEntry: () =>
              dirEntry("notizen", [fileEntry("a.md"), fileEntry("b.md")]),
          },
        ],
        files: [],
      },
    });

    expect(
      await screen.findByRole("button", { name: /2 Dateien importieren/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Dateien/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByText("notizen/a.md")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /2 Dateien importieren/ }),
    );
    await waitFor(() => expect(importFiles).toHaveBeenCalledTimes(1));
    expect(
      (importFiles.mock.calls[0]![0] as { relativePath: string }[]).map(
        (e) => e.relativePath,
      ),
    ).toEqual(["notizen/a.md", "notizen/b.md"]);
  });
});

describe("ImportPanel — sehr große Auswahl", () => {
  it("stückelt 60 Dateien in Anfragen und rendert die Liste gekappt", async () => {
    importFiles.mockImplementation(async (files: { file: File }[]) => ({
      jobs: files.map((_, i) => ({ id: `j${i}` })),
      rejected: [],
    }));
    await renderPanel();
    openFilesTab();

    const many = Array.from(
      { length: 60 },
      (_, i) => new File(["x"], `datei-${i}.md`),
    );
    chooseFiles("lokyy-import-file-input", many);

    // Gekappte Liste: nicht 60 Zeilen, sondern 25 plus Zähler.
    expect(await screen.findByText(/und 35 weitere/)).toBeInTheDocument();
    expect(screen.queryByText("datei-59.md")).not.toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: /60 Dateien importieren/ }),
    );

    // 60 Dateien / 20 pro Anfrage = 3 Anfragen, keine Datei verloren.
    await waitFor(() => expect(importFiles).toHaveBeenCalledTimes(3));
    const sent = importFiles.mock.calls.flatMap(
      (c) => c[0] as { file: File }[],
    );
    expect(sent).toHaveLength(60);
    expect(await screen.findByText(/60 von 60 übertragen/)).toBeInTheDocument();
  });
});
