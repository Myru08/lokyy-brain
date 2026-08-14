import { open } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

/**
 * issue #59 (E3 von #55) — Verwaisungs-Abgleich für die abgeleiteten Stores.
 *
 * Alle Tabellen hier sind SIDECARS zum Vault: der Dateibestand ist die
 * Wahrheit, die Zeile ist abgeleitet. Es gibt keine Fremdschlüssel (bewusst —
 * eine tote Index-Zeile darf niemals einen git-Rebase blockieren), also gibt es
 * auch nichts, was eine Zeile beim Löschen der Notiz mitnimmt. Was übrig
 * bleibt, sieht nur jemand, der aktiv nachschaut. Dieses Modul ist das
 * Nachschauen.
 *
 * ZWEI HARTE REGELN, die die Form des Moduls bestimmen:
 *
 *   1. RICHTUNG. Gemeldet wird ausschließlich „Zeile in der Tabelle, aber keine
 *      Datei". Der umgekehrte Fall — Datei ohne Zeile — ist der Normalzustand
 *      direkt nach dem Anlegen einer Notiz und wird hier NIE gemeldet. Dafür
 *      gibt es die Füllstands-Checks (`note_search`, `note_embeddings`).
 *   2. READ-ONLY. Dieses Modul misst. Das Aufräumen ist #57 und ausdrücklich
 *      nicht Teil hiervon. Kein hier erzeugtes Statement schreibt.
 *
 * WARUM ZWEI ID-RÄUME IN DER BEKANNT-LISTE (der nicht offensichtliche Teil):
 * Die Stores sind sich über den ID-Raum NICHT einig, und `note_scoring` ist
 * sogar in sich uneinheitlich:
 *
 *   - `importanceRecompute` (der Haupt-Schreiber, läuft über den ganzen Vault)
 *     schreibt die Frontmatter-ULID
 *     (`packages/core/src/sleep-agent/passes/importanceRecompute.ts:58`).
 *   - `logRetrieval` → `touchView` schreibt in dieselbe Tabelle die Pfad-ID
 *     (`packages/core/src/scoring/retrievalLog.ts:122`, gespeist aus
 *     `server/src/routes/notes.ts:247`).
 *
 * Wer nur gegen die Pfad-IDs prüft, meldet nach dem ersten vollständigen
 * Nachtlauf JEDE `note_scoring`-Zeile als verwaist — ein Instrument, das
 * 100 % Fehlalarm liefert, ist schlimmer als keines. Die Bekannt-Liste enthält
 * deshalb BEIDE Räume, und eine Referenz gilt als bekannt, wenn sie in
 * IRGENDEINEM davon vorkommt. Diese Unschärfe geht ausschließlich in die
 * sichere Richtung: sie kann Verwaisungen übersehen, aber nie eine existierende
 * Notiz fälschlich anklagen.
 */

/** Ein abgeleiteter Store und die Spalten, die eine echte Notiz-Referenz halten. */
export interface DerivedStore {
  /** Tabellenname. Fest verdrahtet — hier kommt nie Nutzereingabe an. */
  table: string;
  /** Was der Store fachlich hält (für die Diagnose-Zeile). */
  label: string;
  /** Skalare Spalten, die gegen den Dateibestand geprüft werden. */
  columns: string[];
  /** `text[]`-Spalte mit Notiz-IDs, falls der Store so gebaut ist. */
  arrayColumn?: string;
  /** Spalten, die bewusst NICHT geprüft werden — mit Begründung. */
  excluded?: { column: string; reason: string }[];
}

/**
 * Die Registry. Jede Zeile ist am Schema nachgeprüft (`packages/core/src/db/
 * schema/`) UND an der Schreibstelle — der Schema-Kommentar allein reicht
 * nicht, zwei davon sind nachweislich veraltet (siehe `retrieval_traces`).
 *
 * Absichtlich NICHT enthalten: `note_search` und `note_embeddings`. Für die
 * gibt es bereits eigene Füllstands-Checks in `diagnostics.ts`; ein zweiter
 * Blickwinkel auf dieselben Tabellen erzeugt widersprüchliche Diagnose-Zeilen.
 */
