import { sql } from "drizzle-orm";

import { database } from "../db/index.js";

/**
 * Ursachen-Hälfte zu #57/#59 — Notiz-Referenzen einem Move MITNEHMEN.
 *
 * Ausgangslage: die `note_id` IST der Pfad ohne ".md". Ein Move ändert damit
 * die Identität der Notiz in JEDEM abgeleiteten Store. `moveEntry` pflegte
 * bisher nur den ULID-Cache und die beiden Suchtiers nach (#51); die acht
 * Sidecar-Tabellen behielten den ALTEN Pfad. Auf einem Produktivvault waren
 * das nach ein paar Wochen 276 verwaiste Zeilen über fünf Tabellen — alle aus
 * Moves, keine einzige aus einer echten Löschung. Ein reiner Aufräumlauf (#57)
 * hätte sie entfernt und der nächste Move hätte sie neu erzeugt.
 *
 * ── Verhältnis zu `server/src/lib/derivedStoreOrphans.ts` ───────────────────
 * Das dort ist die MESSUNG (read-only, meldet „Zeile ohne Datei"), das hier
 * ist die PFLEGE. Beide brauchen dieselbe Antwort auf die Frage „welche Spalte
 * hält eine kanonische Pfad-ID?", und beide müssen dieselben zwei Spalten
 * AUSLASSEN — aus demselben Grund:
 *
 *   - `temporal_edges.to_note_id` hält den rohen Wikilink-Text (einen TITEL,
 *     keine Pfad-ID). Ein Pfad-Rename darf da nicht zuschlagen.
 *   - `mem0_review_queue.target_note_id` ist rohe LLM-Ausgabe, nie gegen den
 *     Vault validiert. Ein Treffer heißt „Modell hat einen Pfad erfunden",
 *     nicht „Notiz verschoben".
 *
 * Wer eine Spalte hinzufügt, muss BEIDE Stellen anfassen —
 * `server/src/lib/derivedStoreRefs.consistency.test.ts` hält die Listen
 * deckungsgleich und schlägt sonst fehl.
 *
 * ── Was mit Kollisionen passiert ────────────────────────────────────────────
 * Vier der Tabellen haben die note_id im Primärschlüssel. Existiert am ZIEL
 * schon eine Zeile (typisch, wenn nach dem Move ein Nachtlauf die Notiz unter
 * dem neuen Pfad frisch abgeleitet hat), gewinnt die Ziel-Zeile: sie ist die
 * jüngere und wurde gegen die tatsächliche Datei berechnet. Die Quell-Zeile
 * wird dann verworfen statt umgeschrieben — genau das Ergebnis, das der
 * Aufräumlauf ohnehin herstellen würde.
 *
 * ── Was hier NICHT passiert ─────────────────────────────────────────────────
 * Der LÖSCH-Pfad (`deleteEntry`) räumt weiterhin nur die Suchtiers ab. Ob eine
 * gelöschte Notiz ihr `retrieval_traces`-Protokoll mitnehmen soll, ist eine
 * Produktentscheidung, keine Fehlerbehebung — bewusst offen gelassen.
 */

/** Ein Move: alter Pfad ohne ".md" -> neuer Pfad ohne ".md". */
export interface NoteIdRename {
  from: string;
  to: string;
}

/** Wie viele Zeilen je Tabelle umgeschrieben (`renamed`) bzw. als veraltete
 *  Dublette verworfen (`dropped`) wurden. Nur für Logging/Tests. */
export interface RenameNoteReferencesResult {
  renamed: number;
  dropped: number;
}

/**
 * Alle Referenzen der übergebenen Moves nachziehen.
 *
 * Nimmt eine LISTE, nicht ein einzelnes Paar: ein Ordner-Move ändert die ID
 * jeder enthaltenen Notiz (#56), und die soll nicht N × 8 Statements kosten.
 * Jede Tabelle wird genau einmal angefasst, die Zuordnung kommt als
 * `unnest()`-Paartabelle mit.
 *
 * Wirft nicht auf leerer Liste; ansonsten schon — der Aufrufer entscheidet,
 * wie laut ein Fehler ist (`moveEntry` loggt und macht weiter: der Git-Commit
 * ist die Wahrheit, das hier ist abgeleitet).
 */
