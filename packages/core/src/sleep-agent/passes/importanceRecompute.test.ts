import { beforeEach, describe, expect, it, vi } from "vitest";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Regressionstest für den `importance-recompute`-Pass — Issues #61 und #60.
 *
 * ── #61: ZWEI ID-RÄUME IN EINER TABELLE ─────────────────────────────────
 *
 * DER BUG: Der Pass schrieb `note_scoring`-Zeilen unter der Frontmatter-ULID
 * (`noteId: fmId`), `touchView`/`touchEdit` und `logRetrieval` schreiben
 * dieselbe Tabelle unter der PFAD-ID. `getScoring()` macht ein blankes
 * `eq(noteScoring.noteId, noteId)` — keine Übersetzung zwischen den Räumen.
 *
 * `importanceScore` wird AUSSCHLIESSLICH vom Recompute geschrieben, lag also
 * nur unter ULIDs. Der einzige Leser — `reranker.ts:105-106` — liest mit der
 * Pfad-ID aus den Suchtreffern:
 *
 *   const s = await getScoring(inp.noteId);
 *   importanceMap.set(inp.noteId, s?.importanceScore ?? 0.5);
 *
 * Der Lookup traf nie. Jede Notiz bekam den Default 0.5 — das Importance-
 * Signal war nicht falsch gewichtet, sondern konstant. Der ganze Nachtlauf
 * rechnete Werte aus, die an der einzigen konsumierenden Stelle nie ankamen.
 *
 * DER ENTSCHEIDENDE TEST ist deshalb der erste: ein vom Recompute-Pfad
 * geschriebener Score muss über den LESEWEG DES RERANKERS auffindbar sein.
 * Der Test bildet diese zwei Zeilen wörtlich nach, statt eine Hilfsfunktion
 * zu prüfen — die Kette Schreiber → Speicher → Leser ist der Beweis, alles
 * andere ist Nebenbedingung.
 *
 * ── #60: recomputeAll VERSCHLUCKTE SEINE FEHLER-IDS ─────────────────────
 *
 * Die Per-Notiz-Fehlerbehandlung liegt INNERHALB von `recomputeAll`; sie
 * loggte `[scoring] recomputeOne failed for <id>` und gab nur Zähler zurück.
 * Der Pass sah die IDs nie und war damit als einziger nach #58 ausserstande,
 * `errorSamples` zu liefern. Hier festgenagelt: die IDs kommen an, der Zähler
 * bleibt exakt, und die Deckelung ist die aus `errorSamples.ts` — nicht eine
 * zweite, die davon wegdriften kann.
 *
 * WARUM OHNE DATENBANK: `note_scoring` wird durch eine In-Memory-Tabelle
 * ersetzt, die auf demselben Weg beschrieben und gelesen wird wie in
 * Produktion — die `eq()`-Bedingung wird über `PgDialect` zu echtem SQL
 * gebaut und der Bind-Parameter daraus entnommen. Ein Test, der den Schlüssel
 * selbst aus dem Aufruf herausgreifen würde, könnte den ID-Raum-Fehler nicht
 * sehen; dieser hier sieht genau das, was Postgres sähe.
 */

const dialect = new PgDialect();

/** Eine Zeile der In-Memory-`note_scoring`-Tabelle. */
interface FakeRow {
  noteId: string;
  importanceScore: number;
  recencyScore: number;
  lastAccessed: Date | null;
  incomingBacklinks: number;
  viewCount: number;
  editCount: number;
  coCitationMax: number;
  lastRecomputed: Date;
}

/** Die Tabelle. Primärschlüssel `note_id` — genau wie im Schema. */
let table = new Map<string, FakeRow>();

/** Notiz-IDs, für die der Upsert wirft (simuliert Per-Notiz-DB-Fehler). */
let failUpsertFor = new Set<string>();

/** Spaltendefaults aus `db/schema/noteScoring.ts`. */
function withDefaults(noteId: string, values: Record<string, unknown>): FakeRow {
  return {
    noteId,
    importanceScore: 0,
    recencyScore: 1,
    lastAccessed: null,
    incomingBacklinks: 0,
    viewCount: 0,
    editCount: 0,
    coCitationMax: 0,
    lastRecomputed: new Date(),
    ...(values as Partial<FakeRow>),
  };
}

/**
 * `set`-Werte auflösen. Skalare gehen direkt durch; ein `SQL`-Chunk wird zu
 * echtem SQL gebaut und nur für die zwei Inkrement-Ausdrücke akzeptiert, die
 * der Store tatsächlich benutzt. Alles andere wirft — ein Doppelgänger, der
 * unbekanntes SQL stillschweigend schluckt, wäre schlimmer als keiner.
 */
