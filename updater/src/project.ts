/**
 * Self-identification — answering "which compose project am I part of?"
 *
 * This is the single most dangerous question in the whole update feature.
 * `install.sh` runs `docker compose … up -d --build` **without `-p`**, so the
 * real project name is the basename of whatever folder the user cloned into.
 * This container cannot see that folder name: `/repo` is a bind mount and its
 * mount point tells us nothing about the host path.
 *
 * Guessing wrong does not fail loudly — it silently addresses a *different*
 * stack, creates fresh empty volumes and leaves the user staring at an empty
 * Lokyy while their notes sit in volumes nobody is using any more.
 *
 * So the name is never derived. It is read from this container's own
 * `com.docker.compose.project` label, and only after the container we inspected
 * has been positively identified as ourselves. If any part of that fails, the
 * correct answer is to refuse the update.
 */

/** Where the host repo is bound into this container. Used as an identity proof. */
export const REPO_MOUNT_TARGET = "/repo";

export interface SelfIdentity {
  containerId: string;
  project: string;
  service: string;
  /** Host path of the project directory, per compose's own label. Display only. */
  workingDir?: string;
}

export interface DockerInspectResult {
  Id?: string;
  Name?: string;
  Config?: { Hostname?: string; Labels?: Record<string, string> };
  Mounts?: { Destination?: string; Source?: string }[];
}

const HEX64 = /[0-9a-f]{64}/g;

/**
 * Collects candidate container IDs for *this* process, most trustworthy first.
 *
 * `/proc/self/mountinfo` is the strongest signal: the daemon bind-mounts
 * `/var/lib/docker/containers/<id>/{resolv.conf,hostname,hosts}` into every
 * container, so our real ID appears verbatim. The hostname is next (compose
 * leaves it at the short container ID unless the user overrides it), then
 * cgroup paths. Everything else that merely looks like a 64-hex string is kept
 * last — those are usually image layer IDs and will simply fail to resolve as
 * containers, which is exactly what the verification step is for.
 */
export function extractContainerIdCandidates(
  hostname: string,
  mountinfo: string,
  cgroup: string,
): string[] {
  const ordered: string[] = [];
  const push = (value: string | undefined | null) => {
    if (!value) return;
    const id = value.trim().toLowerCase();
    if (!/^[0-9a-f]{12,64}$/.test(id)) return;
    if (!ordered.includes(id)) ordered.push(id);
  };

  for (const match of mountinfo.matchAll(/\/containers\/([0-9a-f]{64})\//g)) push(match[1]);
  push(hostname);
  for (const match of cgroup.matchAll(/(?:docker[-/]|containerd[-/])([0-9a-f]{64})/g)) push(match[1]);
  for (const match of cgroup.matchAll(HEX64)) push(match[0]);
  for (const match of mountinfo.matchAll(HEX64)) push(match[0]);

  return ordered;
}

export type VerifyResult =
  | { ok: true; identity: SelfIdentity }
  | { ok: false; reason: string };

/**
 * Decides whether an inspected container really is us.
 *
 * Four independent facts have to line up. Any single one of them could be
 * coincidence; together they do not happen by accident:
 *   1. the inspected ID starts with the candidate we took from our own /proc,
 *   2. it carries a non-empty `com.docker.compose.project` label,
 *   3. it carries a `com.docker.compose.service` label,
 *   4. it has the host repo bound at `/repo` — the mount that makes this
 *      container what it is.
 */
export function verifySelfContainer(
  inspect: DockerInspectResult,
  candidateId: string,
  options: { repoMountTarget?: string; expectedService?: string } = {},
): VerifyResult {
  const repoMountTarget = options.repoMountTarget ?? REPO_MOUNT_TARGET;
  const id = (inspect.Id ?? "").toLowerCase();
  if (!id) return { ok: false, reason: "inspect returned no container Id" };
  if (!id.startsWith(candidateId.toLowerCase())) {
    return { ok: false, reason: `inspected container ${id.slice(0, 12)} is not the candidate ${candidateId.slice(0, 12)}` };
  }

  const labels = inspect.Config?.Labels ?? {};
  const project = labels["com.docker.compose.project"];
  const service = labels["com.docker.compose.service"];
  if (!project) return { ok: false, reason: "container has no com.docker.compose.project label" };
  if (!service) return { ok: false, reason: "container has no com.docker.compose.service label" };
  if (options.expectedService && service !== options.expectedService) {
    return { ok: false, reason: `container is service "${service}", expected "${options.expectedService}"` };
  }

  const hasRepoMount = (inspect.Mounts ?? []).some((m) => m.Destination === repoMountTarget);
  if (!hasRepoMount) {
    return { ok: false, reason: `container has no mount at ${repoMountTarget} — it cannot be the updater` };
  }

  return {
    ok: true,
    identity: {
      containerId: id,
      project,
      service,
      workingDir: labels["com.docker.compose.project.working_dir"],
    },
  };
}

export class ProjectResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectResolutionError";
  }
}

export interface ResolveDeps {
  /** Raw `docker inspect --type container --format {{json .}} <id>` output. */
  inspectContainer(id: string): Promise<DockerInspectResult | null>;
  hostname(): string;
  readMountInfo(): string;
  readCgroup(): string;
}

/**
 * Resolves this container's compose project, or throws. Throwing is the whole
 * point: "refuse the update with a clear message" beats any fallback.
 */
export async function resolveSelfIdentity(
  deps: ResolveDeps,
  options: { repoMountTarget?: string } = {},
): Promise<SelfIdentity> {
  const candidates = extractContainerIdCandidates(deps.hostname(), deps.readMountInfo(), deps.readCgroup());
  if (candidates.length === 0) {
    throw new ProjectResolutionError(
      "could not determine this container's own ID from /proc — refusing to guess a compose project name",
    );
  }

  const failures: string[] = [];
  const matches: SelfIdentity[] = [];
  for (const candidate of candidates) {
    let inspect: DockerInspectResult | null;
    try {
      inspect = await deps.inspectContainer(candidate);
    } catch (err) {
      failures.push(`${candidate.slice(0, 12)}: ${(err as Error).message}`);
      continue;
    }
    if (!inspect) {
      failures.push(`${candidate.slice(0, 12)}: not a container`);
      continue;
    }
    const verdict = verifySelfContainer(inspect, candidate, options);
    if (verdict.ok) {
      matches.push(verdict.identity);
      break;
    }
    failures.push(`${candidate.slice(0, 12)}: ${verdict.reason}`);
  }

  if (matches.length === 0) {
    throw new ProjectResolutionError(
      "could not identify this container via the Docker socket, so the compose project name is unknown. " +
        "Refusing to update — a guessed project name would start a second stack on empty volumes. " +
        `Checked: ${failures.join("; ")}`,
    );
  }

  return matches[0]!;
}