export async function renameNoteReferences(
  renames: NoteIdRename[],
): Promise<RenameNoteReferencesResult> {
  const pairs = renames.filter((r) => r.from && r.to && r.from !== r.to);
  if (pairs.length === 0) return { renamed: 0, dropped: 0 };

  const froms = pairs.map((p) => p.from);
  const tos = pairs.map((p) => p.to);
  const db = database();

  let renamed = 0;
  let dropped = 0;
  const count = (res: unknown): number =>
    typeof (res as { count?: number })?.count === "number"
      ? (res as { count: number }).count
      : 0;

  // Die Paartabelle als wiederverwendbares SQL-Fragment.
  //
  // `sql.param()` ist hier PFLICHT, nicht Geschmack: interpoliert man ein
  // JS-Array direkt, expandiert Drizzle es zu einer Parameter-LISTE
  // (`unnest($1, $2, $3)`) statt zu EINEM Array-Parameter — bei einem Paar
  // gibt das „malformed array literal", bei mehreren „cannot cast type record
  // to text[]". `sql.param()` bindet den Wert als einen Parameter, den
  // postgres.js als echtes text[] serialisiert. Der `::text[]`-Cast bleibt,
  // damit Postgres den Typ auch ohne Kontext kennt.
  const map = sql`SELECT * FROM unnest(${sql.param(froms)}::text[], ${sql.param(tos)}::text[]) AS m(from_id, to_id)`;

  // ── Tabellen mit note_id IM Primärschlüssel: erst Dubletten weg ──────────
  // note_scoring: PK(note_id)
  dropped += count(
    await db.execute(sql`
      WITH m AS (${map})
      DELETE FROM note_scoring s USING m
       WHERE s.note_id = m.from_id
         AND EXISTS (SELECT 1 FROM note_scoring t WHERE t.note_id = m.to_id)`),
  );
  renamed += count(
    await db.execute(sql`
      WITH m AS (${map})
      UPDATE note_scoring s SET note_id = m.to_id FROM m WHERE s.note_id = m.from_id`),
  );

  // peer_profiles: PK(note_id)
  dropped += count(
    await db.execute(sql`
      WITH m AS (${map})
      DELETE FROM peer_profiles s USING m
       WHERE s.note_id = m.from_id
         AND EXISTS (SELECT 1 FROM peer_profiles t WHERE t.note_id = m.to_id)`),
  );
  renamed += count(
    await db.execute(sql`
      WITH m AS (${map})
      UPDATE peer_profiles s SET note_id = m.to_id FROM m WHERE s.note_id = m.from_id`),
  );

  // entity_mentions: PK(entity_id, note_id) — Kollision nur INNERHALB derselben Entität.
  dropped += count(
    await db.execute(sql`
      WITH m AS (${map})
      DELETE FROM entity_mentions s USING m
       WHERE s.note_id = m.from_id
         AND EXISTS (
           SELECT 1 FROM entity_mentions t
            WHERE t.entity_id = s.entity_id AND t.note_id = m.to_id)`),
  );
  renamed += count(
    await db.execute(sql`
      WITH m AS (${map})
      UPDATE entity_mentions s SET note_id = m.to_id FROM m WHERE s.note_id = m.from_id`),
  );

  // edge_weights: PK(from_note_id, to_note_id) — beide Enden sind aufgelöste
  // Pfad-IDs (graphService emittiert eine Kante erst, wenn das Ziel auflöst),
  // also werden beide Seiten nachgezogen. Nacheinander, je mit eigener
  // Kollisionsprüfung gegen das jeweils ANDERE, unveränderte Ende.
  dropped += count(
    await db.execute(sql`
      WITH m AS (${map})
      DELETE FROM edge_weights s USING m
       WHERE s.from_note_id = m.from_id
         AND EXISTS (
           SELECT 1 FROM edge_weights t
            WHERE t.from_note_id = m.to_id AND t.to_note_id = s.to_note_id)`),
  );
  renamed += count(
    await db.execute(sql`
      WITH m AS (${map})
      UPDATE edge_weights s SET from_note_id = m.to_id FROM m WHERE s.from_note_id = m.from_id`),
  );
  dropped += count(
    await db.execute(sql`
      WITH m AS (${map})
      DELETE FROM edge_weights s USING m
       WHERE s.to_note_id = m.from_id
         AND EXISTS (
           SELECT 1 FROM edge_weights t
            WHERE t.from_note_id = s.from_note_id AND t.to_note_id = m.to_id)`),
  );
  renamed += count(
    await db.execute(sql`
      WITH m AS (${map})
      UPDATE edge_weights s SET to_note_id = m.to_id FROM m WHERE s.to_note_id = m.from_id`),
  );

  // ── Tabellen mit Surrogat-PK: kein Kollisionsrisiko, reines UPDATE ───────
  // retrieval_traces: PK(id)
  renamed += count(
    await db.execute(sql`
      WITH m AS (${map})
      UPDATE retrieval_traces s SET note_id = m.to_id FROM m WHERE s.note_id = m.from_id`),
  );

  // mem0_review_queue: PK(id). NUR note_id — target_note_id ist rohe
  // LLM-Ausgabe (siehe Modulkopf).
  renamed += count(
    await db.execute(sql`
      WITH m AS (${map})
      UPDATE mem0_review_queue s SET note_id = m.to_id FROM m WHERE s.note_id = m.from_id`),
  );

  // temporal_edges: PK(id). from_note_id + source_note_id sind Pfad-IDs,
  // to_note_id ist roher Wikilink-Text (siehe Modulkopf).
  renamed += count(
    await db.execute(sql`
      WITH m AS (${map})
      UPDATE temporal_edges s SET from_note_id = m.to_id FROM m WHERE s.from_note_id = m.from_id`),
  );
  renamed += count(
    await db.execute(sql`
      WITH m AS (${map})
      UPDATE temporal_edges s SET source_note_id = m.to_id FROM m WHERE s.source_note_id = m.from_id`),
  );

  // lint_findings: PK(id), Referenzen liegen als text[] in note_ids.
  // `array_replace` trifft jedes Vorkommen und lässt die Reihenfolge stehen —
  // die zählt, weil der Dedupe-Guard des Lint-Passes über die ID-Menge geht.
  renamed += count(
    await db.execute(sql`
      WITH m AS (${map})
      UPDATE lint_findings s SET note_ids = array_replace(s.note_ids, m.from_id, m.to_id)
        FROM m WHERE m.from_id = ANY(s.note_ids)`),
  );

  return { renamed, dropped };
}

/**
 * Die Spalten, die {@link renameNoteReferences} anfasst — als Datenstruktur,
 * damit der Test sie gegen die Registry in `derivedStoreOrphans.ts` halten
 * kann, statt dass zwei Listen still auseinanderlaufen.
 */
export const RENAMED_NOTE_REF_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  note_scoring: ["note_id"],
  peer_profiles: ["note_id"],
  retrieval_traces: ["note_id"],
  entity_mentions: ["note_id"],
  mem0_review_queue: ["note_id"],
  temporal_edges: ["from_note_id", "source_note_id"],
  edge_weights: ["from_note_id", "to_note_id"],
  lint_findings: ["note_ids"],
};
