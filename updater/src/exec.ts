/**
 * Process execution.
 *
 * Two rules live here:
 *   • every `docker` argv passes `assertSafeDockerArgs()` before it is spawned,
 *     with no way to bypass it from the calling code;
 *   • every `git` command runs as the *owner of the host repo*, not as root.
 *     The container is root (it holds the Docker socket), and a root-owned
 *     `git pull` would leave root-owned files behind in the user's checkout,
 *     quietly breaking their own git from then on.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { assertSafeDockerArgs } from "./guard.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
  /** Receives every output line as it arrives (job log tail). */
  onLine?: (line: string) => void;
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        uid: options.uid,
        gid: options.gid,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      rejectPromise(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;

    const attach = (stream: NodeJS.ReadableStream, sink: (chunk: string) => void) => {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        sink(chunk);
        if (!options.onLine) return;
        pending += chunk;
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const part of parts) options.onLine(part);
      });
      stream.on("end", () => {
        if (options.onLine && pending) options.onLine(pending);
      });
    };

    attach(child.stdout!, (chunk) => {
      stdout += chunk;
    });
    attach(child.stderr!, (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

export type DockerRunner = (args: string[], options?: RunOptions) => Promise<RunResult>;
export type GitRunner = (args: string[], options?: RunOptions) => Promise<RunResult>;

/**
 * Docker runner bound to one project name. The binding is the safety property:
 * there is no code path that can run `docker compose` against another project,
 * because the guard rejects the argv before the spawn happens.
 */
export function createDockerRunner(project: string): DockerRunner {
  return (args, options = {}) => {
    assertSafeDockerArgs(args, project);
    return run("docker", args, options);
  };
}

/** uid/gid that own the host checkout, so git writes files the user still owns. */
export function repoOwner(repoDir: string): { uid: number; gid: number } {
  const stat = statSync(repoDir);
  return { uid: stat.uid, gid: stat.gid };
}

export function createGitRunner(repoDir: string, owner: { uid: number; gid: number }): GitRunner {
  return (args, options = {}) =>
    run("git", ["-C", repoDir, ...args], {
      ...options,
      uid: owner.uid,
      gid: owner.gid,
      env: {
        ...process.env,
        // No user config is reachable for this uid inside the container; point
        // HOME at a writable path so git does not fall over looking for one.
        HOME: "/tmp",
        // Never block on an interactive credential prompt — a hung update is
        // worse than a failed one.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/true",
        GIT_CONFIG_NOSYSTEM: "1",
        ...(options.env ?? {}),
      },
    });
}
