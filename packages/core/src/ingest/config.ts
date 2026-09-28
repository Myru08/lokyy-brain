/**
 * Issue #67 — Konfiguration der Ingest-Time-Synthese.
 *
 * Diese Stufe läuft IM Import-Pfad, deshalb sind alle drei Werte
 * Sicherheitsgurte und keine Feinjustierung:
 *
 *   - `mode`     — `full` (Vorfilter + Judge), `prefilter` (nur Vorfilter,
 *                  kein einziger LLM-Aufruf) oder `off` (Stufe komplett aus).
 *                  Auf CPU-only-Installationen dauert ein `llama3.1:8b`-Call
 *                  gemessene ~77 s (#54) — dort ist `prefilter` der einzige
 *                  benutzbare Modus, und deshalb MUSS er per Env erreichbar
 *                  sein, ohne die Stufe ganz abzuschalten.
 *   - `budgetMs` — Gesamtbudget der Stufe pro Job. Überschreitung heißt:
 *                  Stufe endet ohne (weitere) Vorschläge, der Import läuft
 *                  normal weiter.
 *   - `maxJudge` — Obergrenze der LLM-Aufrufe pro Job, VOR dem ersten Aufruf
 *                  wirksam. Bremst den Ordner-Import: 100 Dateien × N Calls
 *                  wären sonst eine halbe Stunde Queue.
 *
 * Gelesen wird pro Aufruf (kein Modul-Cache), damit ein Test die Umgebung
 * setzen kann, ohne das Modul neu zu importieren.
 */

export type IngestSynthesisMode = "off" | "prefilter" | "full";

export interface IngestSynthesisConfig {
  mode: IngestSynthesisMode;
  budgetMs: number;
  maxJudge: number;
}

/**
 * Standard-Zeitbudget: 5 s.
 *
 * Begründung: der Nutzer wartet. Ein Cloud-Judge antwortet in ~1–3 s, der
 * Vorfilter selbst kostet Millisekunden plus einen `git pull` aus `listNotes`.
 * 5 s deckt damit genau einen Judge-Lauf sicher ab und bleibt weit unter den
 * ~77 s eines CPU-only-Ollama — die Stufe bricht dort also ab, statt den
 * Import zu blockieren (für CPU-only ist `prefilter` der richtige Modus).
 */
export const DEFAULT_INGEST_BUDGET_MS = 5_000;

/** Standard-Obergrenze der Judge-Aufrufe pro Job. */
export const DEFAULT_INGEST_MAX_JUDGE = 3;

/** Positive Ganzzahl aus Env, sonst Default — ein Tippfehler hebt nie die Grenze auf. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseMode(raw: string | undefined): IngestSynthesisMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return "off";
  if (v === "prefilter") return "prefilter";
  // Leer / unbekannt → an. Ein Tippfehler darf die Stufe nicht still abschalten.
  return "full";
}

export function ingestSynthesisConfig(): IngestSynthesisConfig {
  return {
    mode: parseMode(process.env.LOKYY_INGEST_SYNTHESIS),
    budgetMs: positiveInt(
      process.env.LOKYY_INGEST_SYNTHESIS_BUDGET_MS,
      DEFAULT_INGEST_BUDGET_MS,
    ),
    maxJudge: positiveInt(
      process.env.LOKYY_INGEST_SYNTHESIS_MAX_JUDGE,
      DEFAULT_INGEST_MAX_JUDGE,
    ),
  };
}
