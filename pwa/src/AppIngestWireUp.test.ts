import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Drift-Guard für die Verdrahtung der Ingest-Time-Synthese (#67) in `App.tsx`.
 *
 * Warum statisch und nicht als Render-Test: `App.tsx` ist die Wurzel-Komponente
 * mit Auth-Gate, Tenant-Scope, Editor, lazy GraphView und Service-Worker-Hooks.
 * Sie zu rendern wäre ein eigenes Testprojekt und würde nicht das prüfen, was
 * hier kaputtgehen kann. Kaputtgehen kann genau eines: die Komponente ist
 * gebaut und getestet, aber **nirgends gemountet** — dann ist das Feature
 * unerreichbar, und Build wie Typecheck sind trotzdem grün. Genau dieser
 * Zustand lag vor diesem Wire-up vor.
 *
 * Derselbe Gedanke wie beim `DOC_TYPES` ↔ `base.json`-Drift-Guard: die Prüfung
 * kostet nichts und fängt den einen Fehler, den nichts anderes fängt.
 */

// Über cwd, nicht über `import.meta.url`: die Suite läuft in jsdom, dort ist
// `import.meta.url` eine http-URL und `fileURLToPath` wirft. Vitest startet im
// pwa-Workspace, also ist `src/App.tsx` relativ zu cwd stabil.
const APP_TSX = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

describe("App.tsx — Verdrahtung der Ingest-Vorschläge (#67)", () => {
  it("importiert und mountet IngestProposalsPanel", () => {
    expect(APP_TSX).toContain('from "./IngestProposalsPanel.js"');
    expect(APP_TSX).toContain("<IngestProposalsPanel");
  });

  it("steuert das Panel über den proposalsOpen-State", () => {
    expect(APP_TSX).toMatch(/const \[proposalsOpen, setProposalsOpen\]/);
    expect(APP_TSX).toMatch(/open=\{proposalsOpen\}/);
    expect(APP_TSX).toMatch(/onClose=\{\(\) => setProposalsOpen\(false\)\}/);
  });

  it("hat einen Weg ins Panel, der ohne Import auskommt (Toolbar-Knopf)", () => {
    // Vorschläge überleben den Import — die Route ist nicht nach Job gefiltert.
    // Ohne eigenen Knopf wären sie nur direkt nach einem Import erreichbar.
    expect(APP_TSX).toContain("setProposalsOpen(true)");
    expect(APP_TSX).toContain("Vorschläge");
  });

  it("reicht die Brücke aus dem Import-Panel durch", () => {
    expect(APP_TSX).toContain(
      "onOpenProposals={() => setProposalsOpen(true)}",
    );
  });

  it("füttert den Badge über onCountChange", () => {
    expect(APP_TSX).toMatch(/const \[openProposalCount, setOpenProposalCount\]/);
    expect(APP_TSX).toContain("onCountChange={setOpenProposalCount}");
  });
});
