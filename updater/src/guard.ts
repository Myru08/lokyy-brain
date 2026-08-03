/**
 * Command guard — the last line of defence before anything reaches the Docker
 * socket.
 *
 * This service holds `/var/run/docker.sock`, which means it holds root on the
 * host. Every `docker …` invocation therefore passes through
 * `assertSafeDockerArgs()` first, and anything that is not explicitly allowed is
 * rejected. Denylists alone would be wishful thinking, so the check is
 * allowlist-first (verb + subcommand + flags) with an additional denylist on top
 * to make the intent — and the tests — unmistakable.
 *
 * The two properties this file exists to guarantee (Story 7.12, AC#9):
 *   1. No command can ever destroy data: no `down`, no `-v/--volumes`,
 *      no `--remove-orphans`, no `volume rm`, no `prune`, no `rmi`.
 *   2. No command can ever run against a project name other than the one
 *      resolved from this container's own labels. A wrong project name would
 *      spin up a second stack on empty volumes — the worst failure this feature
 *      can produce.
 */

/** `docker <verb>` forms this service is allowed to use at all. */
const ALLOWED_VERBS = new Set(["compose", "inspect", "tag", "image", "version"]);

/** `docker compose <subcommand>` forms this service is allowed to use. */
const ALLOWED_COMPOSE_SUBCOMMANDS = new Set(["build", "up", "ps", "config"]);

/** `docker image <subcommand>` — inspect only, never `rm`/`prune`. */
const ALLOWED_IMAGE_SUBCOMMANDS = new Set(["inspect"]);

/**
 * Tokens that must never appear anywhere in an argv, whatever the verb.
 * Kept as exact-match tokens (not substrings) so a legitimate value such as a
 * path or an image tag can never trip them by accident.
 */
const FORBIDDEN_TOKENS = new Map<string, string>([
  ["down", "`down` tears the stack down and can remove volumes"],
  ["rm", "`rm` removes containers"],
  ["prune", "`prune` removes resources in bulk"],
  ["rmi", "`rmi` removes images"],
  ["-v", "`-v` is `--volumes` on `compose down` — never needed here"],
  ["--volumes", "`--volumes` removes named volumes (user notes, database)"],
  ["--remove-orphans", "`--remove-orphans` removes containers this file does not know about"],
  ["--force-recreate", "not needed: compose recreates on config/image change by itself"],
  ["--renew-anon-volumes", "recreates anonymous volumes"],
  ["-V", "`-V` is `--renew-anon-volumes` on `compose up`"],
  ["system", "`docker system …` is bulk maintenance, never part of an update"],
  ["volume", "`docker volume …` touches the volumes that hold all user data"],
  ["builder", "`docker builder …` includes cache pruning"],
]);

/** Global `docker compose` options that consume the following argv entry. */
const COMPOSE_VALUE_OPTIONS = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--project-directory",
  "--env-file",
  "--profile",
  "--progress",
  "--ansi",
  "--parallel",
]);

export class UnsafeCommandError extends Error {
  constructor(
    message: string,
    readonly args: string[],
  ) {
    super(message);
    this.name = "UnsafeCommandError";
  }
}

/** Extracts every `-p/--project-name` value from a `docker compose` argv. */
export function extractProjectNames(args: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-p" || arg === "--project-name") {
      const value = args[i + 1];
      if (value !== undefined) found.push(value);
      i++;
      continue;
    }
    if (arg.startsWith("--project-name=")) found.push(arg.slice("--project-name=".length));
  }
  return found;
}

/**
 * Returns the `docker compose` subcommand, skipping global options and the
 * values they consume. `undefined` when the argv carries no subcommand at all.
 */
export function extractComposeSubcommand(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (COMPOSE_VALUE_OPTIONS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

/**
 * Throws `UnsafeCommandError` unless `args` is a command this service is
 * allowed to run against `expectedProject`.
 *
 * @param args            argv passed to the `docker` binary (without "docker")
 * @param expectedProject compose project name resolved from our own container
 *                        labels — never guessed, never derived from a path
 */
export function assertSafeDockerArgs(args: string[], expectedProject: string): void {
  const fail = (reason: string): never => {
    throw new UnsafeCommandError(`refused unsafe docker command (${reason}): docker ${args.join(" ")}`, args);
  };

  if (args.length === 0) fail("empty argv");

  if (!expectedProject || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(expectedProject)) {
    fail(`unusable project name ${JSON.stringify(expectedProject)}`);
  }

  for (const arg of args) {
    const reason = FORBIDDEN_TOKENS.get(arg);
    if (reason) fail(reason);
  }

  const verb = args[0]!;
  if (!ALLOWED_VERBS.has(verb)) fail(`verb "${verb}" is not on the allowlist`);

  if (verb === "image") {
    const sub = args[1];
    if (!sub || !ALLOWED_IMAGE_SUBCOMMANDS.has(sub)) fail(`"docker image ${sub ?? ""}" is not on the allowlist`);
  }

  if (verb !== "compose") return;

  const sub = extractComposeSubcommand(args);
  if (!sub) fail("compose invocation without a subcommand");
  if (!ALLOWED_COMPOSE_SUBCOMMANDS.has(sub!)) fail(`compose subcommand "${sub}" is not on the allowlist`);

  const projects = extractProjectNames(args);
  if (projects.length === 0) {
    // Without an explicit -p, compose derives the project from the directory it
    // runs in. Inside this container that is /repo — which is NOT the user's
    // folder name, so compose would address a second, empty stack.
    fail("compose invocation without an explicit -p project name");
  }
  for (const project of projects) {
    if (project !== expectedProject) {
      fail(`project name ${JSON.stringify(project)} does not match the resolved project ${JSON.stringify(expectedProject)}`);
    }
  }

  if (sub === "up") {
    if (!args.includes("-d") && !args.includes("--detach")) fail("`compose up` must be detached");
    if (!args.includes("--no-deps")) fail("`compose up` must pass --no-deps so it only touches the listed services");
  }
}

/** Convenience for tests and logging: the human-readable denylist. */
export function forbiddenTokens(): ReadonlyMap<string, string> {
  return FORBIDDEN_TOKENS;
}
