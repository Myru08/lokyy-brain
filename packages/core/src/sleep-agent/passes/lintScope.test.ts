import { describe, it, expect } from "vitest";
import { isLintExempt, dupCheckWindow } from "./lintScope.js";

const WEEK = 7 * 86_400_000;
const notes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `20_notes/n${String(i).padStart(3, "0")}` }));

describe("isLintExempt", () => {
  it("nimmt Vorlagen, Meta und Archiv inkl. Papierkorb aus", () => {
    expect(isLintExempt("00_meta/templates/capture")).toBe(true);
    expect(isLintExempt("00_meta/SPEC")).toBe(true);
    expect(isLintExempt("99_archive/topics/bolt")).toBe(true);
    expect(isLintExempt("99_archive/_trash/2026-08-09-x")).toBe(true);
    expect(isLintExempt("/99_archive/topics/bolt")).toBe(true);
  });

  it("lässt normale Notizen und ähnlich klingende Ordner drin", () => {
    expect(isLintExempt("20_notes/willkommen")).toBe(false);
    expect(isLintExempt("40_daily/2026-08-08")).toBe(false);
    expect(isLintExempt("70_pai/topics/auto-x")).toBe(false);
    expect(isLintExempt("00_metadaten/x")).toBe(false);
    expect(isLintExempt("20_notes/99_archive")).toBe(false);
  });
});

describe("dupCheckWindow", () => {
  it("gibt bei wenigen Notizen alle zurück", () => {
    expect(dupCheckWindow(notes(150), 200, 0)).toHaveLength(150);
  });

  it("liefert immer genau max Notizen ohne Doppelte", () => {
    const w = dupCheckWindow(notes(481), 200, 5 * WEEK);
    expect(w).toHaveLength(200);
    expect(new Set(w.map((x) => x.id)).size).toBe(200);
  });

  it("wandert von Woche zu Woche weiter (alter Fehler: immer dieselben ersten 200)", () => {
    const a = dupCheckWindow(notes(481), 200, 10 * WEEK);
    const b = dupCheckWindow(notes(481), 200, 11 * WEEK);
    expect(a[0]!.id).not.toBe(b[0]!.id);
  });

  it("deckt über genug Wochen jede Notiz ab", () => {
    const all = notes(481);
    const seen = new Set<string>();
    for (let w = 0; w < 5; w++) for (const x of dupCheckWindow(all, 200, w * WEEK)) seen.add(x.id);
    expect(seen.size).toBe(481);
  });

  it("ist innerhalb einer Woche stabil und unabhängig von der Eingabereihenfolge", () => {
    const all = notes(300);
    const r1 = dupCheckWindow(all, 200, 3 * WEEK + 1000);
    const r2 = dupCheckWindow([...all].reverse(), 200, 3 * WEEK + 99_000);
    expect(r1.map((x) => x.id)).toEqual(r2.map((x) => x.id));
  });
});