export const DERIVED_STORES: DerivedStore[] = [
  {
    table: "note_scoring",
    label: "Wichtigkeits-/Recency-Scores",
    // Gemischter ID-Raum (ULID vom Sleep-Pass, Pfad-ID von touchView) — siehe
    // Modul-Kopf. Genau deshalb prüfen wir gegen beide Räume.
    columns: ["note_id"],
  },
  {
    table: "peer_profiles",
    label: "Personenprofile",
    // Pfad-ID: `peers/anna-mueller`, erzeugt in peers/index.ts:322.
    columns: ["note_id"],
  },
  {
    table: "retrieval_traces",
    label: "Retrieval-Log",
    // ACHTUNG: Der Schema-Kommentar behauptet „Frontmatter-ULID". Falsch —
    // beide Schreibstellen (server/src/routes/notes.ts:247 und :172) übergeben
    // die Pfad-ID; notes.ts:242-244 sagt das im Klartext. Am Code geprüft,
    // nicht am Kommentar geglaubt.
    columns: ["note_id"],
  },
  {
    table: "entity_mentions",
    label: "Entitäts-Erwähnungen",
    // Pfad-ID aus `listNotes()` (entityExtraction.ts:255).
    columns: ["note_id"],
  },
  {
    table: "mem0_review_queue",
    label: "mem0-Review-Queue",
    columns: ["note_id"],
    excluded: [
      {
        column: "target_note_id",
        // Rohe LLM-Klassifikator-Ausgabe (mem0Classifier.ts:301), nie gegen den
        // Vault validiert. Ein Wert ohne Datei heißt hier „Modell hat einen
        // Pfad erfunden", nicht „Notiz wurde gelöscht" — anderer Defekt,
        // anderer Fix. Hier gemeldet wäre es ein Dauer-Fehlalarm.
        reason: "rohe LLM-Ausgabe, nie gegen den Vault validiert",
      },
    ],
  },
  {
    table: "temporal_edges",
    label: "Bi-temporale Kanten",
    // Beide echten Notiz-Referenzen. `source_note_id` ist nullable (NULL =
    // systemseitig abgeleitet) — NULL zählt nie als Verwaisung, das erledigt
    // die SQL-Semantik von `<> ALL` von selbst.
    columns: ["from_note_id", "source_note_id"],
    excluded: [
      {
        column: "to_note_id",
        // `syncWikilinksToTemporalEdges` (graph/temporalEdges.ts:264) legt den
        // ROHEN Wikilink-Text ab — `[[Hermes]]` wird zu "Hermes", einem Titel,
        // keiner Pfad-ID. Aufgelöst wird nur im graphService, nicht hier.
        // Gegen den Dateibestand geprüft wäre nahezu jede Titel-Kante ein
        // Treffer: der Check würde ein reales, aber ANDERES Problem
        // (unaufgelöste Kanten-Ziele) als Verwaisung ausgeben und dabei die
        // echten Verwaisungen unter Rauschen begraben.
        reason: "hält rohen Wikilink-Text (Titel), keine Pfad-ID",
      },
    ],
  },
  {
    table: "edge_weights",
    label: "Kantengewichte (Pruning)",
    // Beide Enden sind AUFGELÖSTE Pfad-IDs: graphService emittiert eine Kante
    // erst, wenn das Ziel auflöst (graphService.ts:179-184). Anders als
    // temporal_edges — deshalb hier beide Spalten prüfbar.
    columns: ["from_note_id", "to_note_id"],
  },
  {
    table: "lint_findings",
    label: "Lint-Befunde",
    columns: [],
    // Pfad-IDs aus `note.id` (sleep-agent/passes/lint.ts:102 u. a.).
    arrayColumn: "note_ids",
  },
];

/** Ergebnis je Store. `present:false` = Tabelle existiert noch nicht. */
export interface StoreOrphanResult {
  table: string;
  label: string;
  present: boolean;
  totalRows: number;
  /** Zeilen mit MINDESTENS einer Referenz ohne Datei. */
  orphanRows: number;
  /**
   * Nur beim Array-Store: Zeilen, deren Referenzen ALLE ins Leere zeigen. Nur
   * diese wären in #57 als Ganzes löschbar — bei den übrigen fällt lediglich
   * ein Array-Element weg.
   */
  fullyOrphanRows?: number;
  /** Bis zu fünf unbekannte IDs, damit der Befund nachvollziehbar ist. */
  samples: string[];
}

