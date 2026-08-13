/**
 * The update itself.
 *
 * Order is the safety property, not a style choice:
 *
 *   preflight → pull → **build** → switch → verify
 *
 * The long, fragile step (build) comes *before* anything is switched, and
 * `docker compose build` does not touch a single running container. So a failed
 * build is not a partial update — it is a no-op with a log attached. Only the
 * short window between `up -d` and the health probe needs a rollback at all,
 * and for that it is enough to have written down the previous image IDs first.
 *
 * The honest limit of that rollback, which belongs in the README too: database
 * migrations run at startup and switching images back does **not** undo a
 * migration that already ran. This covers "the new image does not start", not
 * "the new schema was wrong".
 */

import type { UpdaterConfig } from "./config.js";
import type { DockerRunner, GitRunner, RunResult } from "./exec.js";
import { RingLog, log } from "./log.js";
import {
  composeBuildArgs,
  composeConfigArgs,
  composePsArgs,
  composeUpArgs,
  imageExistsArgs,
  inspectContainerArgs,
  selectTargetServices,
  tagArgs,
  type ComposeContext,
} from "./plan.js";
import type { SelfIdentity } from "./project.js";

export type Phase =
  | "queued"
  | "preflight"
  | "pull"
  | "build"
  | "switch"
  | "verify"
  | "rollback"
  | "done";

export type JobResult =
  | "success"
  | "already-up-to-date"
  | "aborted"
  | "build-failed"
  | "rolled-back"
  | "failed";

export interface JobSnapshot {
  id: string;
  phase: Phase;
  running: boolean;
  result?: JobResult;
  message?: string;
  startedAt: string;
  finishedAt?: string;
  project: string;
  targetServices: string[];
  fromSha?: string;
  toSha?: string;
  log: string[];
}

export interface UpdateDeps {
  docker: DockerRunner;
  git: GitRunner;
  probeHealth(url: string, timeoutMs: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

interface RollbackEntry {
  service: string;
  imageRef: string;
  imageId: string;
}

/** compose emits either JSON-lines or a JSON array depending on the version. */
export function parseComposeJson<T>(stdout: string): T[] {
  const text = stdout.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      return JSON.parse(text) as T[];
    } catch {
      return [];
    }
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* a stray non-JSON line is not worth failing an update over */
    }
  }
  return out;
}

interface ComposePsEntry {
  ID?: string;
  Name?: string;
  Service?: string;
  State?: string;
}

export class UpdateJob {
  readonly id: string;
  phase: Phase = "queued";
  result?: JobResult;
  message?: string;
  readonly startedAt: Date;
  finishedAt?: Date;
  fromSha?: string;
  toSha?: string;
  targetServices: string[] = [];
  private readonly ring: RingLog;

  constructor(
    id: string,
    readonly project: string,
    logLines: number,
    now: Date,
  ) {
    this.id = id;
    this.startedAt = now;
    this.ring = new RingLog(logLines);
  }

  append(line: string): void {
    this.ring.push(line);
  }

  note(line: string): void {
    this.ring.push(`>> ${line}`);
    log("info", `[job ${this.id}] ${line}`);
  }

  snapshot(): JobSnapshot {
    return {
      id: this.id,
      phase: this.phase,
      running: this.finishedAt === undefined,
      result: this.result,
      message: this.message,
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.finishedAt?.toISOString(),
      project: this.project,
      targetServices: this.targetServices,
      fromSha: this.fromSha,
      toSha: this.toSha,
      log: this.ring.tail(),
    };
  }
}

function fail(job: UpdateJob, result: JobResult, message: string, now: Date): JobSnapshot {
  job.phase = "done";
  job.result = result;
  job.message = message;
  job.finishedAt = now;
  job.note(`${result}: ${message}`);
  return job.snapshot();
}

function tail(text: string, count: number): string {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join("\n");
}

function lastLines(res: RunResult, count = 25): string {
  return tail(`${res.stdout}\n${res.stderr}`, count);
}

