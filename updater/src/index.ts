/**
 * lokyy-updater entrypoint.
 *
 * Startup order matters: the compose project name is resolved **once**, before
 * the HTTP server accepts anything. If that fails the process still starts and
 * still answers — but it answers `canUpdate: false` with the reason, so the
 * brain can show the user a sentence instead of a dead button. What it will
 * never do is fall back to a guessed project name.
 */

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { configProblems, loadConfig } from "./config.js";
import { createDockerRunner, createGitRunner, repoOwner, run } from "./exec.js";
import { log } from "./log.js";
import { inspectContainerArgs } from "./plan.js";
import { resolveSelfIdentity, type DockerInspectResult, type SelfIdentity } from "./project.js";
import { listen, updateBlockers, type UpdaterState } from "./server.js";
import { UpdateJob, runUpdate, type UpdateDeps } from "./update.js";

const config = loadConfig();

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Identity resolution runs against the raw `docker` binary rather than the
 * guarded runner — the guard needs a project name, which is exactly what we do
 * not have yet. It is confined to `docker inspect`, which cannot change
 * anything.
 */
async function inspectContainer(id: string): Promise<DockerInspectResult | null> {
  const res = await run("docker", inspectContainerArgs(id), { timeoutMs: 15_000 });
  if (res.code !== 0) return null;
  try {
    return JSON.parse(res.stdout.trim()) as DockerInspectResult;
  } catch {
    return null;
  }
}

async function probeHealth(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  let identity: SelfIdentity | undefined;
  let identityError: string | undefined;

  try {
    identity = await resolveSelfIdentity(
      {
        inspectContainer,
        hostname,
        readMountInfo: () => readOrEmpty("/proc/self/mountinfo"),
        readCgroup: () => readOrEmpty("/proc/self/cgroup"),
      },
      // The host repo bind is one of the four facts that identify this
      // container, so it has to follow wherever the repo is actually mounted.
      { repoMountTarget: config.repoDir },
    );
    log("info", "resolved own compose identity", {
      project: identity.project,
      service: identity.service,
      container: identity.containerId.slice(0, 12),
      workingDir: identity.workingDir ?? null,
    });
  } catch (err) {
    identityError = (err as Error).message;
    log("error", "could not resolve the compose project — updates will be refused", { reason: identityError });
  }

  const problems = configProblems(config);
  for (const problem of problems) log("warn", `configuration: ${problem}`);

  const state: UpdaterState = {
    identity,
    identityError,
    configProblems: problems,
    jobs: new Map<string, UpdateJob>(),
    currentJob: undefined,
    startUpdate() {
      const blockers = updateBlockers(state);
      if (blockers.length > 0) return { ok: false as const, status: 409, reason: blockers.join("; ") };
      if (state.currentJob && state.currentJob.finishedAt === undefined) {
        return { ok: false as const, status: 409, reason: `update ${state.currentJob.id} is already running` };
      }

      const job = new UpdateJob(randomUUID(), identity!.project, config.logTailLines, new Date());
      state.currentJob = job;
      state.jobs.set(job.id, job);
      // Keep the map from growing without bound across a long uptime.
      if (state.jobs.size > 20) {
        const oldest = [...state.jobs.keys()][0]!;
        if (oldest !== job.id) state.jobs.delete(oldest);
      }

      const deps: UpdateDeps = {
        docker: createDockerRunner(identity!.project),
        git: createGitRunner(config.repoDir, repoOwner(config.repoDir)),
        probeHealth,
        sleep,
        now: () => new Date(),
      };

      void runUpdate(job, identity!, config, deps).catch((err) => {
        job.phase = "done";
        job.result = "failed";
        job.message = `the update stopped unexpectedly: ${(err as Error).message}`;
        job.finishedAt = new Date();
        job.note(job.message);
        log("error", "update job crashed", { id: job.id, error: (err as Error).message });
      });

      return { ok: true as const, job: job.snapshot() };
    },
  };

  listen(config, state);
}

void main();