function resolveSetValue(
  value: unknown,
  current: FakeRow | undefined,
): unknown {
  if (!(value instanceof SQL)) return value;
  const text = dialect.sqlToQuery(value).sql;
  if (/"view_count"\s*\+\s*1/.test(text)) return (current?.viewCount ?? 0) + 1;
  if (/"edit_count"\s*\+\s*1/.test(text)) return (current?.editCount ?? 0) + 1;
  throw new Error(`Fake-DB kennt diesen SQL-Ausdruck nicht: ${text}`);
}

/** Thenable — Drizzle-Ketten werden awaited, nicht `.execute()`-t. */
function thenable<T>(run: () => T) {
  return {
    then(resolve: (v: T) => unknown, reject: (e: unknown) => unknown) {
      try {
        return Promise.resolve(run()).then(resolve, reject);
      } catch (err) {
        return Promise.resolve().then(() => reject(err));
      }
    },
  };
}

const fakeDb = {
  select: () => ({
    from: () => ({
      where: (cond: unknown) => ({
        limit: () =>
          thenable(() => {
            // Der Schlüssel wird aus der GEBAUTEN Bedingung gelesen, nicht aus
            // dem Aufrufargument — so sieht der Test denselben Wert wie die DB.
            const key = dialect.sqlToQuery(cond as never).params[0] as string;
            const row = table.get(key);
            return row ? [row] : [];
          }),
      }),
    }),
  }),
  insert: () => ({
    values: (values: Record<string, unknown>) => ({
      onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) =>
        thenable(() => {
          const noteId = values.noteId as string;
          if (failUpsertFor.has(noteId)) {
            throw new Error(`note_scoring upsert abgelehnt für ${noteId}`);
          }
          const current = table.get(noteId);
          if (!current) {
            table.set(noteId, withDefaults(noteId, values));
            return;
          }
          const next: FakeRow = { ...current };
          for (const [col, raw] of Object.entries(set)) {
            (next as Record<string, unknown>)[col] = resolveSetValue(
              raw,
              current,
            );
          }
          table.set(noteId, next);
        }),
    }),
  }),
  update: () => thenable(() => undefined),
  execute: async () => [] as unknown[],
};

vi.mock("../../db/index.js", () => ({
  database: () => fakeDb,
  indexDatabase: () => fakeDb,
}));

/** Notiz-Fixtures des jeweiligen Tests: Pfad-ID → Dateiinhalt. */
let vault = new Map<string, { updatedAt: string; body: string }>();

/**
 * IDs, die `listNotes()` meldet, für die `getNote()` aber `null` liefert —
 * die Notiz wurde zwischen den beiden Aufrufen gelöscht. Getrennt vom Vault,
 * weil sich dieser Zustand sonst gar nicht herstellen liesse.
 */
let ghosts = new Set<string>();

vi.mock("../../notes/notesService.js", () => ({
  listNotes: async () => [
    ...[...vault.entries()].map(([id, f]) => ({
      id,
      path: `${id}.md`,
      title: id,
      tags: [],
      links: [],
      aliases: [],
      updatedAt: f.updatedAt,
    })),
    ...[...ghosts].map((id) => ({
      id,
      path: `${id}.md`,
      title: id,
      tags: [],
      links: [],
      aliases: [],
      updatedAt: new Date().toISOString(),
    })),
  ],
  getNote: async (id: string) => {
    const f = vault.get(id);
    if (!f) return null;
    return {
      id,
      path: `${id}.md`,
      title: id,
      body: f.body,
      tags: [],
      links: [],
      aliases: [],
      updatedAt: f.updatedAt,
    };
  },
}));

const { importanceRecomputePass } = await import("./importanceRecompute.js");
const { getScoring, touchView } = await import("../../scoring/store.js");
const { MAX_ERROR_SAMPLES, errorSamplesTruncated, isPassScoped } = await import(
  "../errorSamples.js"
);

/** Pfad-ID, wie sie aus `listNotes()` und aus den Suchtreffern kommt. */
const PATH_ID = "50_decisions/2026-05-31-lokyy-brain-os-schichtung";
/** Frontmatter-ULID derselben Notiz — der ALTE Schlüssel. */
const ULID = "01KZBAG4FD0YFQSPCGTW57ZGQV";

/**
 * Frisches `updated` relativ zu `Date.now()`, nicht als fixes Datum: mit
 * einem hartkodierten Datum würde der erwartete Score über die Jahre
 * wegdecayen und die Schwelle unten irgendwann reissen.
 */
function recentIso(): string {
  return new Date(Date.now() - 3_600_000).toISOString();
}

function decisionNote(ulid: string): { updatedAt: string; body: string } {
  const updated = recentIso();
  return {
    updatedAt: updated,
    body: `---
id: ${ulid}
type: decision
title: Lokyy Brain/OS Schichtung
created: 2026-05-31T09:00:00.000Z
updated: ${updated}
---

Brain ist die SSOT, OS die Logik- und Erlebnisschicht.
`,
  };
}

beforeEach(() => {
  table = new Map();
  failUpsertFor = new Set();
  vault = new Map();
  ghosts = new Set();
});

