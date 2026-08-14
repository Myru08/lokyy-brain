import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * issue #59 (E3 von #55) — generischer Verwaisungs-Check pro abgeleitetem Store.
 *
 * DER BEFUND: Die Diagnose misst heute nur den Füllstand von `note_search` und
 * `note_embeddings`. Für die acht übrigen abgeleiteten Stores gibt es kein
 * Instrument — und was nichts misst, kann nichts melden. Deshalb weiß niemand,
 * wie viele verwaiste Zeilen real existieren.
 *
 * Geprüft wird die Verdikt-Logik, nicht Postgres: `postgres` und `listNotes`
 * sind gemockt, die ULID-Quelle wird injiziert.
 *
 * Die beiden HARTEN Regeln stehen im Mittelpunkt:
 *   1. Richtung — gemeldet wird nur „Zeile ohne Datei", NIE „Datei ohne Zeile".
 *   2. Read-only — kein erzeugtes SQL darf schreiben.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

/** Pro Tabelle: gemocktes Query-Ergebnis, oder `null` für „Tabelle fehlt". */
interface StoreFixture {
  totalRows: number;
  orphanRows: number;
  fullyOrphanRows?: number;
  samples?: string[];
}

/** Tabellen, die laut `to_regclass` existieren. `null` = fehlt (vor Migration). */
let presentTables: Set<string>;
let fixtures: Record<string, StoreFixture>;
let noteIds: string[];
let ulids: string[];
/** Jeder abgesetzte SQL-Text — für die Read-only- und Richtungs-Prüfung. */
let issuedSql: string[];
/** Parameter der zuletzt abgesetzten Zähl-Abfrage. */
let lastParams: unknown[] = [];
/** Simuliert einen kompletten DB-Ausfall. */
let dbDown = false;
const ended: number[] = [];

vi.mock("postgres", () => {
  const factory = () => {
    const client = async () => [];
    client.unsafe = async (text: string, params?: unknown[]) => {
      if (dbDown) throw new Error("connection refused");
      issuedSql.push(text);
      if (params) lastParams = params.flat();

      // Vorab-Prüfung: welche Tabellen existieren überhaupt?
      if (text.includes("to_regclass")) {
        return [...Object.keys(fixtures), ...presentTables].
          filter((t, i, a) => a.indexOf(t) === i).
          map((t) => ({ table_name: t, present: presentTables.has(t) }));
      }

      // Welcher Store ist gemeint? Die Registry-Tabelle steht im Text.
      const table = Object.keys(fixtures).find((t) => text.includes(`"${t}"`));
      if (!table) return [];
      const f = fixtures[table]!;

      if (text.includes("LIMIT")) {
        return (f.samples ?? []).map((v) => ({ v }));
      }
      return [
        {
          total_rows: String(f.totalRows),
          orphan_rows: String(f.orphanRows),
          fully_orphan_rows:
            f.fullyOrphanRows === undefined ? null : String(f.fullyOrphanRows),
        },
      ];
    };
    client.end = async () => {
      ended.push(1);
    };
    return client;
  };
  return { default: factory };
});

vi.mock("@lokyy/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listNotes: async () =>
      noteIds.map((id) => ({ id, title: id, tags: [], updatedAt: new Date().toISOString() })),
  };
});

const { checkDerivedStoreOrphans } = await import("./diagnostics.js");
const { DERIVED_STORES } = await import("../lib/derivedStoreOrphans.js");

/** Alle Registry-Tabellen als „vorhanden & sauber" vorbelegen. */
function allClean(): Record<string, StoreFixture> {
  const out: Record<string, StoreFixture> = {};
  for (const s of DERIVED_STORES) {
    out[s.table] = { totalRows: 10, orphanRows: 0, fullyOrphanRows: 0 };
  }
  return out;
}

beforeEach(() => {
  fixtures = allClean();
  presentTables = new Set(Object.keys(fixtures));
  noteIds = ["10_projects/a", "20_areas/b"];
  ulids = ["01HZZZZZZZZZZZZZZZZZZZZZZZ"];
  issuedSql = [];
  lastParams = [];
  dbDown = false;
  ended.length = 0;
});

