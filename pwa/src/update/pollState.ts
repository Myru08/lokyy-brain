/**
 * Story 7.12 Task 5, AC#6 — polling an update job ACROSS a restart.
 *
 * The update replaces the very container that serves `/api/system/update/:id`.
 * So somewhere in the `switch` phase the poll simply fails: connection
 * refused, or a 502 from the nginx in front of a brain that is still booting.
 * Reading that as an error would make every SUCCESSFUL update look like a
 * failure to the user — the single most damaging way this feature can be
 * wrong. The rule is therefore: a failed poll means "restarting", and we keep
 * asking.
 *
 * The state machine lives here as a pure function so the behaviour is testable
 * without timers, jsdom, or a running server.
 */

import { ApiError, UpdateApiError } from "../api.js";
import type { UpdateJob } from "../api.js";

/** What one poll produced. */
export type PollOutcome =
  | { kind: "job"; job: UpdateJob }
  /** Unreachable, 5xx, 404 — anything that a restarting brain can produce. */
  | { kind: "restarting" }
  /** The server answered clearly and negatively (401/403). Retrying is futile. */
  | { kind: "denied"; message: string };

export interface PollState {
  /** Last job we actually saw. Kept across a restart so phases don't blink. */
  job: UpdateJob | null;
  /** `true` while polls are failing — the UI shows "startet neu …", not an error. */
  restarting: boolean;
  /** Consecutive failed polls; resets on every successful one. */
  failures: number;
  /** Set only for genuinely terminal problems. `null` during a restart. */
  error: string | null;
}

export const INITIAL_POLL_STATE: PollState = {
  job: null,
  restarting: false,
  failures: 0,
  error: null,
};

/**
 * How long a restart may take before we stop calling it a restart. At the
 * 2 s poll interval this is five minutes — generous, because the container
 * that comes back has to run database migrations first (Story 1.8).
 */
export const MAX_RESTART_POLLS = 150;

/**
 * Map a thrown error from `api.getUpdateJob` to an outcome.
 *
 * **The server's `retryable` flag wins over the status code.** Two different
 * 503s exist: `updater-unreachable` (the restart window — keep asking) and
 * `update-unavailable` (no updater configured, mode off, blocked — waiting
 * cannot fix that). Branching on the field means the UI never has to reason
 * about which 503 it is holding.
 *
 * Where the server says nothing, the status decides. The reasoning behind
 * `404` is the part worth remembering: **job state lives in the UPDATER**,
 * which deliberately excludes itself from the restart. A job id therefore
 * stays resolvable while the brain goes down and comes back — so a 404 is
 * never a restart artifact, it is a real bug, and swallowing it in the retry
 * loop would hide it behind five minutes of spinning.
 *
 * Terminal: `retryable === false`, 400 (malformed id — our bug), 401/403
 * (auth), 404 (unknown job). Restarting: everything else, including every
 * network-level failure.
 */
export function classifyPollError(err: unknown): PollOutcome {
  // The server told us plainly that waiting will not help.
  if (err instanceof UpdateApiError && err.retryable === false) {
    return {
      kind: "denied",
      message: err.message || "Das Update kann derzeit nicht fortgesetzt werden.",
    };
  }
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      return {
        kind: "denied",
        message:
          "Deine Anmeldung gilt nicht mehr. Bitte melde dich neu an — " +
          "das Update läuft davon unbeeindruckt weiter.",
      };
    }
    if (err.status === 404) {
      return {
        kind: "denied",
        message:
          "Dieser Update-Vorgang ist dem System nicht bekannt. " +
          "Lade die Seite neu; ein laufendes Update wird dadurch nicht abgebrochen.",
      };
    }
    if (err.status === 400) {
      return {
        kind: "denied",
        message:
          "Ungültige Vorgangs-Nummer — das ist ein Fehler in der Oberfläche. " +
          "Lade die Seite neu.",
      };
    }
  }
  return { kind: "restarting" };
}

/** Fold one poll outcome into the state. Pure. */
export function nextPollState(
  prev: PollState,
  outcome: PollOutcome,
  maxRestartPolls: number = MAX_RESTART_POLLS,
): PollState {
  if (outcome.kind === "job") {
    return { job: outcome.job, restarting: false, failures: 0, error: null };
  }
  if (outcome.kind === "denied") {
    return { ...prev, restarting: false, error: outcome.message };
  }

  const failures = prev.failures + 1;
  if (failures > maxRestartPolls) {
    return {
      ...prev,
      restarting: false,
      failures,
      error:
        "Lokyy Brain ist seit mehreren Minuten nicht erreichbar. " +
        "Das Update läuft im Hintergrund weiter — lade die Seite später neu.",
    };
  }
  return { ...prev, restarting: true, failures, error: null };
}

/** `true` once the job reached a terminal state. */
export function isFinished(job: UpdateJob | null): boolean {
  return job !== null && job.result !== undefined;
}

/** `true` when the installation now runs the new version. */
export function isSuccess(job: UpdateJob | null): boolean {
  return job?.result === "success" || job?.result === "already-up-to-date";
}

/** German phase labels — the user sees these, not `switch`/`verify`. */
export const PHASE_LABEL: Record<UpdateJob["phase"], string> = {
  queued: "Vorbereiten",
  preflight: "Prüfen",
  pull: "Neue Version holen",
  build: "Bauen",
  switch: "Neu starten",
  verify: "Prüfen, ob alles läuft",
  rollback: "Zurücksetzen",
  done: "Fertig",
};

/** The phases we show as a progress track, in order. */
export const PHASE_ORDER: UpdateJob["phase"][] = [
  "preflight",
  "pull",
  "build",
  "switch",
  "verify",
  "done",
];

/**
 * Plain-German explanation of a finished job. Every outcome has to say what
 * happened AND what to do — AC#8(c) forbids leaving the user with a status
 * word they cannot act on.
 */
export function resultMessage(job: UpdateJob): { tone: "ok" | "warn" | "err"; text: string } {
  switch (job.result) {
    case "success":
      return {
        tone: "ok",
        text: "Update abgeschlossen. Die Oberfläche lädt gleich in der neuen Version neu.",
      };
    case "already-up-to-date":
      return {
        tone: "ok",
        text: "Es gab nichts zu tun — deine Installation war bereits aktuell.",
      };
    case "build-failed":
      return {
        tone: "warn",
        text:
          "Die neue Version konnte nicht gebaut werden. Deine Installation wurde dabei " +
          "nicht angefasst und läuft unverändert weiter. Versuch es später noch einmal; " +
          "bleibt es dabei, hilft das Protokoll unten weiter.",
      };
    case "rolled-back":
      return {
        tone: "warn",
        text:
          "Die neue Version ist nicht sauber gestartet, deshalb wurde auf den vorherigen " +
          "Stand zurückgesetzt. Deine Notizen und Einstellungen sind unverändert.",
      };
    case "aborted":
      return {
        tone: "warn",
        text:
          job.message ??
          "Das Update wurde nicht gestartet. Es wurde nichts verändert.",
      };
    case "failed":
      return {
        tone: "err",
        text:
          (job.message ?? "Das Update ist fehlgeschlagen.") +
          " Prüfe das Protokoll unten; im Zweifel hilft der manuelle Weg aus dem README.",
      };
    default:
      return { tone: "warn", text: job.message ?? "Unbekanntes Ergebnis." };
  }
}
