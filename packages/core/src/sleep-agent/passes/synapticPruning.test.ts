import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Regressionstest für den `synaptic-pruning`-Pass (Story „Nacht-Protokoll
 * reparieren", AC4).
 *
 * DER BUG: der Pass brach bei JEDEM Lauf schon vor der ersten Kante ab mit
 *
 *   pass-error: The "string" argument must be of type string or an instance
 *   of Buffer or ArrayBuffer. Received an instance of Date
 *
 * Ursache war NICHT der Pass selbst, sondern `coRetrievalPairs()` in
 * `scoring/retrievalLog.ts`: dort ging ein `Date` als Bind-Parameter in ein
 * rohes `db.execute(sql\`…\`)`. Drizzle reicht rohes SQL über
 * `postgres.unsafe(query, params)` durch — auf diesem Weg wird ein `Date`
 * NICHT in einen Zeitstempel-String serialisiert (anders als bei typisierten
 * Spalten wie `edgeWeights.lastUpdated`, wo Drizzle über
 * `mapToDriverValue()` selbst nach ISO wandelt). postgres.js schreibt den
 * Parameter dann roh in den Bind-Frame → `Buffer.byteLength(Date)` → TypeError.
 *
 * WARUM DIESER TEST OHNE DATENBANK AUSKOMMT: er ersetzt die DB durch einen
 * Doppelgänger, der genau diesen Vertrag durchsetzt — jeder Bind-Parameter
 * eines rohen `execute()` muss ein Wert sein, den postgres.js auf dem
 * `unsafe`-Pfad serialisieren kann. Ein `Date` löst denselben TypeError aus
 * wie in Produktion. Vor dem Fix schlägt der Test also fehl, danach ist er
 * grün — und er bleibt grün ohne laufendes Postgres.
 */

/** Node-Wortlaut aus `Buffer.byteLength()` — bewusst identisch zum Original. */
const NODE_TYPE_ERROR =
  'The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Date';

/** Bind-Parameter, die postgres.js auf dem `unsafe`-Pfad roh schreiben kann. */
function assertSerializableParams(params: unknown[]): void {
  for (const p of params) {
    if (p === null || p === undefined) continue;
    if (p instanceof Date) throw new TypeError(NODE_TYPE_ERROR);
    const t = typeof p;
    if (t !== "string" && t !== "number" && t !== "boolean" && t !== "bigint") {
      throw new TypeError(
        `The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received ${t}`,
      );
    }
  }
}

/** Bind-Parameter jedes rohen `execute()` — pro Test frisch. */
let executedParams: unknown[][] = [];

/** Kanten, die `buildGraph()` liefert — pro Test setzbar (siehe #58-Block). */
let graphEdges: Array<{ source: string; target: string }> = [];

/** Schaltet den Kanten-Loop auf Totalausfall der `edge_weights`-Abfrage. */
let selectFails = false;

const DEFAULT_EDGES = [
  { source: "10_projects/lokyy.md", target: "20_topics/ki-agenten.md" },
  { source: "20_topics/ki-agenten.md", target: "30_captures/urls/artikel.md" },
];

const dialect = new PgDialect();

/** Kettbares No-op für die typisierten Drizzle-Aufrufe im Kanten-Loop. */
function chainable<T>(result: T) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "limit", "set", "values", "returning"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (v: T) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

const fakeDb = {
  execute: async (query: unknown) => {
    // Exakt der Weg, den Drizzle produktiv geht: SQL + Parameter bauen und
    // an den Treiber reichen. Nur die Treiber-Serialisierung ist simuliert.
    const built = dialect.sqlToQuery(query as never);
    executedParams.push(built.params);
    assertSerializableParams(built.params);
    return [] as unknown[];
  },
  select: () => {
    if (selectFails) throw new Error("edge_weights unavailable");
    return chainable([] as unknown[]);
  },
  insert: () => chainable(undefined),
  update: () => chainable(undefined),
};

vi.mock("../../db/index.js", () => ({
  database: () => fakeDb,
  indexDatabase: () => fakeDb,
}));

vi.mock("../../graph/graphService.js", () => ({
  buildGraph: async () => ({
    nodes: [
      { id: "10_projects/lokyy.md", label: "lokyy" },
      { id: "20_topics/ki-agenten.md", label: "ki-agenten" },
      { id: "30_captures/urls/artikel.md", label: "artikel" },
    ],
    edges: graphEdges,
  }),
}));

/**
 * Realistische Scoring-Zeilen: so, wie sie aus der DB kommen — inklusive
 * `lastAccessed` als echtes `Date`-Objekt. Genau diese Date-haltigen Daten
 * durchlaufen den Pass.
 */
vi.mock("../../scoring/store.js", () => ({
  getScoring: async (noteId: string) => ({
    noteId,
    importanceScore: 0.72,
    recencyScore: 0.9,
    lastAccessed: new Date("2026-08-05T22:14:00.000Z"),
    incomingBacklinks: 3,
    viewCount: 11,
    editCount: 2,
    coCitationMax: 0.4,
  }),
}));

const { synapticPruningPass } = await import("./synapticPruning.js");
const { coRetrievalPairs } = await import("../../scoring/retrievalLog.js");
const { MAX_ERROR_SAMPLES, errorSamplesTruncated } = await import(
  "../errorSamples.js"
);

import type { SleepRun } from "../types.js";

function makeRun(): SleepRun {
  return {
    id: "01KZBAG4FD0YFQSPCGTW57ZGQV",
    phase: "nrem",
    trigger: "idle",
    status: "running",
    startedAt: new Date("2026-08-06T10:39:26.701Z"),
    passesCompleted: [],
    passStats: {},
    notesProcessed: 0,
  };
}

beforeEach(() => {
  executedParams = [];
  graphEdges = [...DEFAULT_EDGES];
  selectFails = false;
});

describe("synaptic-pruning Pass", () => {
  it("läuft mit Date-haltigen Echtdaten ohne Fehler durch", async () => {
    const result = await synapticPruningPass.run(makeRun());

    // Der Kern der Regression: vor dem Fix war das `errors: 1` mit
    // `notes: "pass-error: The \"string\" argument must be …"`.
    expect(result.notes).not.toMatch(/^pass-error:/);
    expect(result.errors).toBe(0);
    expect(result.processed).toBe(2);
  });

  it("reicht das Zeitfenster als ISO-String statt als Date an rohes SQL", async () => {
    await synapticPruningPass.run(makeRun());

    const timeParams = executedParams
      .flat()
      .filter((p): p is string => typeof p === "string" && p.includes("T"));

    expect(timeParams.length).toBeGreaterThan(0);
    for (const p of timeParams) {
      expect(p).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(executedParams.flat().some((p) => p instanceof Date)).toBe(false);
  });
});

/**
 * Issue #58 — der Deckel, End-to-End durch einen echten Pass.
 *
 * `synaptic-pruning` läuft über JEDE Kante des Graphen und ist damit der Pass,
 * der den Deckel im Betrieb tatsächlich reißt. Der Unit-Test des Protokolls
 * beweist die Mechanik; dieser hier beweist, dass der Pass sie auch benutzt —
 * und dass `errors` dabei die WAHRE Gesamtzahl behält, nicht die der Stichprobe.
 */
describe("synaptic-pruning — errorSamples (#58)", () => {
  it("deckelt die Stichprobe, behält aber die volle Fehlerzahl", async () => {
    graphEdges = Array.from({ length: 25 }, (_, i) => ({
      source: `10_projects/note-${i}.md`,
      target: `20_topics/ziel-${i}.md`,
    }));
    selectFails = true;

    const result = await synapticPruningPass.run(makeRun());

    expect(result.errors).toBe(25);
    expect(result.errorSamples).toHaveLength(MAX_ERROR_SAMPLES);
    expect(errorSamplesTruncated(result)).toBe(true);
  });

  it("nennt in jeder Stichprobe die Notiz und den Grund", async () => {
    selectFails = true;

    const result = await synapticPruningPass.run(makeRun());

    expect(result.errorSamples).toEqual([
      {
        noteId: "10_projects/lokyy.md",
        reason: "edge → 20_topics/ki-agenten.md: edge_weights unavailable",
      },
      {
        noteId: "20_topics/ki-agenten.md",
        reason: "edge → 30_captures/urls/artikel.md: edge_weights unavailable",
      },
    ]);
  });

  it("liefert im Erfolgsfall eine leere Stichprobe", async () => {
    const result = await synapticPruningPass.run(makeRun());

    expect(result.errors).toBe(0);
    expect(result.errorSamples).toEqual([]);
    expect(errorSamplesTruncated(result)).toBe(false);
  });
});

describe("coRetrievalPairs", () => {
  it("bindet den Zeitraum als String — nie als Date-Objekt", async () => {
    await coRetrievalPairs(30);

    expect(executedParams).toHaveLength(1);
    expect(executedParams[0].some((p) => p instanceof Date)).toBe(false);
    expect(
      executedParams[0].filter((p) => typeof p === "string"),
    ).toHaveLength(2);
  });
});