/**
 * Error text for a command whose *stdout* is resolved configuration.
 *
 * `docker compose config` prints the fully resolved model — every environment
 * value in plain text, updater token and database password included — and job
 * messages and job logs are handed to the admin UI verbatim. stderr carries the
 * reason it failed; stdout carries the secrets. Only the reason may be shown.
 */
function stderrOnly(res: RunResult, count = 25): string {
  return tail(res.stderr, count) || "(docker printed no error text)";
}

/**
 * Is a dirty working copy dirty *only* because of line endings?
 *
 * `git status --porcelain` flags a CRLF-vs-LF file exactly like a real edit, so
 * the porcelain text alone cannot tell them apart. `git diff --ignore-space-at-eol`
 * can: it treats the trailing CR as whitespace, so a clean (`--quiet` → exit 0)
 * result there means every tracked modification is line-ending-only. Both the
 * working tree and the index are checked, because either can carry the noise.
 *
 * Untracked files (`??`) are never line-ending noise — they are content the user
 * added and `git diff` cannot see them — so their presence forces the abort path.
 * Anything but a clean exit 0 from either diff (a real change, or a diff that
 * errored) is likewise treated as unsafe, so genuine edits are never discarded.
 */
export async function isEolOnlyDirtiness(
  porcelain: string,
  deps: UpdateDeps,
  config: UpdaterConfig,
): Promise<boolean> {
  const hasUntracked = porcelain.split("\n").some((line) => line.startsWith("??"));
  if (hasUntracked) return false;

  const worktree = await deps.git(["diff", "--ignore-space-at-eol", "--quiet"], {
    timeoutMs: config.stepTimeoutMs,
  });
  const staged = await deps.git(["diff", "--cached", "--ignore-space-at-eol", "--quiet"], {
    timeoutMs: config.stepTimeoutMs,
  });
  return worktree.code === 0 && staged.code === 0;
}

