import { randomUUID } from "node:crypto";
import type {
  PipeJob,
  PipeResult,
  PipeType,
  SharePayload,
} from "@lokyy/shared";
import { save } from "../git/gitService.js";
import { runIngestSynthesis } from "../ingest/synthesis.js";
import { classifyImportFile } from "./importTypes.js";

/**
 * Pipes. Eine schlanke, in-process Job-Queue mit getypten Handlern.
 *
 * Ablauf: Web Share Target -> `enqueue()` -> Typ erkennen -> passender
 * Handler -> Markdown-Notiz -> in den Vault committen.
 *
 * Bewusst minimal (Array + sequentielle Abarbeitung). Bei Bedarf später
 * gegen eine echte Queue (BullMQ o.ä.) tauschbar — die Handler-Signatur
 * bleibt gleich.
 *
 * Handlers themselves live in the server (or future mcp) — they may
 * depend on server-specific config (API keys etc.). Core owns only the
 * generic queue + dispatch.
 */

export type PipeHandler = (payload: SharePayload) => Promise<PipeResult>;

const handlers = new Map<PipeType, PipeHandler>();
const jobs: PipeJob[] = [];
let working = false;

/** Einen Handler für einen Pipe-Typ registrieren (siehe handlers/). */
export function registerHandler(type: PipeType, handler: PipeHandler): void {
  handlers.set(type, handler);
}

/**
 * Aus dem Share-Payload den Pipe-Typ ableiten.
 *
 * Reihenfolge: erst die URL-Signale (YouTube), dann die Datei. Bei der Datei
 * gewinnt Audio (Voice-Pipe), danach entscheidet `classifyImportFile` anhand
 * von **Endung UND MIME** — Browser liefern für `.md` regelmäßig
 * `application/octet-stream`, MIME allein reicht nicht (Issue #63).
 */
export function detectType(payload: SharePayload): PipeType {
  const text = `${payload.url ?? ""} ${payload.text ?? ""}`;
  if (/youtube\.com|youtu\.be/.test(text)) return "youtube";
  if (payload.file) {
    if (payload.file.mime.startsWith("audio/")) return "voice";
    const kind = classifyImportFile(payload.file.name, payload.file.mime);
    if (kind) return kind;
  }
  if (/^https?:\/\//.test(text.trim())) return "url";
  return "unknown";
}

/**
 * Job in die Queue legen und die Abarbeitung anstoßen.
 *
 * `typeOverride` setzt den Pipe-Typ explizit — das nutzt das Import-Panel,
 * wo der Nutzer den Typ bewusst wählt. Ohne Override wird er erkannt
 * (Web Share Target).
 */
export function enqueue(
  payload: SharePayload,
  typeOverride?: PipeType,
): PipeJob {
  const job: PipeJob = {
    id: randomUUID(),
    type: typeOverride ?? detectType(payload),
    status: "queued",
    payload,
    createdAt: new Date().toISOString(),
  };
  jobs.push(job);
  void drain();
  return job;
}

/**
 * Aktuelle Queue (für GET /api/pipes).
 *
 * Die Datei-Bytes (`payload.file.dataBase64`) werden dabei **entfernt**.
 * Grund: `GET /api/pipes` wird von der PWA gepollt — ohne die Redaktion
 * ginge bei einem Ordner-Import mit N Dateien deren kompletter Inhalt bei
 * JEDEM Poll erneut über die Leitung. Name und MIME bleiben stehen, sie sind
 * das, was die Job-Liste anzeigt.
 */
export function listJobs(): PipeJob[] {
  return jobs
    .map((job) => {
      if (!job.payload.file) return job;
      const { dataBase64: _omitted, ...fileMeta } = job.payload.file;
      return {
        ...job,
        payload: { ...job.payload, file: { ...fileMeta, dataBase64: "" } },
      };
    })
    .reverse();
}

/** Sequentiell alle offenen Jobs abarbeiten. */
async function drain(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (const job of jobs) {
      if (job.status !== "queued") continue;
      job.status = "processing";
      try {
        const handler = handlers.get(job.type);
        if (!handler) throw new Error(`Kein Handler für Pipe-Typ "${job.type}"`);
        const result = await handler(job.payload);
        await save(
          result.path,
          result.body,
          `pipe(${job.type}): ${result.path}`,
        );
        job.resultNoteId = result.path.replace(/\.md$/, "");
        // Erfolgreich, aber erklärungsbedürftig — z.B. ein PDF ohne
        // Textebene, das eine leere Notiz erzeugt (Issue #63).
        if (result.notice) job.notice = result.notice;
        const synthesis = await synthesize(job, result.body);
        if (synthesis) {
          job.notice = job.notice ? `${job.notice} | ${synthesis}` : synthesis;
        }
        job.status = "done";
      } catch (err) {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
      } finally {
        // Die Bytes werden nach dem Lauf nie wieder gebraucht, der Job bleibt
        // aber für immer in `jobs` stehen. Ohne dieses Freigeben hielte ein
        // Ordner-Import mit hundert Dateien deren Inhalt bis zum Neustart im
        // Speicher fest.
        if (job.payload.file?.dataBase64) job.payload.file.dataBase64 = "";
      }
    }
  } finally {
    working = false;
  }
}

/**
 * Ingest-Time-Synthese (Issue #67).
 *
 * Läuft NACH dem Handler und NACH `save()`: der Capture-Commit ist zu diesem
 * Zeitpunkt durch, die Notiz liegt im Vault. Genau darum steht die Stufe hier
 * und nicht vor `save()` — so kann sie den Commit weder verzögern noch
 * verhindern, und ihre Vorschläge zeigen auf eine Notiz, die es wirklich gibt.
 *
 * Sie läuft im Import-Pfad, also unter Zeitbudget (siehe `ingest/config.ts`).
 * `runIngestSynthesis` wirft per Vertrag nicht; dieses `try/catch` ist der
 * zweite Gurt: ein Fehler in der Synthese darf den Import NIE fehlschlagen
 * lassen — der Capture ist wichtiger als die Synthese.
 *
 * Rückgabe: eine kurze Zeile für `job.notice`, oder `null`. Verschluckt wird
 * nichts: Abbrüche und Judge-Fehler kommen als `alerts` mit, der vollständige
 * Verlauf steht über `console.warn` im Log.
 */
async function synthesize(
  job: PipeJob,
  body: string,
): Promise<string | null> {
  try {
    const outcome = await runIngestSynthesis({
      jobId: job.id,
      noteId: job.resultNoteId ?? "",
      body,
    });
    const parts: string[] = [];
    if (outcome.proposals.length > 0) {
      parts.push(
        `Synthese: ${outcome.proposals.length} Vorschlag/Vorschläge zur Freigabe`,
      );
    }
    parts.push(...outcome.alerts);
    return parts.length > 0 ? parts.join(" | ") : null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ingest-synthesis] job=${job.id} — Stufe ausgefallen, Import bleibt erfolgreich: ${reason}`,
    );
    return `Synthese ausgefallen: ${reason}`;
  }
}
