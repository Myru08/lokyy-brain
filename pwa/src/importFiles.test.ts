import { describe, expect, it, vi } from "vitest";
import {
  collectDroppedFiles,
  filesFromFileList,
  planUploadBatches,
  supportsDirectoryPicker,
} from "./ImportPanel.js";

/**
 * Einheiten-Tests der Datei-Sammlung für den Datei-/Ordner-Import
 * (Story „Dateien und Ordner vom Rechner importieren", AC 11–14).
 *
 * Getestet wird die Logik, die die Oberfläche nicht selbst zeigen kann:
 * das rekursive Auslesen gedroppter Ordner (`webkitGetAsEntry`), die
 * Ableitung des `relativePath` laut API-Vertrag und die Aufteilung sehr
 * großer Auswahlen in Anfragen, die der Server noch annimmt.
 */

/* ── Fake-FileSystemEntry-Baum ──────────────────────────────────────────
 * jsdom kennt weder `DataTransfer` noch `webkitGetAsEntry`. Beides wird
 * hier nachgebaut — bewusst mit der Chrome-Eigenheit, dass ein
 * `DirectoryReader` pro `readEntries`-Aufruf nur einen Teil liefert und
 * erst ein leeres Array das Ende markiert. Genau daran scheitern naive
 * Implementierungen.
 * ─────────────────────────────────────────────────────────────────── */

function fileEntry(name: string, content = "inhalt") {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (cb: (f: File) => void) =>
      cb(new File([content], name, { type: "text/markdown" })),
  };
}

function dirEntry(name: string, batches: unknown[][]) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let call = 0;
      return {
        readEntries: (cb: (entries: unknown[]) => void) => {
          const batch = batches[call] ?? [];
          call += 1;
          cb(batch);
        },
      };
    },
  };
}

function dataTransfer(entries: unknown[]) {
  return {
    items: entries.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
    })),
    files: [],
  };
}

describe("supportsDirectoryPicker", () => {
  it("meldet false, wenn der Browser kein webkitdirectory kennt", () => {
    expect(supportsDirectoryPicker()).toBe(false);
  });

  it("meldet true, sobald das Attribut existiert", () => {
    Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
      value: false,
      configurable: true,
      writable: true,
    });
    try {
      expect(supportsDirectoryPicker()).toBe(true);
    } finally {
      delete (HTMLInputElement.prototype as unknown as Record<string, unknown>)
        .webkitdirectory;
    }
  });
});

describe("filesFromFileList", () => {
  it("übernimmt webkitRelativePath, sonst leerer String", () => {
    const plain = new File(["a"], "a.md");
    const inFolder = new File(["b"], "b.md");
    Object.defineProperty(inFolder, "webkitRelativePath", {
      value: "notizen/unter/b.md",
    });

    const out = filesFromFileList([plain, inFolder]);

    expect(out).toHaveLength(2);
    expect(out[0]!.relativePath).toBe("");
    expect(out[1]!.relativePath).toBe("notizen/unter/b.md");
  });

  it("überspringt versteckte Dateien und zählt sie", () => {
    const out = filesFromFileList([
      new File(["a"], "a.md"),
      new File(["x"], ".DS_Store"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.file.name).toBe("a.md");
  });
});

describe("collectDroppedFiles", () => {
  it("liest gedroppte Ordner rekursiv und behält die Struktur", async () => {
    const tree = dirEntry(
      "notizen",
      // Zwei Batches + implizites leeres drittes Array: genau das
      // Chrome-Verhalten, das ein einzelner readEntries-Aufruf verschluckt.
      [[fileEntry("a.md")], [dirEntry("unter", [[fileEntry("b.md")]])]],
    );

    const { files } = await collectDroppedFiles(dataTransfer([tree]) as never);

    expect(files.map((f) => f.relativePath).sort()).toEqual([
      "notizen/a.md",
      "notizen/unter/b.md",
    ]);
  });

  it("gibt einzeln gedroppten Dateien einen leeren relativePath", async () => {
    const { files } = await collectDroppedFiles(
      dataTransfer([fileEntry("c.txt")]) as never,
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.relativePath).toBe("");
    expect(files[0]!.file.name).toBe("c.txt");
  });

  it("überspringt versteckte Einträge und meldet die Anzahl", async () => {
    const tree = dirEntry("notizen", [
      [fileEntry("a.md"), fileEntry(".DS_Store"), dirEntry(".git", [[]])],
    ]);

    const { files, skippedHidden } = await collectDroppedFiles(
      dataTransfer([tree]) as never,
    );

    expect(files.map((f) => f.relativePath)).toEqual(["notizen/a.md"]);
    expect(skippedHidden).toBe(2);
  });

  it("fällt auf dataTransfer.files zurück, wenn webkitGetAsEntry fehlt", async () => {
    const dt = {
      items: [{ kind: "file" }],
      files: [new File(["a"], "a.md")],
    };
    const { files } = await collectDroppedFiles(dt as never);
    expect(files.map((f) => f.file.name)).toEqual(["a.md"]);
  });
});

describe("planUploadBatches", () => {
  const mk = (name: string, size: number) => ({
    file: { name, size } as File,
    relativePath: "",
  });

  it("teilt nach Anzahl", () => {
    const files = Array.from({ length: 5 }, (_, i) => mk(`f${i}.md`, 10));
    const batches = planUploadBatches(files, { maxFiles: 2, maxBytes: 1000 });
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it("teilt nach Bytes", () => {
    const files = [mk("a", 600), mk("b", 600), mk("c", 100)];
    const batches = planUploadBatches(files, { maxFiles: 10, maxBytes: 1000 });
    expect(batches.map((b) => b.length)).toEqual([1, 2]);
  });

  it("schickt eine einzelne zu große Datei allein los, statt sie zu verschlucken", () => {
    const files = [mk("gross", 99_999), mk("klein", 10)];
    const batches = planUploadBatches(files, { maxFiles: 10, maxBytes: 1000 });
    expect(batches).toHaveLength(2);
    expect(batches[0]!.map((f) => f.file.name)).toEqual(["gross"]);
    expect(batches[1]!.map((f) => f.file.name)).toEqual(["klein"]);
  });

  it("verliert bei 500 Dateien keine einzige", () => {
    const files = Array.from({ length: 500 }, (_, i) => mk(`f${i}.md`, 1024));
    const batches = planUploadBatches(files, {
      maxFiles: 20,
      maxBytes: 16 * 1024 * 1024,
    });
    expect(batches.flat()).toHaveLength(500);
    expect(new Set(batches.flat().map((f) => f.file.name)).size).toBe(500);
  });
});

describe("vi sanity", () => {
  it("hat vi zur Verfügung", () => {
    expect(typeof vi.fn).toBe("function");
  });
});