export async function runUpdate(
  job: UpdateJob,
  identity: SelfIdentity,
  config: UpdaterConfig,
  deps: UpdateDeps,
): Promise<JobSnapshot> {
  const ctx: ComposeContext = { project: identity.project, composeFiles: config.composeFiles };
  const sink = (line: string) => job.append(line);
  // NB: `compose config` deliberately gets no `onLine` sink anywhere in this
  // file — see `stderrOnly`. Its output is the resolved compose model.
  const quietOpts = { timeoutMs: config.stepTimeoutMs };

  // ── 1. Preflight — nothing is touched here, only read ──────────────────
  job.phase = "preflight";
  job.note(`compose project "${identity.project}" (from label on container ${identity.containerId.slice(0, 12)})`);
  job.note(`compose files: ${config.composeFiles.join(", ")}`);

  const status = await deps.git(["status", "--porcelain"], { timeoutMs: config.stepTimeoutMs });
  if (status.code !== 0) {
    return fail(job, "aborted", `git status failed in ${config.repoDir}: ${lastLines(status, 5)}`, deps.now());
  }
  if (status.stdout.trim()) {
    // Windows installs cloned with core.autocrlf=true carry a CRLF working copy.
    // Mounted into this Linux container — where git compares those CRLF files
    // against the LF blobs — every tracked file reads as "modified" from its
    // line endings alone, with no real edit behind it, and the update aborts
    // forever. Discard that noise; keep aborting on anything with actual content.
    if (await isEolOnlyDirtiness(status.stdout, deps, config)) {
      job.note(
        "working copy differs from the repository in line endings only (CRLF vs LF, typical of a " +
          "Windows checkout mounted into a Linux container) — discarding those harmless differences so " +
          "the update can fast-forward. No real edits were present.",
      );
      const discard = await deps.git(["checkout", "--", "."], { timeoutMs: config.stepTimeoutMs });
      if (discard.code !== 0) {
        return fail(
          job,
          "aborted",
          `could not normalize the line-ending-only differences in ${config.repoDir}. Nothing was touched.\n${lastLines(discard, 5)}`,
          deps.now(),
        );
      }
    } else {
      return fail(
        job,
        "aborted",
        "the repository has local changes. Nothing was touched. Commit or discard them first — " +
          "updating over your own edits could silently throw them away.\n" +
          status.stdout.trim().split("\n").slice(0, 20).join("\n"),
        deps.now(),
      );
    }
  }

  const headRes = await deps.git(["rev-parse", "HEAD"], { timeoutMs: config.stepTimeoutMs });
  if (headRes.code !== 0) {
    return fail(job, "aborted", `could not read HEAD: ${lastLines(headRes, 5)}`, deps.now());
  }
  const oldSha = headRes.stdout.trim();
  job.fromSha = oldSha;

  let branch = config.gitBranch;
  if (!branch) {
    const branchRes = await deps.git(["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: config.stepTimeoutMs });
    branch = branchRes.stdout.trim();
  }
  if (!branch || branch === "HEAD") {
    return fail(job, "aborted", "the repository is in detached HEAD state — refusing to update it.", deps.now());
  }
  job.note(`repo at ${oldSha.slice(0, 12)} on ${branch}, working copy clean`);

  const configResBefore = await deps.docker(composeConfigArgs(ctx), quietOpts);
  if (configResBefore.code !== 0) {
    return fail(job, "aborted", `compose config failed: ${stderrOnly(configResBefore)}`, deps.now());
  }
  const oldTargets = selectTargetServices(JSON.parse(configResBefore.stdout), identity.service);
  if (oldTargets.length === 0) {
    return fail(job, "aborted", "no buildable services found in the compose file — nothing to update.", deps.now());
  }
  job.targetServices = oldTargets;
  job.note(`services to rebuild and switch: ${oldTargets.join(", ")} (excluding self: ${identity.service})`);

  // Image IDs are the rollback record. Captured before anything changes.
  const rollback = await captureImages(ctx, oldTargets, deps, config, job);
  job.note(`recorded ${rollback.length} image(s) for rollback`);

  // ── 2. Pull — still non-destructive; aborts leave the checkout as it was ─
  job.phase = "pull";
  const fetchRes = await deps.git(["fetch", "--quiet", config.gitRemote, branch], {
    onLine: sink,
    timeoutMs: config.stepTimeoutMs,
  });
  if (fetchRes.code !== 0) {
    return fail(
      job,
      "aborted",
      `could not reach the git remote "${config.gitRemote}". Nothing was touched.\n${lastLines(fetchRes, 10)}`,
      deps.now(),
    );
  }

  const countRes = await deps.git(["rev-list", "--left-right", "--count", `HEAD...FETCH_HEAD`], {
    timeoutMs: config.stepTimeoutMs,
  });
  const [aheadRaw, behindRaw] = countRes.stdout.trim().split(/\s+/);
  const ahead = Number(aheadRaw ?? 0);
  const behind = Number(behindRaw ?? 0);
  if (countRes.code !== 0 || !Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return fail(job, "aborted", `could not compare with the remote: ${lastLines(countRes, 10)}`, deps.now());
  }
  if (ahead > 0) {
    return fail(
      job,
      "aborted",
      `this checkout has ${ahead} commit(s) that the remote does not have — the branches have diverged. ` +
        "Nothing was touched, so your own commits are safe. Resolve this in a terminal.",
      deps.now(),
    );
  }
  if (behind === 0) {
    job.phase = "done";
    job.result = "already-up-to-date";
    job.message = "The checkout is already at the newest commit. Nothing to do.";
    job.finishedAt = deps.now();
    job.note(job.message);
    return job.snapshot();
  }
  job.note(`${behind} new commit(s) available`);

  const pullRes = await deps.git(["pull", "--ff-only", config.gitRemote, branch], {
    onLine: sink,
    timeoutMs: config.stepTimeoutMs,
  });
  if (pullRes.code !== 0) {
    return fail(job, "aborted", `git pull --ff-only failed. Nothing was touched.\n${lastLines(pullRes, 15)}`, deps.now());
  }
  const newHead = await deps.git(["rev-parse", "HEAD"], { timeoutMs: config.stepTimeoutMs });
  job.toSha = newHead.stdout.trim();
  job.note(`pulled ${oldSha.slice(0, 12)} → ${job.toSha.slice(0, 12)}`);

  // The compose file itself may have changed with the pull.
  const configResAfter = await deps.docker(composeConfigArgs(ctx), quietOpts);
  if (configResAfter.code !== 0) {
    await deps.git(["reset", "--hard", oldSha], { onLine: sink, timeoutMs: config.stepTimeoutMs });
    return fail(
      job,
      "aborted",
      `the new version's compose file is not valid — rolled the checkout back, the running stack was never touched.\n${stderrOnly(configResAfter)}`,
      deps.now(),
    );
  }
  const targets = selectTargetServices(JSON.parse(configResAfter.stdout), identity.service);
  if (targets.length === 0) {
    await deps.git(["reset", "--hard", oldSha], { onLine: sink, timeoutMs: config.stepTimeoutMs });
    return fail(job, "aborted", "the new version has no buildable services — rolled the checkout back.", deps.now());
  }
  job.targetServices = targets;

  // ── 3. Build — the long step, and the reason this design is safe ────────
  job.phase = "build";
  job.note(`building ${targets.join(", ")} — this can take several minutes and does not touch the running stack`);
  const buildRes = await deps.docker(composeBuildArgs(ctx, targets), {
    onLine: sink,
    timeoutMs: config.buildTimeoutMs,
  });
  if (buildRes.code !== 0) {
    await deps.git(["reset", "--hard", oldSha], { onLine: sink, timeoutMs: config.stepTimeoutMs });
    return fail(
      job,
      "build-failed",
      "The build of the new version failed. Your installation was not touched — the previous version is still " +
        `running and the checkout was put back to ${oldSha.slice(0, 12)}.\n${lastLines(buildRes, 40)}`,
      deps.now(),
    );
  }
  job.note("build succeeded");

  // ── 4. Switch — from here on a rollback can be needed ───────────────────
  job.phase = "switch";
  const upRes = await deps.docker(composeUpArgs(ctx, targets), { onLine: sink, timeoutMs: config.stepTimeoutMs });
  if (upRes.code !== 0) {
    return doRollback(job, ctx, oldSha, oldTargets, rollback, deps, config, `starting the new version failed:\n${lastLines(upRes, 25)}`);
  }

  // ── 5. Verify ──────────────────────────────────────────────────────────
  job.phase = "verify";
  job.note(`probing ${config.healthUrl}`);
  const healthy = await waitForHealth(config, deps, job);
  if (!healthy) {
    return doRollback(job, ctx, oldSha, oldTargets, rollback, deps, config, `the new version did not become healthy within ${Math.round(config.healthTimeoutMs / 1000)}s`);
  }

  const notRunning = await servicesNotRunning(ctx, targets, deps, config);
  if (notRunning.length > 0) {
    return doRollback(job, ctx, oldSha, oldTargets, rollback, deps, config, `service(s) not running after the switch: ${notRunning.join(", ")}`);
  }

  job.phase = "done";
  job.result = "success";
  job.message = `Updated to ${job.toSha?.slice(0, 12)}. Notes, database and settings were not touched.`;
  job.finishedAt = deps.now();
  job.note(job.message);
  return job.snapshot();
}

async function captureImages(
  ctx: ComposeContext,
  services: string[],
  deps: UpdateDeps,
  config: UpdaterConfig,
  job: UpdateJob,
): Promise<RollbackEntry[]> {
  const psRes = await deps.docker(composePsArgs(ctx, services), { timeoutMs: config.stepTimeoutMs });
  const entries = parseComposeJson<ComposePsEntry>(psRes.stdout);
  const out: RollbackEntry[] = [];
  for (const entry of entries) {
    const containerId = entry.ID ?? entry.Name;
    if (!containerId || !entry.Service) continue;
    const inspectRes = await deps.docker(inspectContainerArgs(containerId), { timeoutMs: config.stepTimeoutMs });
    if (inspectRes.code !== 0) continue;
    try {
      const parsed = JSON.parse(inspectRes.stdout.trim()) as {
        Image?: string;
        Config?: { Image?: string };
      };
      const imageId = parsed.Image;
      const imageRef = parsed.Config?.Image;
      if (imageId && imageRef) out.push({ service: entry.Service, imageRef, imageId });
    } catch {
      job.note(`could not read the current image of ${entry.Service} — it will not be restorable`);
    }
  }
  return out;
}

async function waitForHealth(config: UpdaterConfig, deps: UpdateDeps, job: UpdateJob): Promise<boolean> {
  const deadline = deps.now().getTime() + config.healthTimeoutMs;
  let attempt = 0;
  while (deps.now().getTime() < deadline) {
    attempt++;
    if (await deps.probeHealth(config.healthUrl, 5_000)) {
      job.note(`healthy after ${attempt} probe(s)`);
      return true;
    }
    await deps.sleep(3_000);
  }
  return false;
}

async function servicesNotRunning(
  ctx: ComposeContext,
  services: string[],
  deps: UpdateDeps,
  config: UpdaterConfig,
): Promise<string[]> {
  const psRes = await deps.docker(composePsArgs(ctx, services), { timeoutMs: config.stepTimeoutMs });
  const entries = parseComposeJson<ComposePsEntry>(psRes.stdout);
  const running = new Set(entries.filter((e) => e.State === "running").map((e) => e.Service));
  return services.filter((s) => !running.has(s));
}

/**
 * Puts the previous version back: checkout to the old commit, the recorded
 * image IDs back onto the tags compose resolves, then start again.
 */
async function doRollback(
  job: UpdateJob,
  ctx: ComposeContext,
  oldSha: string,
  oldTargets: string[],
  rollback: RollbackEntry[],
  deps: UpdateDeps,
  config: UpdaterConfig,
  reason: string,
): Promise<JobSnapshot> {
  job.phase = "rollback";
  job.note(`rolling back — ${reason}`);
  const sink = (line: string) => job.append(line);

  await deps.git(["reset", "--hard", oldSha], { onLine: sink, timeoutMs: config.stepTimeoutMs });

  for (const entry of rollback) {
    const exists = await deps.docker(imageExistsArgs(entry.imageId), { timeoutMs: config.stepTimeoutMs });
    if (exists.code !== 0) {
      job.note(`previous image for ${entry.service} is gone — cannot restore it`);
      continue;
    }
    const tagRes = await deps.docker(tagArgs(entry.imageId, entry.imageRef), { onLine: sink, timeoutMs: config.stepTimeoutMs });
    if (tagRes.code !== 0) job.note(`could not restore the image tag for ${entry.service}`);
  }

  const upRes = await deps.docker(composeUpArgs(ctx, oldTargets), { onLine: sink, timeoutMs: config.stepTimeoutMs });
  const restored = upRes.code === 0 && (await waitForHealth(config, deps, job));

  job.phase = "done";
  job.result = "rolled-back";
  job.finishedAt = deps.now();
  // The migration caveat belongs in BOTH outcomes. It is the one thing this
  // rollback genuinely cannot undo, and a rollback that itself went wrong is
  // exactly when the user needs to know it.
  const migrationCaveat =
    "Your notes, database and settings were not touched — no volume was ever removed. " +
    "One honest limit: a database migration that already ran at startup is NOT undone by putting the old images back.";
  job.message = restored
    ? `The update failed (${reason}). The previous version was restored and is running again. ${migrationCaveat}`
    : `The update failed (${reason}) AND the previous version did not come back up cleanly. ${migrationCaveat} ` +
      `Next step in a terminal: \`git reset --hard ${oldSha.slice(0, 12)} && ./install.sh\`.`;
  job.note(job.message);
  return job.snapshot();
}