/** Der Check mit injizierter ULID-Quelle — kein Dateisystem im Test. */
function run() {
  return checkDerivedStoreOrphans(async () => new Set(ulids));
}

describe("Diagnose: Verwaisungs-Check pro abgeleitetem Store", () => {
  it("meldet pro Store eine Zeile mit verwertbarer Zahl", async () => {
    fixtures["note_scoring"] = {
      totalRows: 40,
      orphanRows: 14,
      samples: ["10_projects/geloescht", "20_areas/weg"],
    };

    const checks = await run();

    // Eine Zeile je registriertem Store.
    expect(checks).toHaveLength(DERIVED_STORES.length);

    const scoring = checks.find((c) => c.name.includes("note_scoring"));
    expect(scoring).toBeDefined();
    expect(scoring!.ok).toBe(false);
    expect(scoring!.severity).toBe("warn");
    // Verwertbar heißt: absolute Zahl UND Bezugsgröße.
    expect(scoring!.detail).toMatch(/14/);
    expect(scoring!.detail).toMatch(/40/);
    // Ein Beispiel macht den Befund nachvollziehbar.
    expect(scoring!.detail).toMatch(/10_projects\/geloescht/);
  });

  it("meldet einen sauberen Store als ok/info", async () => {
    const checks = await run();

    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.every((c) => c.severity === "info")).toBe(true);
  });

  it("macht aus einer fehlenden Tabelle ein sauberes Ergebnis, keinen 500er", async () => {
    presentTables.delete("peer_profiles");

    const checks = await run();

    const peers = checks.find((c) => c.name.includes("peer_profiles"));
    expect(peers).toBeDefined();
    // Vor der Migration ist „nicht da" kein Defekt.
    expect(peers!.ok).toBe(true);
    expect(peers!.severity).toBe("info");
    expect(peers!.detail).toMatch(/Tabelle .*(fehlt|nicht angelegt)/i);
    // Und die anderen Stores werden trotzdem geprüft.
    expect(checks).toHaveLength(DERIVED_STORES.length);
    expect(ended.length).toBe(1);
  });

  it("meldet KEINE Verwaisung für eine Notiz auf Platte ohne Tabellenzeile", async () => {
    // 100 Notizen auf Platte, aber nur eine einzige (bekannte) Zeile im Store.
    noteIds = Array.from({ length: 100 }, (_, i) => `10_projects/n${i}`);
    fixtures["note_scoring"] = { totalRows: 1, orphanRows: 0 };

    const checks = await run();

    const scoring = checks.find((c) => c.name.includes("note_scoring"))!;
    // Die kritische Richtung: 99 Notizen ohne Zeile sind KEINE Verwaisung.
    expect(scoring.ok).toBe(true);
    expect(scoring.severity).toBe("info");
    expect(scoring.detail).not.toMatch(/1\/100/);
  });

  it("erkennt bei Kantenpaaren die Verwaisung an from UND an to", async () => {
    const edges = DERIVED_STORES.find((s) => s.table === "edge_weights")!;
    // Beide Enden gehören zur geprüften Spaltenmenge …
    expect(edges.columns).toEqual(
      expect.arrayContaining(["from_note_id", "to_note_id"]),
    );

    fixtures["edge_weights"] = {
      totalRows: 30,
      orphanRows: 7,
      samples: ["10_projects/quelle-weg", "20_areas/ziel-weg"],
    };

    const checks = await run();
    const edgeCheck = checks.find((c) => c.name.includes("edge_weights"))!;

    expect(edgeCheck.ok).toBe(false);
    expect(edgeCheck.detail).toMatch(/7/);

    // … und das erzeugte SQL prüft beide Enden, nicht nur eines.
    const edgeSql = issuedSql.find(
      (s) => s.includes('"edge_weights"') && !s.includes("LIMIT"),
    )!;
    expect(edgeSql).toMatch(/from_note_id/);
    expect(edgeSql).toMatch(/to_note_id/);
  });

  it("zählt beim Array-Store teilweise und vollständig verwaiste Zeilen getrennt", async () => {
    fixtures["lint_findings"] = {
      totalRows: 20,
      orphanRows: 6, // Zeilen mit mindestens einer unbekannten ID
      fullyOrphanRows: 2, // Zeilen, deren IDs ALLE unbekannt sind
      samples: ["10_projects/weg"],
    };

    const checks = await run();
    const lint = checks.find((c) => c.name.includes("lint_findings"))!;

    expect(lint.ok).toBe(false);
    expect(lint.severity).toBe("warn");
    expect(lint.detail).toMatch(/6/);
    // Die 2 vollständig verwaisten sind separat ausgewiesen — nur sie wären
    // in #57 löschbar; die anderen 4 verlieren nur ein Array-Element.
    expect(lint.detail).toMatch(/2/);
    expect(lint.detail).toMatch(/vollständig/i);
  });

  it("meldet ULID-Zeilen nicht als verwaist (gemischter ID-Raum in note_scoring)", async () => {
    // `note_scoring` wird von ZWEI Pfaden mit verschiedenen ID-Räumen
    // beschrieben: der Sleep-Pass schreibt die Frontmatter-ULID, `touchView`
    // die Pfad-ID. Beide Räume müssen in die Bekannt-Liste.
    ulids = ["01HZZZZZZZZZZZZZZZZZZZZZZZ", "01J0000000000000000000000A"];

    await run();

    const params = paramsOfLastCountQuery();
    for (const u of ulids) expect(params).toContain(u);
    for (const p of noteIds) expect(params).toContain(p);
  });

  it("prüft bei leerem Vault gar nicht erst — sonst wäre jede Zeile verwaist", async () => {
    noteIds = [];
    ulids = [];
    fixtures["note_scoring"] = { totalRows: 5, orphanRows: 5 };

    const checks = await run();

    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.every((c) => c.severity === "info")).toBe(true);
    expect(checks[0]!.detail).toMatch(/kein[e]? Notiz|leerer Vault/i);
  });

  it("prüft die unauflösbaren Spalten bewusst NICHT und sagt das", async () => {
    const temporal = DERIVED_STORES.find((s) => s.table === "temporal_edges")!;
    // `to_note_id` hält den ROHEN Wikilink-Text (Titel, nicht Pfad-ID) —
    // gegen den Dateibestand geprüft wäre fast jede Kante ein Fehlalarm.
    expect(temporal.columns).not.toContain("to_note_id");
    expect(temporal.columns).toEqual(
      expect.arrayContaining(["from_note_id", "source_note_id"]),
    );
    expect(temporal.excluded?.map((e) => e.column)).toContain("to_note_id");

    const mem0 = DERIVED_STORES.find((s) => s.table === "mem0_review_queue")!;
    // `target_note_id` ist rohe LLM-Ausgabe, nie gegen den Vault validiert.
    expect(mem0.columns).not.toContain("target_note_id");
    expect(mem0.excluded?.map((e) => e.column)).toContain("target_note_id");

    const checks = await run();
    const t = checks.find((c) => c.name.includes("temporal_edges"))!;
    expect(t.detail).toMatch(/to_note_id/);
  });

  it("ist read-only: kein erzeugtes SQL schreibt", async () => {
    fixtures["note_scoring"] = { totalRows: 40, orphanRows: 14 };
    await run();

    expect(issuedSql.length).toBeGreaterThan(0);
    for (const text of issuedSql) {
      expect(text).not.toMatch(/\b(DELETE|UPDATE|INSERT|TRUNCATE|DROP|ALTER)\b/i);
    }
  });

  it("überlebt einen DB-Ausfall als einzelne Fehlerzeile statt als 500er", async () => {
    dbDown = true;

    const checks = await run();

    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.detail).toMatch(/connection refused/);
    // Auch im Fehlerfall wird die Verbindung geschlossen.
    expect(ended.length).toBe(1);
  });
});

/** Parameter der letzten Zähl-Abfrage — der Mock reicht sie durch. */
function paramsOfLastCountQuery(): unknown[] {
  return lastParams;
}
