import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regressionstest für den `topic-synthesis`-Pass.
 *
 * DER BUG (in Produktion aufgeschlagen, zwei Nächte hintereinander): der Pass
 * kannte nur seinen eigenen Ausgabe-Ordner `70_pai/topics/auto-*`. Was mit
 * einer Zusammenfassung nach dem Accept passiert — sie wandert nach
 * `20_notes/topics/{slug}.md` — war ihm unbekannt. Daraus folgten zwei Fehler,
 * die zusammen einen Klick-Deadlock erzeugt haben:
 *
 *   1. ERNEUTE ERZEUGUNG. Ein Cluster hört nicht auf zu existieren, nur weil
 *      der Nutzer seine Zusammenfassung akzeptiert hat. Der nächste Lauf
 *      schrieb `auto-{slug}.md` erneut. Beim Accept lief dann
 *      `git mv … 20_notes/topics/{slug}.md` gegen eine bereits vorhandene
 *      Datei ("fatal: destination exists") — die Notiz blieb halb akzeptiert
 *      liegen und war über die UI weder annehmbar noch verwerfbar (siehe
 *      `server/src/routes/agent-review.test.ts`).
 *
 *   2. ECHO-SCHLEIFE. Die akzeptierte Notiz verlinkt per Wikilink jede ihrer
 *      Quellen und landet damit selbst in genau der Community, die sie
 *      zusammenfasst. Der Folgelauf las sie als Quelle ein und fasste die
 *      Zusammenfassung zusammen — jede Nacht eine Abschrift weiter von den
 *      Notizen entfernt, im Extremfall mit einem Wikilink auf sich selbst.
 *
 * Der Test kommt ohne Graph, LLM und Vault aus: er ersetzt genau diese drei
 * Nahtstellen und prüft, was der Pass daraus macht.
 */

/** id → Dateiinhalt. Ersetzt den git-gestützten Vault. */
let vault: Map<string, string>;
/** Jeder `createNote`-Aufruf des Passes. */
let created: Array<{ path: string; text: string; opts: Record<string, unknown> }>;
/** Jeder Prompt, den der Pass ans LLM geschickt hat. */
let prompts: string[];
/** community-id → Mitglieder, wie sie die Community-Erkennung liefert. */
let communities: Map<string, string[]>;

const SYNTH_TITLE = "Projekt 001";
const SYNTH_SLUG = "projekt-001";

function topicNote(title: string, communityId: string, origin: string): string {
  return [
    "---",
    "id: 01KZFNDG9B9RGB0798MQPYMY3X",
    "type: intervention",
    `title: ${title}`,
    "intervention_kind: topic_note",
    `origin: ${origin}`,
    `community_id: ${communityId}`,
    "---",
    "",
    `# ${title}`,
    "",
    "Bereits kuratierte Zusammenfassung.",
  ].join("\n");
}

function plainNote(title: string): string {
  return ["---", "type: note", `title: ${title}`, "---", "", `# ${title}`, "", "Inhalt."].join("\n");
}

vi.mock("../../graph/graphService.js", () => ({
  buildGraph: async () => ({
    nodes: [...Array(20).keys()].map((i) => ({ id: `n${i}` })),
    edges: [],
  }),
}));

vi.mock("../../graph/community.js", () => ({
  detectCommunities: () => ({ communities, modularity: 0.42 }),
}));

vi.mock("../../notes/notesService.js", () => ({
  listNotes: async () => [...vault.keys()].map((id) => ({ id, title: id })),
  getNote: async (id: string) => {
    const body = vault.get(id);
    return body ? { id, title: id, body } : null;
  },
  createNote: async (path: string, text: string, opts: Record<string, unknown>) => {
    created.push({ path, text, opts });
    vault.set(path, text);
  },
}));

vi.mock("../../llm/configStore.js", () => ({ getLlmRouting: async () => ({}) }));

vi.mock("../../llm/router.js", () => ({
  LlmRouter: class {
    getProvider() {
      return {
        chat: async (messages: Array<{ content: string }>) => {
          prompts.push(messages.map((m) => m.content).join("\n"));
          return { text: `# ${SYNTH_TITLE}\n\nZusammenfassung des Clusters.` };
        },
      };
    }
  },
}));

const { topicSynthesisPass } = await import("./topicSynthesis.js");

/** Der Pass nimmt `SleepRun` nur entgegen, benutzt ihn aber nicht. */
const RUN = {} as Parameters<typeof topicSynthesisPass.run>[0];

beforeEach(() => {
  vault = new Map([
    ["10_projects/prj-001/projekt", plainNote("Projekt 001")],
    ["40_tasks/aufgabe-a", plainNote("Aufgabe A")],
    ["40_tasks/aufgabe-b", plainNote("Aufgabe B")],
  ]);
  created = [];
  prompts = [];
  communities = new Map([
    ["c1", ["10_projects/prj-001/projekt", "40_tasks/aufgabe-a", "40_tasks/aufgabe-b"]],
  ]);
});

describe("topic-synthesis", () => {
  it("schreibt eine Topic-Note für ein frisches Cluster", async () => {
    const res = await topicSynthesisPass.run(RUN);

    expect(res.processed).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].path).toBe(`70_pai/topics/auto-${SYNTH_SLUG}`);
  });

  it("überspringt ein Cluster, dessen Zusammenfassung schon akzeptiert wurde — ohne LLM-Aufruf", async () => {
    vault.set(`20_notes/topics/${SYNTH_SLUG}`, topicNote(SYNTH_TITLE, "c1", "curated"));

    const res = await topicSynthesisPass.run(RUN);

    expect(created).toHaveLength(0);
    expect(prompts).toHaveLength(0); // der Skip muss VOR dem teuren Aufruf greifen
    expect(res.processed).toBe(0);
    expect(res.errors).toBe(0);
    expect(res.notes).toContain("curated");
  });

  it("überspringt auch bei gedrifteter community-id, wenn der Slug schon belegt ist", async () => {
    // Anderes Cluster (c2), gleicher Titel → gleicher Dateiname. Genau die
    // Datei, auf die das spätere `git mv` laufen würde.
    vault.set(`20_notes/topics/${SYNTH_SLUG}`, topicNote(SYNTH_TITLE, "c-alt", "curated"));

    const res = await topicSynthesisPass.run(RUN);

    expect(prompts).toHaveLength(1); // Titel entsteht erst aus der Antwort …
    expect(created).toHaveLength(0); // … geschrieben wird trotzdem nichts
    expect(res.processed).toBe(0);
  });

  it("füttert die eigene Ausgabe nicht wieder in den Prompt", async () => {
    // Die akzeptierte Notiz liegt im Cluster, weil sie ihre Quellen verlinkt.
    const accepted = "20_notes/topics/alt-thema";
    vault.set(accepted, topicNote("Altes Thema", "c-alt", "curated"));
    communities.set("c1", [...communities.get("c1")!, accepted]);

    const res = await topicSynthesisPass.run(RUN);

    expect(res.processed).toBe(1);
    expect(prompts[0]).not.toContain("Bereits kuratierte Zusammenfassung.");
    expect(prompts[0]).toContain("Aufgabe A");
    // Und sie darf auch nicht als Quelle protokolliert werden.
    expect(created[0].opts.extra).toMatchObject({
      source_notes: [
        "10_projects/prj-001/projekt",
        "40_tasks/aufgabe-a",
        "40_tasks/aufgabe-b",
      ],
    });
  });
});
