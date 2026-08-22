import { randomUUID } from "node:crypto";
import type {
  PipeJob,
  PipeResult,
  PipeType,
  SharePayload,
} from "@lokyy/shared";
import { save } from "../git/gitService.js";
import { indexWrittenNote } from "../notes/notesService.js";

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

/** Aus dem Share-Payload den Pipe-Typ ableiten. */
export function detectType(payload: SharePayload): PipeType {
  const text = `${payload.url ?? ""} ${payload.text ?? ""}`;
  if (/youtube\.com|youtu\.be/.test(text)) return "youtube";
  if (payload.file?.mime.startsWith("audio/")) return "voice";
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

/** Aktuelle Queue (für GET /api/pipes). */
export function listJobs(): PipeJob[] {
  return jobs.slice().reverse();
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
        const noteId = result.path.replace(/\.md$/, "");
        // Der Commit allein macht eine Notiz noch nicht auffindbar: `save()`
        // schreibt nur ins Git, die Indizes hängen an `saveNote()`/`createNote()`
        // — und da kommt der Pipe-Pfad nie vorbei. Ergebnis vor diesem Aufruf:
        // Pipe-Notizen fehlten dauerhaft im BM25-Index (Tier 2 kaschierte es,
        // weil der Nacht-Backfill dort nachzieht). Nachindizieren, aber den Job
        // nicht daran scheitern lassen — die Notiz IST bereits sicher im Vault.
        try {
          await indexWrittenNote(noteId);
        } catch (err) {
          console.warn(
            `[pipes] Nachindizierung von "${noteId}" fehlgeschlagen: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        job.resultNoteId = noteId;
        job.status = "done";
      } catch (err) {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
      }
    }
  } finally {
    working = false;
  }
}
