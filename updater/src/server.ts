/**
 * HTTP surface. Four endpoints, no framework, no dependencies.
 *
 * This service is never published to the host (`docker-compose.local.yml` gives
 * it no `ports:`), so it is reachable only from the compose network, and only
 * with the shared secret the brain holds. Both restrictions matter: whoever can
 * talk to this process can build and restart containers as root.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { UpdaterConfig } from "./config.js";
import { log } from "./log.js";
import type { JobSnapshot, UpdateJob } from "./update.js";

export interface UpdaterState {
  /** Resolved compose identity, or the reason it could not be resolved. */
  identity?: { project: string; service: string; containerId: string; workingDir?: string };
  identityError?: string;
  configProblems: string[];
  currentJob?: UpdateJob;
  jobs: Map<string, UpdateJob>;
  startUpdate(): { ok: true; job: JobSnapshot } | { ok: false; status: number; reason: string };
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

/** Why an update cannot run right now — the brain turns this into UI text. */
export function updateBlockers(state: UpdaterState): string[] {
  const blockers = [...state.configProblems];
  if (!state.identity) {
    blockers.push(
      state.identityError ??
        "the compose project name could not be determined from this container's labels",
    );
  }
  return blockers;
}

export function createUpdaterServer(config: UpdaterConfig, state: UpdaterState) {
  const authorized = (req: IncomingMessage): boolean => {
    if (!config.token) return false;
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return false;
    return tokenMatches(match[1]!.trim(), config.token);
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://updater.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Liveness only — no auth, no detail. The compose healthcheck uses this.
    if (req.method === "GET" && (path === "/health" || path === "/")) {
      json(res, 200, { ok: true, service: "lokyy-updater" });
      return;
    }

    if (!authorized(req)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && path === "/status") {
      const blockers = updateBlockers(state);
      json(res, 200, {
        ok: true,
        canUpdate: blockers.length === 0,
        blockers,
        project: state.identity?.project,
        service: state.identity?.service,
        workingDir: state.identity?.workingDir,
        repoDir: config.repoDir,
        composeFiles: config.composeFiles,
        currentJobId: state.currentJob && state.currentJob.finishedAt === undefined ? state.currentJob.id : undefined,
      });
      return;
    }

    if (req.method === "POST" && path === "/update") {
      const started = state.startUpdate();
      if (!started.ok) {
        json(res, started.status, { error: started.reason });
        return;
      }
      json(res, 202, started.job);
      return;
    }

    const jobMatch = /^\/update\/([A-Za-z0-9_-]+)$/.exec(path);
    if (req.method === "GET" && jobMatch) {
      const job = state.jobs.get(jobMatch[1]!);
      if (!job) {
        json(res, 404, { error: "unknown job" });
        return;
      }
      json(res, 200, job.snapshot());
      return;
    }

    json(res, 404, { error: "not found" });
  });
}

export function listen(config: UpdaterConfig, state: UpdaterState): void {
  const server = createUpdaterServer(config, state);
  server.listen(config.port, "0.0.0.0", () => {
    log("info", `listening on :${config.port}`, {
      project: state.identity?.project ?? null,
      canUpdate: updateBlockers(state).length === 0,
    });
  });
}
