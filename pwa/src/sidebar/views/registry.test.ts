import { describe, expect, it } from "vitest";
import {
  VIEW_REGISTRY,
  resolveView,
  type ViewType,
} from "./registry.js";

/**
 * Story 11.4 AC 6 — `resolveView` mappt korrekt; unbekannt → tree.
 *
 * Pinnt den Vertrag der statischen, geschlossenen Registry: jeder bekannte
 * `ViewType` löst zu seinem eigenen Renderer auf, und ein unbekannter Wert
 * (handgepfuschte Menü-Config) fällt defensiv auf `tree` zurück — nie ein
 * Crash, nie `undefined`.
 */

describe("VIEW_REGISTRY", () => {
  it("hat genau die geschlossene ViewType-Liste als Keys", () => {
    expect(Object.keys(VIEW_REGISTRY).sort()).toEqual(
      ["dashboard", "skills", "sleepProtocol", "tree"].sort(),
    );
  });

  it("jeder Renderer ist eine Komponente (Funktion/Lazy-Objekt)", () => {
    for (const renderer of Object.values(VIEW_REGISTRY)) {
      // React.lazy liefert ein Objekt mit $$typeof; echte FCs sind Funktionen.
      expect(["function", "object"]).toContain(typeof renderer);
      expect(renderer).toBeTruthy();
    }
  });
});

describe("resolveView", () => {
  it("mappt jeden bekannten viewType auf seinen eigenen Renderer", () => {
    const types: ViewType[] = ["tree", "skills", "dashboard", "sleepProtocol"];
    for (const t of types) {
      expect(resolveView(t)).toBe(VIEW_REGISTRY[t]);
    }
  });

  it("fällt bei unbekanntem viewType defensiv auf 'tree' zurück", () => {
    // Bewusster Cast: die Menü-Config kann fremde Strings enthalten.
    const unknown = "totally-unknown" as ViewType;
    expect(resolveView(unknown)).toBe(VIEW_REGISTRY.tree);
  });

  it("liefert nie undefined", () => {
    expect(resolveView("tree")).toBeDefined();
    expect(resolveView(undefined as unknown as ViewType)).toBe(
      VIEW_REGISTRY.tree,
    );
  });
});
