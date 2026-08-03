/**
 * Command planner — pure functions that build the exact argv arrays the update
 * runs.
 *
 * Keeping this free of I/O means the whole command surface of an update can be
 * asserted in a unit test (AC#9: "automatisierter Check über die abgesetzten
 * Kommandos") without spawning anything.
 */

export interface ComposeContext {
  /** Resolved from our own container labels — never guessed. */
  project: string;
  /** Absolute paths inside the container, in `-f` order. */
  composeFiles: string[];
}

/** `docker compose -p <project> -f <file> [-f <file> …]` */
export function composeBaseArgs(ctx: ComposeContext): string[] {
  const args = ["compose", "-p", ctx.project];
  for (const file of ctx.composeFiles) args.push("-f", file);
  return args;
}

/** Full, resolved compose model as JSON — the source of truth for service lists. */
export function composeConfigArgs(ctx: ComposeContext): string[] {
  return [...composeBaseArgs(ctx), "config", "--format", "json"];
}

/** Container list for the project, as JSON lines. */
export function composePsArgs(ctx: ComposeContext, services: string[] = []): string[] {
  return [...composeBaseArgs(ctx), "ps", "--format", "json", "--all", ...services];
}

/**
 * Build step. Non-destructive by construction: `compose build` produces new
 * images and does not touch a single running container. This is the property
 * the whole rollback story rests on.
 */
export function composeBuildArgs(ctx: ComposeContext, services: string[]): string[] {
  return [...composeBaseArgs(ctx), "build", ...services];
}

/**
 * Switch step. `--no-deps` keeps compose to exactly the listed services, so
 * nothing implicit (postgres, forgejo, ollama — or this container) gets
 * recreated as a side effect.
 */
export function composeUpArgs(ctx: ComposeContext, services: string[]): string[] {
  return [...composeBaseArgs(ctx), "up", "-d", "--no-deps", ...services];
}

/** Reads a container's image reference and image ID for the rollback record. */
export function inspectContainerArgs(containerId: string): string[] {
  return ["inspect", "--type", "container", "--format", "{{json .}}", containerId];
}

/** Re-points an image tag at a previously recorded image ID (rollback). */
export function tagArgs(imageId: string, imageRef: string): string[] {
  return ["tag", imageId, imageRef];
}

/** True when the image ID still exists locally — checked before rolling back to it. */
export function imageExistsArgs(imageId: string): string[] {
  return ["image", "inspect", "--format", "{{.Id}}", imageId];
}

export interface UpdatePlanInput extends ComposeContext {
  /** Services that get rebuilt and switched (build services minus ourselves). */
  targetServices: string[];
  /** Recorded `<imageId, imageRef>` pairs used only on the rollback path. */
  rollbackImages: { imageId: string; imageRef: string }[];
}

/**
 * Every docker argv an update can possibly emit, in order. Used by the test
 * that proves no destructive command and no foreign project name can appear on
 * any path — including the rollback path.
 */
export function fullUpdatePlan(input: UpdatePlanInput): string[][] {
  const plan: string[][] = [
    composeConfigArgs(input),
    composePsArgs(input, input.targetServices),
    ...input.rollbackImages.map((img) => inspectContainerArgs(img.imageId)),
    composeBuildArgs(input, input.targetServices),
    composeUpArgs(input, input.targetServices),
    composePsArgs(input, input.targetServices),
  ];
  // Rollback path.
  for (const img of input.rollbackImages) {
    plan.push(imageExistsArgs(img.imageId));
    plan.push(tagArgs(img.imageId, img.imageRef));
  }
  plan.push(composeUpArgs(input, input.targetServices));
  return plan;
}

/** Git argv used by the update, in order. Same idea as `fullUpdatePlan`. */
export function fullGitPlan(oldSha: string, remote: string, branch: string): string[][] {
  return [
    ["status", "--porcelain"],
    ["rev-parse", "HEAD"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
    ["fetch", "--quiet", remote, branch],
    // FETCH_HEAD rather than <remote>/<branch>: a fork's checkout may have no
    // remote-tracking ref configured for the branch we were told to follow.
    ["rev-list", "--left-right", "--count", "HEAD...FETCH_HEAD"],
    ["pull", "--ff-only", remote, branch],
    ["reset", "--hard", oldSha],
  ];
}

/**
 * Services to rebuild and switch: everything the compose model builds from
 * source, minus this container's own service.
 *
 * Why not "every service": services pinned to an upstream image (postgres,
 * forgejo, ollama) hold the user's data. Recreating them is not something an
 * in-app update button should do implicitly, and a rebuild cannot change them
 * anyway. They stay as they are; a compose change that touches them takes
 * effect on the next manual `./install.sh`.
 *
 * Why not this container: `up -d` would recreate the updater mid-run and kill
 * the job it is executing.
 */
export function selectTargetServices(
  composeConfig: { services?: Record<string, { build?: unknown }> },
  selfService: string,
): string[] {
  const services = composeConfig.services ?? {};
  return Object.entries(services)
    .filter(([name, def]) => def?.build != null && name !== selfService)
    .map(([name]) => name)
    .sort();
}
