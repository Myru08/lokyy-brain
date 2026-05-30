import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOrder, readSavedOrder, writeSavedOrder } from "./DashboardView.js";

/**
 * Reorder- + Persistenz-Logik des Dashboard-Layouts (Drag-and-Drop-Feature).
 *
 * Reines DnD (DragEvents) wird NICHT E2E getestet — getestet wird die
 * vorwärtskompatible Ordering-Funktion `applyOrder` und der localStorage-
 * Roundtrip, denn das ist die Stelle, an der Persistenz & Layout-Drift bricht.
 */

const STORAGE_KEY = "lokyy:dashboard:order";

describe("applyOrder", () => {
  const DEFAULTS = ["vault", "health", "system", "activity"] as const;

  it("liefert die Default-Reihenfolge, wenn nichts gespeichert ist", () => {
    expect(applyOrder(DEFAULTS, null)).toEqual([
      "vault",
      "health",
      "system",
      "activity",
    ]);
    expect(applyOrder(DEFAULTS, undefined)).toEqual([...DEFAULTS]);
    expect(applyOrder(DEFAULTS, [])).toEqual([...DEFAULTS]);
  });

  it("respektiert eine vollständige gespeicherte Reihenfolge", () => {
    const saved = ["activity", "vault", "system", "health"];
    expect(applyOrder(DEFAULTS, saved)).toEqual(saved);
  });

  it("hängt NEUE Default-Keys hinten an (vorwärtskompatibel)", () => {
    // Gespeichert wurde, bevor "activity" als Kachel existierte.
    const saved = ["health", "vault", "system"];
    expect(applyOrder(DEFAULTS, saved)).toEqual([
      "health",
      "vault",
      "system",
      "activity", // neu → hinten
    ]);
  });

  it("hängt mehrere neue Keys in Default-Reihenfolge an", () => {
    const saved = ["system"];
    expect(applyOrder(DEFAULTS, saved)).toEqual([
      "system",
      "vault",
      "health",
      "activity",
    ]);
  });

  it("entfernt verschwundene (unbekannte) gespeicherte Keys", () => {
    const saved = ["activity", "GHOST", "vault", "health", "system"];
    expect(applyOrder(DEFAULTS, saved)).toEqual([
      "activity",
      "vault",
      "health",
      "system",
    ]);
  });

  it("ignoriert Duplikate in der gespeicherten Reihenfolge", () => {
    const saved = ["vault", "vault", "health", "vault"];
    expect(applyOrder(DEFAULTS, saved)).toEqual([
      "vault",
      "health",
      "system",
      "activity",
    ]);
  });

  it("ist immer eine Permutation der Default-Keys (gleiche Menge)", () => {
    const result = applyOrder(DEFAULTS, ["GHOST", "activity", "vault"]);
    expect([...result].sort()).toEqual([...DEFAULTS].sort());
    expect(result).toHaveLength(DEFAULTS.length);
  });
});

describe("localStorage roundtrip", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("schreibt und liest dieselbe Reihenfolge zurück", () => {
    const order = ["system", "vault", "health"];
    writeSavedOrder(order);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(order));
    expect(readSavedOrder()).toEqual(order);
  });

  it("liefert null, wenn nichts gespeichert ist", () => {
    expect(readSavedOrder()).toBeNull();
  });

  it("liefert null bei kaputtem JSON (kein Crash)", () => {
    localStorage.setItem(STORAGE_KEY, "{ not valid json");
    expect(readSavedOrder()).toBeNull();
  });

  it("liefert null, wenn der gespeicherte Wert kein string[] ist", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: "bar" }));
    expect(readSavedOrder()).toBeNull();
    localStorage.setItem(STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(readSavedOrder()).toBeNull();
  });

  it("roundtrip + applyOrder ergibt zusammen die effektive Reihenfolge", () => {
    const defaults = ["a", "b", "c", "d"];
    writeSavedOrder(["c", "a"]); // Teil-Reihenfolge, b/d sind neu
    const effective = applyOrder(defaults, readSavedOrder());
    expect(effective).toEqual(["c", "a", "b", "d"]);
  });
});