describe("importance-recompute — ID-Raum (#61)", () => {
  it("schreibt Scores unter der Pfad-ID, sodass der Leseweg des Rerankers sie findet", async () => {
    vault.set(PATH_ID, decisionNote(ULID));

    const result = await importanceRecomputePass.run({} as never);
    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);

    // Der Leseweg des Rerankers, wörtlich (llm/reranker.ts:105-106). Die
    // Suchtreffer-ID IST die Pfad-ID (note_embeddings wird so beschrieben).
    const s = await getScoring(PATH_ID);
    const importance = s?.importanceScore ?? 0.5;

    expect(s).not.toBeNull();
    expect(importance).not.toBe(0.5);
    // decision (origin 1.0) + frisch (recency ~1.0) → 0.3 + 0.3 = ~0.6.
    expect(importance).toBeGreaterThan(0.55);
  });

  it("legt nichts mehr unter der Frontmatter-ULID ab", async () => {
    vault.set(PATH_ID, decisionNote(ULID));

    await importanceRecomputePass.run({} as never);

    expect(await getScoring(ULID)).toBeNull();
    expect([...table.keys()]).toEqual([PATH_ID]);
  });

  it("führt Nutzungssignal und Importance in EINER Zeile zusammen", async () => {
    vault.set(PATH_ID, decisionNote(ULID));

    // Erst die Nutzung (Pfad-ID), dann der Nachtlauf — vor dem Fix entstanden
    // hier zwei Zeilen: eine mit viewCount ohne Importance, eine umgekehrt.
    await touchView(PATH_ID);
    await touchView(PATH_ID);
    await importanceRecomputePass.run({} as never);

    expect(table.size).toBe(1);
    const row = await getScoring(PATH_ID);
    expect(row?.viewCount).toBe(2);
    expect(row?.importanceScore).toBeGreaterThan(0.55);
    // Die Nutzung geht jetzt auch WIRKLICH in die Formel ein (0.1 * 2/50).
    expect(row?.lastAccessed).toBeInstanceOf(Date);
  });

  it("bewertet auch Notizen ohne Frontmatter-ULID", async () => {
    vault.set("30_captures/urls/roher-mitschnitt", {
      updatedAt: recentIso(),
      body: "Kein Frontmatter, nur Text.\n",
    });

    const result = await importanceRecomputePass.run({} as never);

    expect(result.processed).toBe(1);
    const row = await getScoring("30_captures/urls/roher-mitschnitt");
    expect(row).not.toBeNull();
    // Ohne `type` fällt der Pass auf "note" zurück (origin 0.8).
    expect(row?.importanceScore).toBeGreaterThan(0);
  });

  it("überspringt Notizen, die zwischen listNotes und getNote verschwinden", async () => {
    vault.set(PATH_ID, decisionNote(ULID));
    ghosts.add("10_projects/geloescht");

    const result = await importanceRecomputePass.run({} as never);

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(await getScoring("10_projects/geloescht")).toBeNull();
  });
});

describe("importance-recompute — Fehler-IDs (#60)", () => {
  it("meldet Notiz-ID und Grund je gescheiterter Notiz", async () => {
    vault.set(PATH_ID, decisionNote(ULID));
    vault.set("10_projects/kaputt", decisionNote("01KZBAG4FD0YFQSPCGTW57ZGR0"));
    failUpsertFor.add("10_projects/kaputt");

    const result = await importanceRecomputePass.run({} as never);

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.errorSamples).toHaveLength(1);
    expect(result.errorSamples[0]?.noteId).toBe("10_projects/kaputt");
    expect(result.errorSamples[0]?.reason).toContain("10_projects/kaputt");
    // Kein Sammel-Platzhalter mehr — die Lücke aus #58 ist zu.
    expect(result.errorSamples.some(isPassScoped)).toBe(false);
  });

  it("deckelt die Stichprobe bei MAX_ERROR_SAMPLES, hält den Zähler exakt", async () => {
    const total = MAX_ERROR_SAMPLES + 5;
    for (let i = 0; i < total; i++) {
      const id = `10_projects/kaputt-${i}`;
      vault.set(id, decisionNote("01KZBAG4FD0YFQSPCGTW57ZGQV"));
      failUpsertFor.add(id);
    }

    const result = await importanceRecomputePass.run({} as never);

    expect(result.processed).toBe(0);
    expect(result.errors).toBe(total);
    expect(result.errorSamples).toHaveLength(MAX_ERROR_SAMPLES);
    expect(errorSamplesTruncated(result)).toBe(true);
  });

  it("liefert bei fehlerfreiem Lauf eine leere Stichprobe", async () => {
    vault.set(PATH_ID, decisionNote(ULID));

    const result = await importanceRecomputePass.run({} as never);

    expect(result.errors).toBe(0);
    expect(result.errorSamples).toEqual([]);
    expect(errorSamplesTruncated(result)).toBe(false);
  });
});
