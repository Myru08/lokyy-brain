import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * DB-gated Tests für den Referenz-Nachzug bei Moves (#57/#59).
 *
 * Folgt der `describe.skipIf`-Konvention des Repos, damit CI ohne Postgres grün
 * bleibt. Wegwerf-Datenbank:
 *
 *   docker run -d --rm --name lokyy-test-pg \
 *     -e POSTGRES_PASSWORD=pw -p 55432:5432 paradedb/paradedb:latest-pg17
 *   LOKYY_TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres \
 *     pnpm --filter @lokyy/core test renameNoteReferences
 *
 * Der interessante Teil sind NICHT die geradeaus-UPDATEs, sondern die vier
 * Tabellen mit note_id im Primärschlüssel: dort ist der Move eine Kollision,
 * sobald am Ziel schon eine Zeile steht — und genau der Zustand lag im
 * Produktivvault vor (alter und neuer Pfad nebeneinander in `entity_mentions`).
 */

const DB_URL = process.env.LOKYY_TEST_DATABASE_URL;

const OLD = "70_pai/topics/auto-projekt-001";
const NEW = "20_notes/topics/projekt-001";
const OTHER = "20_notes/unbeteiligte-notiz";

describe.skipIf(!DB_URL)("renameNoteReferences", () => {
  let db: typeof import("../db/index.js");
  let mod: typeof import("./renameNoteReferences.js");
  let sql: typeof import("drizzle-orm").sql;

  const exec = async (q: ReturnType<typeof sql>) => db.database().execute(q);
  const ids = async (q: ReturnType<typeof sql>): Promise<string[]> =>
    ((await exec(q)) as unknown as { v: string }[]).map((r) => r.v);

  beforeAll(async () => {
    db = await import("../db/index.js");
    mod = await import("./renameNoteReferences.js");
    ({ sql } = await import("drizzle-orm"));
    await db.runMigrations(DB_URL!);
    db.initDb(DB_URL!);
  });

  afterAll(async () => {
    await clean();
    await db.closeDb?.();
  });

  async function clean() {
    for (const t of [
      "note_scoring",
      "peer_profiles",
      "retrieval_traces",
      "entity_mentions",
      "entities",
      "mem0_review_queue",
      "temporal_edges",
      "edge_weights",
      "lint_findings",
    ]) {
      await exec(sql`DELETE FROM ${sql.raw(t)}`);
    }
  }

  beforeEach(clean);

  it("verschiebt eine Zeile mit Surrogat-PK einfach mit (retrieval_traces)", async () => {
    await exec(sql`INSERT INTO retrieval_traces (id, note_id, source)
                   VALUES ('t1', ${OLD}, 'search'), ('t2', ${OTHER}, 'search')`);

    const res = await mod.renameNoteReferences([{ from: OLD, to: NEW }]);

    expect(await ids(sql`SELECT note_id AS v FROM retrieval_traces ORDER BY id`)).toEqual([
      NEW,
      OTHER,
    ]);
    expect(res.renamed).toBeGreaterThan(0);
    expect(res.dropped).toBe(0);
  });

  it("benennt note_scoring um, wenn am Ziel noch nichts steht", async () => {
    await exec(sql`INSERT INTO note_scoring (note_id, view_count) VALUES (${OLD}, 7)`);

    await mod.renameNoteReferences([{ from: OLD, to: NEW }]);

    const rows = (await exec(
      sql`SELECT note_id AS v, view_count FROM note_scoring`,
    )) as unknown as { v: string; view_count: number }[];
    expect(rows).toEqual([{ v: NEW, view_count: 7 }]);
  });

  it("verwirft bei Kollision die ALTE Zeile und behält die am Ziel", async () => {
    // Der Produktivfall: nach dem Move hat ein Nachtlauf die Notiz unter dem
    // neuen Pfad frisch berechnet — die Ziel-Zeile ist die richtige.
    await exec(sql`INSERT INTO note_scoring (note_id, view_count)
                   VALUES (${OLD}, 7), (${NEW}, 99)`);

    const res = await mod.renameNoteReferences([{ from: OLD, to: NEW }]);

    const rows = (await exec(
      sql`SELECT note_id AS v, view_count FROM note_scoring`,
    )) as unknown as { v: string; view_count: number }[];
    expect(rows).toEqual([{ v: NEW, view_count: 99 }]);
    expect(res.dropped).toBe(1);
  });

  it("löst die Kollision in entity_mentions je Entität auf", async () => {
    await exec(sql`INSERT INTO entities (id, canonical_name, display_name, type)
                   VALUES ('e1', 'oli', 'Oli', 'person'), ('e2', 'hermes', 'Hermes', 'tool')`);
    // e1 hat BEIDE Pfade (Kollision), e2 nur den alten (sauberer Rename).
    await exec(sql`INSERT INTO entity_mentions (entity_id, note_id)
                   VALUES ('e1', ${OLD}), ('e1', ${NEW}), ('e2', ${OLD})`);

    await mod.renameNoteReferences([{ from: OLD, to: NEW }]);

    const rows = (await exec(
      sql`SELECT entity_id || ':' || note_id AS v FROM entity_mentions ORDER BY 1`,
    )) as unknown as { v: string }[];
    expect(rows.map((r) => r.v)).toEqual([`e1:${NEW}`, `e2:${NEW}`]);
  });

  it("zieht in edge_weights BEIDE Enden nach", async () => {
    await exec(sql`INSERT INTO edge_weights (from_note_id, to_note_id, weight)
                   VALUES (${OLD}, ${OTHER}, 0.5), (${OTHER}, ${OLD}, 0.25)`);

    await mod.renameNoteReferences([{ from: OLD, to: NEW }]);

    const rows = (await exec(
      sql`SELECT from_note_id || ' -> ' || to_note_id AS v FROM edge_weights ORDER BY 1`,
    )) as unknown as { v: string }[];
    expect(rows.map((r) => r.v).sort()).toEqual(
      [`${NEW} -> ${OTHER}`, `${OTHER} -> ${NEW}`].sort(),
    );
  });

  it("verwirft in edge_weights die Kante, die am Ziel schon existiert", async () => {
    await exec(sql`INSERT INTO edge_weights (from_note_id, to_note_id, weight)
                   VALUES (${OLD}, ${OTHER}, 0.5), (${NEW}, ${OTHER}, 0.9)`);

    const res = await mod.renameNoteReferences([{ from: OLD, to: NEW }]);

    const rows = (await exec(
      sql`SELECT from_note_id AS v, weight FROM edge_weights`,
    )) as unknown as { v: string; weight: number }[];
    expect(rows).toEqual([{ v: NEW, weight: 0.9 }]);
    expect(res.dropped).toBe(1);
  });

  it("fasst in temporal_edges to_note_id NICHT an — das ist roher Wikilink-Text", async () => {
    // `syncWikilinksToTemporalEdges` legt dort den TITEL ab, keine Pfad-ID.
    // Ein Pfad-Rename darf die Spalte deshalb nie treffen; hier steht der
    // alte Pfad absichtlich als Titel-Doppelgänger drin.
    await exec(sql`INSERT INTO temporal_edges
                     (id, from_note_id, to_note_id, edge_kind, t_valid, source_note_id)
                   VALUES ('x1', ${OLD}, ${OLD}, 'wikilink', now(), ${OLD})`);

    await mod.renameNoteReferences([{ from: OLD, to: NEW }]);

    const rows = (await exec(
      sql`SELECT from_note_id AS f, to_note_id AS t, source_note_id AS s FROM temporal_edges`,
    )) as unknown as { f: string; t: string; s: string }[];
    expect(rows).toEqual([{ f: NEW, t: OLD, s: NEW }]);
  });

  it("fasst mem0_review_queue.target_note_id NICHT an — rohe LLM-Ausgabe", async () => {
    await exec(sql`INSERT INTO mem0_review_queue
                     (id, note_id, operation, target_note_id, confidence, reasoning)
                   VALUES ('m1', ${OLD}, 'update', ${OLD}, 'high', 'weil')`);

    await mod.renameNoteReferences([{ from: OLD, to: NEW }]);

    const rows = (await exec(
      sql`SELECT note_id AS n, target_note_id AS t FROM mem0_review_queue`,
    )) as unknown as { n: string; t: string }[];
    expect(rows).toEqual([{ n: NEW, t: OLD }]);
  });

  it("tauscht die ID in lint_findings.note_ids und behält die Reihenfolge", async () => {
    await exec(sql`INSERT INTO lint_findings (id, kind, note_ids, severity, message)
                   VALUES ('l1', 'duplicate', ARRAY[${OTHER}, ${OLD}]::text[], 'warn', 'x')`);

    await mod.renameNoteReferences([{ from: OLD, to: NEW }]);

    const rows = (await exec(
      sql`SELECT note_ids AS v FROM lint_findings`,
    )) as unknown as { v: string[] }[];
    expect(rows[0]!.v).toEqual([OTHER, NEW]);
  });

  it("verarbeitet einen Ordner-Move als eine Charge", async () => {
    // #56: ein Ordner-Move ändert die ID JEDER enthaltenen Notiz. Die Paare
    // reisen als Zuordnungstabelle mit, die Tabelle wird trotzdem nur einmal
    // angefasst.
    await exec(sql`INSERT INTO note_scoring (note_id, view_count)
                   VALUES ('alt/a', 1), ('alt/b', 2), ('alt/tief/c', 3), (${OTHER}, 4)`);

    await mod.renameNoteReferences([
      { from: "alt/a", to: "neu/a" },
      { from: "alt/b", to: "neu/b" },
      { from: "alt/tief/c", to: "neu/tief/c" },
    ]);

    expect(await ids(sql`SELECT note_id AS v FROM note_scoring ORDER BY 1`)).toEqual(
      [OTHER, "neu/a", "neu/b", "neu/tief/c"].sort(),
    );
  });

  it("ist ein No-Op für leere Listen und für from === to", async () => {
    await exec(sql`INSERT INTO note_scoring (note_id, view_count) VALUES (${OLD}, 7)`);

    expect(await mod.renameNoteReferences([])).toEqual({ renamed: 0, dropped: 0 });
    expect(await mod.renameNoteReferences([{ from: OLD, to: OLD }])).toEqual({
      renamed: 0,
      dropped: 0,
    });
    expect(await ids(sql`SELECT note_id AS v FROM note_scoring`)).toEqual([OLD]);
  });
});
