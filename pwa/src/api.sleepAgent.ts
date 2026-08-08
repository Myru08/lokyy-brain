/**
 * HTTP-Zugriff auf das Nacht-Protokoll des Sleep-Agents (Story C1).
 *
 * BEWUSST EIGENE DATEI statt `api.ts`: `api.ts` ist bereits sehr groß und
 * wird von mehreren Strängen parallel bearbeitet — eine eigene Datei hält den
 * Zugriff kollisionsfrei und macht sichtbar, dass hier NUR gelesen wird.
 *
 * Server-Vertrag: `server/src/routes/sleep-agent.ts` → `GET /api/sleep-agent/runs`
 * antwortet mit `{ runs: SleepRun[] }`. Der Server-Typ `SleepRun`
 * (`packages/core/src/sleep-agent/types.ts`) trägt `Date`-Felder; über JSON
 * kommen daraus ISO-Strings an — deshalb ist `SleepRunDto` hier NICHT der
 * Core-Typ, sondern dessen JSON-Projektion. `@lokyy/core` ist node-only und
 * darf nie im Browser-Bundle landen, die Typen werden daher gespiegelt.
 *
 * Alle Felder außer `id` sind optional getypt: die Ansicht darf an einer
 * älteren/neueren Server-Version nicht zerbrechen (siehe
 * `sleepAgentProtocolViewModel.ts`, das jedes Feld defensiv liest).
 */

const BASE = "/api";

/** Schlafphasen des Agents — Spiegel von core `SleepPhase`. */
export type SleepPhase = "nrem" | "rem" | "lint" | "dream" | "manual";

/** Auslöser eines Laufs — Spiegel von core `SleepTrigger`. */
export type SleepTrigger = "idle" | "nightly" | "manual";

/** Lebenszyklus eines Laufs — Spiegel von core `SleepStatus`. */
export type SleepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * JSON-Projektion eines Laufs, so wie er über HTTP ankommt.
 *
 * `passStats` ist absichtlich `Record<string, unknown>`: jeder Arbeitsschritt
 * legt dort seine eigene Ergebnisform ab (`{ processed, errors, notes? }` bzw.
 * `{ error }` bei einem geworfenen Schritt). Die Interpretation passiert
 * ausschließlich in `sleepAgentProtocolViewModel.ts`.
 */
export interface SleepRunDto {
  id: string;
  phase?: SleepPhase | string;
  trigger?: SleepTrigger | string;
  status?: SleepStatus | string;
  /** ISO-8601-Zeitstempel. */
  startedAt?: string | null;
  /** ISO-8601-Zeitstempel; fehlt/`null`, solange der Lauf läuft. */
  finishedAt?: string | null;
  passesCompleted?: string[];
  passStats?: Record<string, unknown>;
  errorMessage?: string | null;
  notesProcessed?: number;
}

/** Antwortform von `GET /api/sleep-agent/runs`. */
export interface SleepRunsResponse {
  runs: SleepRunDto[];
}

/**
 * Fehler mit HTTP-Status. Eigene Klasse (statt der aus `api.ts`), damit diese
 * Datei ohne Import aus dem großen Modul auskommt — `instanceof` wird nirgends
 * über Modulgrenzen hinweg benötigt, die Ansicht zeigt nur `message`.
 */
export class SleepAgentApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "SleepAgentApiError";
  }
}

/**
 * Lädt die letzten Läufe, neueste zuerst (Server sortiert bereits per
 * `startedAt DESC`; die Aufbereitung sortiert defensiv nach).
 *
 * Wirft `SleepAgentApiError` bei HTTP-Fehlern und einen normalen `Error` bei
 * Netzwerkproblemen — beides landet als deutscher Text im Fehlerzustand der
 * Ansicht.
 */
export async function fetchSleepAgentRuns(
  limit = 20,
): Promise<SleepRunDto[]> {
  const res = await fetch(
    `${BASE}/sleep-agent/runs?limit=${encodeURIComponent(String(limit))}`,
    { credentials: "include" },
  );

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new SleepAgentApiError(
      res.status,
      body?.error ?? "Das Nacht-Protokoll konnte nicht geladen werden",
    );
  }

  const body = (await res.json()) as Partial<SleepRunsResponse> | null;
  return Array.isArray(body?.runs) ? body.runs : [];
}
