import { describe, expect, it, vi } from "vitest";

/**
 * Fork-Regressionstest: `search_vault` (fast) läuft über den CombinedProvider.
 * Tier 2 filterte vergessene Notizen, Tier 1 (In-Memory-Index) nicht — so kamen
 * `forgotten:`-Notizen trotzdem in die Treffer.
 */
const notes = new Map<string, string>([
  ["20_notes/aktiv", "---\ntitle: Coolify Update aktiv\n---\n# Coolify Update aktiv\n\nText."],
  [
    "70_pai/server-betrieb/alt",
    "---\ntitle: Coolify Update alt\nforgotten: '2026-09-28T19:40:00Z'\n---\n# Coolify Update alt\n\nText.",
  ],
]);

vi.mock("../notes/notesService.js", () => ({
  listNotes: async () => [...notes.keys()].map((id) => ({ id, title: id })),
  getNote: async (id: string) => {
    const body = notes.get(id);
    return body ? { id, title: id.split("/").pop(), body } : null;
  },
}));

const { Tier1Provider } = await import("./Tier1Provider.js");

describe("Tier1Provider", () => {
  it("lässt vergessene Notizen aus den Treffern", async () => {
    const hits = await new Tier1Provider().search("coolify update");
    expect(hits.map((h) => h.noteId)).toEqual(["20_notes/aktiv"]);
  });
});
