/** Environment parsing. Deliberately small — every knob here is attached to root. */

import { isAbsolute, resolve } from "node:path";

export interface UpdaterConfig {
  port: number;
  /** Shared secret the brain authenticates with. Empty ⇒ updates are refused. */
  token: string;
  /** Host repo bind mount. Must match the `:/repo` target in compose. */
  repoDir: string;
  /** Absolute compose file paths, in `-f` order. */
  composeFiles: string[];
  /** Probed after the switch; the stack is only "healthy" when this answers. */
  healthUrl: string;
  gitRemote: string;
  gitBranch: string;
  buildTimeoutMs: number;
  healthTimeoutMs: number;
  stepTimeoutMs: number;
  logTailLines: number;
}

function num(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): UpdaterConfig {
  const repoDir = env.LOKYY_UPDATER_REPO?.trim() || "/repo";

  // Colon-separated, like COMPOSE_FILE, so a fork can pass an override file.
  const composeFiles = (env.LOKYY_UPDATER_COMPOSE_FILE?.trim() || "docker-compose.local.yml")
    .split(":")
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => (isAbsolute(f) ? f : resolve(repoDir, f)));

  return {
    port: num(env.LOKYY_UPDATER_PORT, 8799),
    token: env.LOKYY_UPDATER_TOKEN?.trim() ?? "",
    repoDir,
    composeFiles,
    healthUrl: env.LOKYY_UPDATER_HEALTH_URL?.trim() || "http://lokyy-brain:8787/health",
    gitRemote: env.LOKYY_UPDATER_GIT_REMOTE?.trim() || "origin",
    gitBranch: env.LOKYY_UPDATER_GIT_BRANCH?.trim() || "",
    // A cold build of the whole stack on a laptop is minutes, not seconds.
    buildTimeoutMs: num(env.LOKYY_UPDATER_BUILD_TIMEOUT_MS, 45 * 60_000),
    healthTimeoutMs: num(env.LOKYY_UPDATER_HEALTH_TIMEOUT_MS, 180_000),
    stepTimeoutMs: num(env.LOKYY_UPDATER_STEP_TIMEOUT_MS, 5 * 60_000),
    logTailLines: num(env.LOKYY_UPDATER_LOG_LINES, 400),
  };
}

/** Reasons the updater will not run an update, checked before anything starts. */
export function configProblems(config: UpdaterConfig): string[] {
  const problems: string[] = [];
  if (!config.token) {
    problems.push(
      "LOKYY_UPDATER_TOKEN is not set — set it in .env (same value for lokyy-brain and lokyy-updater)",
    );
  } else if (config.token.length < 16) {
    problems.push("LOKYY_UPDATER_TOKEN is shorter than 16 characters");
  }
  return problems;
}
