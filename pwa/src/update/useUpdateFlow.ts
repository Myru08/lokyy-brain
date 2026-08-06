import { useCallback, useEffect, useState } from "react";
import { UpdateApiError, api, type UpdateCapability, type UpdateJob } from "../api.js";

/**
 * The update flow itself, without any of the places it can be started from.
 *
 * Story 7.12 built this inside `UpdateBanner`. It now lives here because the
 * version card in Einstellungen → System offers the same action, and two copies
 * of "probe the updater, POST, follow the job, treat a 409 as an attach" is
 * exactly the kind of duplication that drifts apart after one bugfix. The
 * banner and the card differ only in what they LOOK like; the state machine is
 * one.
 *
 * `enabled` gates the capability probe, which reaches through to the updater
 * sidecar: it runs when an entry point is actually being offered, never on
 * every page load for every user.
 */

export interface UpdateFlow {
  /** `null` until the probe lands — "we do not know yet", not "cannot". */
  capability: UpdateCapability | null;
  /** Offer the button. */
  canUpdate: boolean;
  /** We KNOW it cannot self-update — a sentence instead of a dead button. */
  cannotUpdate: boolean;
  /** Non-empty only for `reason === "blocked"`: actionable, so shown. */
  blockers: string[];
  /** The job we are following: an id, plus the `POST` snapshot when we have it. */
  job: { id: string; snapshot: UpdateJob | null } | null;
  starting: boolean;
  startError: string | null;
  start: () => Promise<void>;
  closeJob: () => void;
}

export function useUpdateFlow(enabled: boolean): UpdateFlow {
  const [capability, setCapability] = useState<UpdateCapability | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [job, setJob] = useState<{ id: string; snapshot: UpdateJob | null } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api.getUpdateCapability().then((c) => {
      if (cancelled) return;
      setCapability(c);
      // A job is already running — the tab was reloaded mid-update, or the
      // brain restarted under us. Rejoin it instead of offering to start a
      // second one.
      if (c.currentJobId) setJob({ id: c.currentJobId, snapshot: null });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const start = useCallback(async (): Promise<void> => {
    setStarting(true);
    setStartError(null);
    try {
      const started = await api.startUpdate();
      setJob({ id: started.id, snapshot: started });
    } catch (err) {
      // A 409 means exactly one thing — a job is already running — because the
      // server split "blocked" out into a 503. So: attach, never report.
      if (err instanceof UpdateApiError && err.currentJobId) {
        setJob({ id: err.currentJobId, snapshot: null });
        return;
      }
      setStartError(
        err instanceof Error && err.message
          ? err.message
          : "Das Update konnte nicht gestartet werden.",
      );
    } finally {
      setStarting(false);
    }
  }, []);

  const closeJob = useCallback(() => setJob(null), []);

  const canUpdate = capability?.canUpdate === true;

  return {
    capability,
    canUpdate,
    // Only once we actually KNOW. While the answer is in flight there is
    // neither a button nor a claim about how this installation updates —
    // asserting either before we know would be a guess with a short half-life.
    cannotUpdate: capability !== null && !canUpdate,
    blockers: capability?.blockers ?? [],
    job,
    starting,
    startError,
    start,
    closeJob,
  };
}