/**
 * Obergrenze für die Bekannt-Liste. Sie wird als ein `text[]`-Parameter je
 * Abfrage übertragen (zehn Abfragen insgesamt), nicht je Zeile — bei den
 * Vault-Größen dieses Produkts (Hunderte bis wenige Tausend Notizen) sind das
 * einige zehn Kilobyte pro Abfrage über einen lokalen Socket, also irrelevant.
 * Die Grenze verhindert nur den pathologischen Fall, dass eine Diagnose-Anfrage
 * megabyteweise Parameter schiebt.
 *
 * Bewusst gegen eine TEMP-Tabelle entschieden: die wäre bei sehr großen Vaults
 * billiger, bringt aber Session-State in eine kurzlebige Verbindung und macht
 * den Pfad schwerer prüfbar. Solange die Grenze nicht real erreicht wird, ist
 * das der falsche Tausch.
 */
export const MAX_KNOWN_IDS = 50_000;

/** Nur der Frontmatter-Kopf wird gelesen — die `id:`-Zeile steht ganz oben. */
const FRONTMATTER_HEAD_BYTES = 4096;
/** Gleichzeitig offene Datei-Handles beim ULID-Scan. */
const READ_CONCURRENCY = 32;
/** ULID: Crockford-base32, 26 Zeichen, ohne I/L/O/U. */
const ULID_LINE_RE = /^id:\s*["']?([0-9A-HJKMNP-TV-Z]{26})["']?\s*$/m;

/**
 * Frontmatter-ULIDs aller Notizen einsammeln.
 *
 * Warum nicht `getNote()` pro Notiz: `getNote` ruft intern `pull()` — das wäre
 * ein `git pull` PRO NOTIZ. Auf einem Vault mit 500 Notizen macht das aus einer
 * Diagnose-Anfrage 500 git-Operationen. Deshalb hier ein direkter, gedeckelter
 * Lesezugriff auf den Kopf jeder Datei. `listNotes()` (das der Aufrufer bereits
 * gerufen hat) hat den Pull genau einmal erledigt.
 *
 * Fehlerhafte / ULID-lose Notizen werden still übersprungen: eine fehlende ULID
 * macht keine Tabellenzeile verwaist, sie fehlt nur in der Bekannt-Liste — und
 * das geht wieder in die sichere Richtung.
 */
export async function collectVaultUlids(
  pathIds: string[],
  vaultDir: string,
): Promise<Set<string>> {
  const ulids = new Set<string>();

  for (let i = 0; i < pathIds.length; i += READ_CONCURRENCY) {
    const batch = pathIds.slice(i, i + READ_CONCURRENCY);
    await Promise.all(
      batch.map(async (id) => {
        const abs = join(vaultDir, ...id.split("/")) + ".md";
        const head = await readHead(abs).catch(() => null);
        if (!head) return;
        const m = ULID_LINE_RE.exec(head);
        if (m?.[1]) ulids.add(m[1]);
      }),
    );
  }

  return ulids;
}

/** Erste `FRONTMATTER_HEAD_BYTES` einer Datei — nie die ganze Notiz. */
async function readHead(abs: string): Promise<string> {
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(FRONTMATTER_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, FRONTMATTER_HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Für jeden registrierten Store zählen, wie viele Zeilen auf keine Datei mehr
 * zeigen. Eine kurzlebige Einzelverbindung für die ganze Gruppe — dieselbe Form
 * wie `checkPostgres` / `checkEmbeddingIndexFill`.
 *
 * Die Tabellen-/Spaltennamen kommen ausschließlich aus der Registry oben (Code,
 * nie Nutzereingabe); nur die Bekannt-Liste geht als Parameter `$1` in die
 * Abfrage. Deshalb ist `sql.unsafe` hier sicher und nicht bloß bequem.
 */
export async function collectDerivedStoreOrphans(
  databaseUrl: string,
  knownIds: string[],
): Promise<StoreOrphanResult[]> {
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(databaseUrl, { max: 1, idle_timeout: 2 });

    // Ein Rundlauf für alle Tabellen: was existiert vor der Migration noch
    // nicht? `to_regclass` liefert NULL statt eines Fehlers — so wird aus
    // „Tabelle fehlt" ein Ergebnis und nie eine Exception.
    const presenceRows = await sql.unsafe<{ table_name: string; present: boolean }[]>(
      `SELECT t AS table_name, to_regclass('public.' || t) IS NOT NULL AS present
       FROM unnest($1::text[]) AS t`,
      [DERIVED_STORES.map((s) => s.table)],
    );
    const present = new Set(
      presenceRows.filter((r) => r.present).map((r) => r.table_name),
    );

    const results: StoreOrphanResult[] = [];
    for (const store of DERIVED_STORES) {
      if (!present.has(store.table)) {
        results.push({
          table: store.table,
          label: store.label,
          present: false,
          totalRows: 0,
          orphanRows: 0,
          samples: [],
        });
        continue;
      }

      const counts = await sql.unsafe<
        { total_rows: string; orphan_rows: string; fully_orphan_rows: string | null }[]
      >(countQuery(store), [knownIds]);
      const row = counts[0];
      const orphanRows = Number(row?.orphan_rows ?? "0");

      // Beispiele nur holen, wenn es überhaupt etwas zu zeigen gibt.
      const samples =
        orphanRows > 0
          ? (await sql.unsafe<{ v: string }[]>(sampleQuery(store), [knownIds])).map(
              (r) => r.v,
            )
          : [];

      results.push({
        table: store.table,
        label: store.label,
        present: true,
        totalRows: Number(row?.total_rows ?? "0"),
        orphanRows,
        fullyOrphanRows:
          row?.fully_orphan_rows == null ? undefined : Number(row.fully_orphan_rows),
        samples,
      });
    }

    return results;
  } finally {
    if (sql) await sql.end().catch(() => {});
  }
}

/**
 * Zähl-Abfrage je Store.
 *
 * `spalte <> ALL($1)` ist die tragende Konstruktion. Ihre NULL-Semantik ist
 * hier ein Vorteil, kein Stolperstein: für `spalte IS NULL` ergibt sie NULL,
 * die Zeile wird also nicht gezählt. Genau richtig — ein nullbares
 * `source_note_id` bedeutet „systemseitig abgeleitet, keine Quellnotiz", nicht
 * „Quellnotiz verschwunden".
 */
function countQuery(store: DerivedStore): string {
  const t = `"${store.table}"`;

  if (store.arrayColumn) {
    const a = `"${store.arrayColumn}"`;
    return `SELECT
        (SELECT COUNT(*)::text FROM ${t}) AS total_rows,
        (SELECT COUNT(*)::text FROM ${t}
           WHERE EXISTS (SELECT 1 FROM unnest(${a}) AS x
                         WHERE x IS NOT NULL AND x <> ALL($1::text[]))) AS orphan_rows,
        (SELECT COUNT(*)::text FROM ${t}
           WHERE cardinality(${a}) > 0
             AND NOT EXISTS (SELECT 1 FROM unnest(${a}) AS x
                             WHERE x = ANY($1::text[]))) AS fully_orphan_rows`;
  }

  // Eine Zeile ist verwaist, sobald IRGENDEINE ihrer Referenz-Spalten ins Leere
  // zeigt. Bei Kantenpaaren heißt das: from ODER to — eine Kante, deren eines
  // Ende fehlt, ist als Kante bereits kaputt.
  const predicate = store.columns
    .map((c) => `("${c}" IS NOT NULL AND "${c}" <> ALL($1::text[]))`)
    .join(" OR ");

  return `SELECT
      (SELECT COUNT(*)::text FROM ${t}) AS total_rows,
      (SELECT COUNT(*)::text FROM ${t} WHERE ${predicate}) AS orphan_rows,
      NULL AS fully_orphan_rows`;
}

/** Bis zu fünf konkrete unbekannte IDs — macht aus einer Zahl einen Befund. */
function sampleQuery(store: DerivedStore): string {
  const t = `"${store.table}"`;

  if (store.arrayColumn) {
    return `SELECT DISTINCT x AS v
            FROM ${t}, unnest("${store.arrayColumn}") AS x
            WHERE x IS NOT NULL AND x <> ALL($1::text[])
            LIMIT 5`;
  }

  const cols = store.columns.map((c) => `"${c}"`).join(", ");
  return `SELECT DISTINCT v FROM (
            SELECT unnest(ARRAY[${cols}]) AS v FROM ${t}
          ) AS s
          WHERE v IS NOT NULL AND v <> ALL($1::text[])
          LIMIT 5`;
}
