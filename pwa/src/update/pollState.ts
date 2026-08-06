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
import type { SystemVersion, UpdateJob } from "../api.js";

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
 * The one thing we say when the job never reached a terminal state AND the
 * version never changed. It is deliberately an admission, not a verdict: at
 * that point the UI genuinely does not know, and both alternatives — "erfolg-
 * reich" and "fehlgeschlagen" — would be a guess with real consequences.
 * Used by both dead ends, an unreachable brain and a phase that never moved.
 */
export const UNCERTAIN_END_MESSAGE =
  "Wir konnten nicht sicher feststellen, ob das Update durchgelaufen ist. " +
  "Lade die Seite neu und sieh unter Einstellungen → System nach, welche Version läuft.";

/** Shown while a phase overruns its budget. Calm on purpose — nothing failed. */
export const STALL_NOTICE =
  "Dieser Schritt dauert länger als üblich. Lokyy prüft im Hintergrund weiter, " +
  "ob die neue Version schon läuft.";

/** The rescue line landed: the server reports the new version as running. */
export const VERSION_SUCCESS_MESSAGE =
  "Die neue Version läuft bereits — das Update ist durch. Der Fortschritt oben " +
  "ist unterwegs stehen geblieben; entscheidend ist, was tatsächlich läuft.";

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
      error: "Lokyy Brain ist seit mehreren Minuten nicht erreichbar. " + UNCERTAIN_END_MESSAGE,
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

/* ─────────────────────────────────────────────────────────────────────────
 * Stall detection and the version rescue line.
 *
 * Everything above assumes the job report is trustworthy. Observed v1.12.3 →
 * v1.12.4: it is not always. A poll can keep answering 200 with a phase that
 * never advances (a lost updater log line, a job object the sidecar stopped
 * writing to, a UI that stopped asking) while the update itself runs to
 * completion. From inside the phase machine that is indistinguishable from
 * "still working" — so the answer cannot come from the phases. It comes from
 * the one fact nobody can fake: which version the server actually runs.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * How long a phase may sit unchanged before we say so out loud.
 *
 * Not one number: `preflight` is a handful of git commands and has no business
 * taking a minute, while `build` legitimately compiles for ten. A single
 * threshold would either cry wolf during the build or stay silent for the whole
 * five minutes in which the user is actually staring at a dead „Prüfen".
 */
export const PHASE_STALL_MS: Record<UpdateJob["phase"], number> = {
  queued: 45_000,
  preflight: 45_000,
  pull: 60_000,
  build: 600_000,
  switch: 180_000,
  verify: 180_000,
  rollback: 300_000,
  done: 60_000,
};

/** `true` once `phase` has been unchanged for longer than its own budget. */
export function isPhaseStalled(phase: UpdateJob["phase"] | null, msInPhase: number): boolean {
  if (phase === null) return false;
  return msInPhase >= PHASE_STALL_MS[phase];
}

/**
 * `true` once waiting has stopped being reasonable: the phase budget plus one
 * full restart window (`MAX_RESTART_POLLS × pollMs`, the same five minutes we
 * grant an unreachable brain) with neither a terminal job nor a version change.
 * Spinning past this point is not patience, it is a lie about what we know.
 */
export function isPhaseGivenUp(
  phase: UpdateJob["phase"] | null,
  msInPhase: number,
  restartWindowMs: number,
): boolean {
  if (phase === null) return false;
  return msInPhase >= PHASE_STALL_MS[phase] + restartWindowMs;
}

/** What the version rescue line reads from `GET /api/system/version`. */
export type VersionProbe = Pick<SystemVersion, "running" | "latest">;

/** The two versions the probe is judged against, taken once at dialog open. */
export interface VersionBaseline {
  /** What ran before the update — a change away from this proves it landed. */
  running: string | null;
  /** What should run after it. `null` when the check could not say. */
  target: string | null;
}

/** Tolerate `v1.12.4` vs `1.12.4` and stray whitespace; `null` for "unusable". */
function normalizeVersion(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().replace(/^v/i, "");
  return trimmed.length > 0 ? trimmed : null;
}

export function versionBaseline(probe: VersionProbe | null): VersionBaseline {
  return { running: probe?.running ?? null, target: probe?.latest ?? null };
}

/**
 * Does this probe prove the update landed?
 *
 * Two independent proofs, either is enough:
 *
 * 1. The server runs exactly the version we were updating TO. Only counted
 *    when it was not already running it at the start — otherwise "up to date
 *    before, up to date now" would certify a job that never did anything.
 * 2. The running version simply CHANGED. This one needs no `latest` at all,
 *    which matters because the update check is allowed to be unavailable
 *    (`status: "unknown"`), and a restart into a different version is proof
 *    on its own terms.
 *
 * Anything less stays `false`. A wrong "Fertig" here sends someone away from a
 * half-finished update, which is worse than a dialog that admits uncertainty.
 */
export function versionConfirmsUpdate(
  baseline: VersionBaseline | null,
  probe: VersionProbe | null,
): boolean {
  const now = normalizeVersion(probe?.running);
  if (now === null || baseline === null) return false;
  const before = normalizeVersion(baseline.running);
  const target = normalizeVersion(baseline.target);
  if (target !== null && before !== target && now === target) return true;
  return before !== null && now !== before;
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

/**
 * The phases we show as a progress track, in order.
 *
 * `queued` belongs in here even though it is usually invisible. The updater
 * creates the job in `queued` and only reaches `preflight` inside `runUpdate`
 * — synchronously, before its first `await`, which is why the `POST` snapshot
 * normally already says `preflight` (updater/src/index.ts:119-128 starts the
 * run BEFORE taking that snapshot). "Normally" is the problem: leave `queued`
 * out and any job observed in it renders `indexOf(...) === -1`, i.e. a dialog
 * with SIX grey steps, nothing active, nothing pulsing, and no hint that
 * anything is happening — indistinguishable from the frozen view of Issue #36.
 * One `await` moving above that assignment in the updater would be enough to
 * make it the normal case, and the UI would go quiet without a single line of
 * PWA code changing. Listing it costs one row and removes that coupling.
 */
export const PHASE_ORDER: UpdateJob["phase"][] = [
  "queued",
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
