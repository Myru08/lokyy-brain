import { describe, expect, it } from "vitest";
import type { UpdaterConfig } from "./config.js";
import type { RunOptions, RunResult } from "./exec.js";
import { assertSafeDockerArgs, forbiddenTokens } from "./guard.js";
import type { SelfIdentity } from "./project.js";
import { UpdateJob, parseComposeJson, runUpdate, type UpdateDeps } from "./update.js";

const PROJECT = "meine-lokyy-installation";
const OLD_SHA = "1111111111111111111111111111111111111111";
const NEW_SHA = "2222222222222222222222222222222222222222";

const identity: SelfIdentity = {
  containerId: "b".repeat(64),
  project: PROJECT,
  service: "lokyy-updater",
  workingDir: "/home/user/meine-lokyy-installation",
};

const config: UpdaterConfig = {
  port: 8799,
  token: "a-token-long-enough",
  repoDir: "/repo",
  composeFiles: ["/repo/docker-compose.local.yml"],
  healthUrl: "http://lokyy-brain:8787/health",
  gitRemote: "origin",
  gitBranch: "",
  buildTimeoutMs: 60_000,
  healthTimeoutMs: 10_000,
  stepTimeoutMs: 10_000,
  logTailLines: 200,
};

/**
 * `docker compose config` prints the *resolved* model: every environment value
 * in plain text. These are the strings that must never reach a job log or a job
 * message, because both are handed to the admin UI verbatim.
 */
const COMPOSE_SECRETS = {
  updaterToken: "t712-token-abcdefghijklmnop",
  postgresPassword: "p0stgres-s3cret-do-not-log",
};

const COMPOSE_CONFIG = JSON.stringify({
  services: {
    "lokyy-brain": {
      build: { context: "." },
      environment: {
        LOKYY_UPDATER_TOKEN: COMPOSE_SECRETS.updaterToken,
        POSTGRES_PASSWORD: COMPOSE_SECRETS.postgresPassword,
      },
    },
    "lokyy-pwa": { build: { context: "." } },
    "lokyy-updater": {
      build: { context: "." },
      environment: { LOKYY_UPDATER_TOKEN: COMPOSE_SECRETS.updaterToken },
    },
    postgres: {
      image: "paradedb/paradedb:latest-pg17",
      environment: { POSTGRES_PASSWORD: COMPOSE_SECRETS.postgresPassword },
    },
  },
});

const PS_RUNNING = [
  '{"ID":"c-brain","Service":"lokyy-brain","State":"running"}',
  '{"ID":"c-pwa","Service":"lokyy-pwa","State":"running"}',
].join("\n");

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const bad = (stderr = "boom"): RunResult => ({ code: 1, stdout: "", stderr, timedOut: false });

interface Scenario {
  dirty?: string;
  /**
   * With `dirty` set: does `git diff --ignore-space-at-eol` still report content
   * changes? `true` = real edits (abort), `false`/unset = line-ending-only (safe).
   */
  contentDiff?: boolean;
  ahead?: number;
  behind?: number;
  fetchFails?: boolean;
  pullFails?: boolean;
  buildFails?: boolean;
  upFails?: boolean;
  healthy?: boolean;
  healthyAfterRollback?: boolean;
  psAfterSwitch?: string;
  /** `compose config` on the pulled tree exits non-zero *after* printing. */
  configFailsAfterPull?: boolean;
}

/**
 * Mirrors `run()` in exec.ts: whatever a command prints goes to the caller's
 * `onLine` sink too. Without this the mock is blind to exactly the class of bug
 * these tests exist for — output reaching the job log.
 */
function emit(res: RunResult, options?: RunOptions): RunResult {
  if (options?.onLine) {
    for (const line of `${res.stdout}\n${res.stderr}`.split("\n")) {
      if (line) options.onLine(line);
    }
  }
  return res;
}

function harness(scenario: Scenario = {}) {
  const dockerCalls: string[][] = [];
  const dockerOptions: (RunOptions | undefined)[] = [];
  const gitCalls: string[][] = [];
  let pulled = false;
  let rolledBack = false;
  let clock = 0;

  const deps: UpdateDeps = {
    async docker(args, options) {
      dockerCalls.push(args);
      dockerOptions.push(options);
      // Every argv the production code emits is held to the real guard.
      assertSafeDockerArgs(args, PROJECT);
      return emit(dockerResult(args), options);
    },
    async git(args, options) {
      gitCalls.push(args);
      return emit(gitResult(args), options);
    },
    async probeHealth() {
      // Once the checkout has been reset back we are on the restore path, so
      // the health answer is about the OLD version coming back, not the new one.
      if (rolledBack) return scenario.healthyAfterRollback ?? true;
      return scenario.healthy ?? true;
    },
    async sleep() {},
    now() {
      const value = new Date(clock);
      clock += 2_000;
      return value;
    },
  };

  function dockerResult(args: string[]): RunResult {
      if (args.includes("config")) {
        // A compose file that fails validation can still have printed part of
        // the resolved model first.
        if (pulled && scenario.configFailsAfterPull) {
          return { code: 1, stdout: COMPOSE_CONFIG, stderr: "services.lokyy-brain.build: invalid type", timedOut: false };
        }
        return ok(COMPOSE_CONFIG);
      }
      if (args.includes("ps")) {
        return ok(pulled && scenario.psAfterSwitch !== undefined ? scenario.psAfterSwitch : PS_RUNNING);
      }
      if (args[0] === "inspect") {
        const service = args[args.length - 1] === "c-brain" ? "lokyy-brain" : "lokyy-pwa";
        return ok(JSON.stringify({ Image: `sha256:old-${service}`, Config: { Image: `${PROJECT}-${service}` } }));
      }
      if (args[0] === "image") return ok("sha256:old");
      if (args[0] === "tag") return ok();
      if (args.includes("build")) return scenario.buildFails ? bad("build failed: syntax error") : ok();
      if (args.includes("up")) return scenario.upFails ? bad("up failed") : ok();
      return ok();
  }

  function gitResult(args: string[]): RunResult {
      const [verb] = args;
      if (verb === "status") return ok(scenario.dirty ?? "");
      // `git diff --ignore-space-at-eol --quiet`: exit 1 = real content diff,
      // exit 0 = no content diff (dirtiness was line-ending-only).
      if (verb === "diff") return scenario.contentDiff ? bad() : ok();
      if (verb === "checkout") return ok();
      if (verb === "rev-parse" && args[1] === "--abbrev-ref") return ok("main");
      if (verb === "rev-parse") return ok(pulled ? NEW_SHA : OLD_SHA);
      if (verb === "fetch") return scenario.fetchFails ? bad("could not resolve host") : ok();
      if (verb === "rev-list") return ok(`${scenario.ahead ?? 0}\t${scenario.behind ?? 1}`);
      if (verb === "pull") {
        if (scenario.pullFails) return bad("not a fast-forward");
        pulled = true;
        return ok();
      }
      if (verb === "reset") {
        if (pulled) rolledBack = true;
        pulled = false;
        return ok();
      }
      return ok();
  }

  const job = new UpdateJob("job-1", PROJECT, config.logTailLines, new Date(0));
  return { job, deps, dockerCalls, dockerOptions, gitCalls, run: () => runUpdate(job, identity, config, deps) };
}

const flat = (calls: string[][]) => calls.map((c) => c.join(" "));

describe("the happy path", () => {
  it("pulls, builds, switches, verifies — in that order", async () => {
    const h = harness();
    const snapshot = await h.run();

    expect(snapshot.result).toBe("success");
    const order = flat(h.dockerCalls);
    const buildAt = order.findIndex((c) => c.includes(" build "));
    const upAt = order.findIndex((c) => c.includes(" up "));
    const pullAt = flat(h.gitCalls).findIndex((c) => c.startsWith("pull"));
    expect(pullAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(upAt).toBeGreaterThan(buildAt);
  });

  it("never rebuilds or restarts itself", async () => {
    const h = harness();
    await h.run();
    for (const args of h.dockerCalls) {
      if (args.includes("build") || args.includes("up")) {
        expect(args, `updater restarted itself: docker ${args.join(" ")}`).not.toContain("lokyy-updater");
      }
    }
  });

  it("leaves the pinned stateful services alone", async () => {
    const h = harness();
    await h.run();
    for (const args of h.dockerCalls) {
      if (args.includes("build") || args.includes("up")) expect(args).not.toContain("postgres");
    }
  });

  it("emits no destructive command anywhere (AC#9)", async () => {
    const h = harness();
    await h.run();
    for (const args of h.dockerCalls) {
      for (const token of forbiddenTokens().keys()) {
        expect(args, `docker ${args.join(" ")}`).not.toContain(token);
      }
    }
  });
});

describe("aborts that must not touch anything", () => {
  it("aborts on a dirty working copy with real edits", async () => {
    const h = harness({ dirty: " M server/src/index.ts\n", contentDiff: true });
    const snapshot = await h.run();

    expect(snapshot.result).toBe("aborted");
    expect(snapshot.message).toMatch(/local changes/);
    expect(flat(h.gitCalls).some((c) => c.startsWith("pull"))).toBe(false);
    expect(flat(h.gitCalls).some((c) => c.startsWith("reset"))).toBe(false);
    expect(flat(h.gitCalls).some((c) => c.startsWith("checkout"))).toBe(false);
    expect(flat(h.dockerCalls).some((c) => c.includes(" build ") || c.includes(" up "))).toBe(false);
  });

  it("aborts when the branch has diverged, leaving the user's commits alone", async () => {
    const h = harness({ ahead: 3, behind: 2 });
    const snapshot = await h.run();

    expect(snapshot.result).toBe("aborted");
    expect(snapshot.message).toMatch(/diverged/);
    expect(flat(h.gitCalls).some((c) => c.startsWith("pull"))).toBe(false);
    expect(flat(h.gitCalls).some((c) => c.startsWith("reset"))).toBe(false);
  });

  it("aborts when the remote is unreachable", async () => {
    const h = harness({ fetchFails: true });
    const snapshot = await h.run();
    expect(snapshot.result).toBe("aborted");
    expect(flat(h.dockerCalls).some((c) => c.includes(" build "))).toBe(false);
  });

  it("reports already-up-to-date without building anything", async () => {
    const h = harness({ behind: 0 });
    const snapshot = await h.run();
    expect(snapshot.result).toBe("already-up-to-date");
    expect(flat(h.dockerCalls).some((c) => c.includes(" build "))).toBe(false);
  });
});

describe("a CRLF-only dirty working copy must not block the update (Windows, #49)", () => {
  it("discards the line-ending noise and updates anyway", async () => {
    const h = harness({ dirty: " M server/src/index.ts\n M pwa/src/App.tsx\n", contentDiff: false });
    const snapshot = await h.run();

    expect(snapshot.result).toBe("success");
    // The line-ending differences were checked (diff --ignore-space-at-eol) and
    // then discarded (checkout -- .) before the pull.
    expect(h.gitCalls).toContainEqual(["diff", "--ignore-space-at-eol", "--quiet"]);
    expect(h.gitCalls).toContainEqual(["checkout", "--", "."]);
    expect(flat(h.gitCalls).some((c) => c.startsWith("pull"))).toBe(true);
    expect(snapshot.log.join("\n")).toMatch(/line ending/i);
  });

  it("still aborts when the dirtiness includes real content, not just line endings", async () => {
    const h = harness({ dirty: " M server/src/index.ts\n", contentDiff: true });
    const snapshot = await h.run();

    expect(snapshot.result).toBe("aborted");
    expect(snapshot.message).toMatch(/local changes/);
    expect(flat(h.gitCalls).some((c) => c.startsWith("checkout"))).toBe(false);
    expect(flat(h.gitCalls).some((c) => c.startsWith("pull"))).toBe(false);
  });

  it("aborts when the dirtiness includes untracked files, even with clean diffs", async () => {
    const h = harness({ dirty: "?? server/src/new-thing.ts\n", contentDiff: false });
    const snapshot = await h.run();

    expect(snapshot.result).toBe("aborted");
    expect(snapshot.message).toMatch(/local changes/);
    // Untracked content is never line-ending noise — nothing gets discarded.
    expect(flat(h.gitCalls).some((c) => c.startsWith("checkout"))).toBe(false);
    expect(flat(h.gitCalls).some((c) => c.startsWith("pull"))).toBe(false);
  });

  it("leaves a clean working copy completely untouched (no diff probe, no checkout)", async () => {
    const h = harness();
    await h.run();

    expect(flat(h.gitCalls).some((c) => c.startsWith("diff"))).toBe(false);
    expect(flat(h.gitCalls).some((c) => c.startsWith("checkout"))).toBe(false);
  });
});

describe("a failed build must not touch the running stack (AC#8a)", () => {
  it("never reaches `up` and puts the checkout back", async () => {
    const h = harness({ buildFails: true });
    const snapshot = await h.run();

    expect(snapshot.result).toBe("build-failed");
    expect(flat(h.dockerCalls).some((c) => c.includes(" up "))).toBe(false);
    expect(h.gitCalls).toContainEqual(["reset", "--hard", OLD_SHA]);
    expect(snapshot.message).toMatch(/not touched/);
  });

  it("hands the build log back to the caller", async () => {
    const h = harness({ buildFails: true });
    const snapshot = await h.run();
    expect(snapshot.message).toMatch(/syntax error/);
  });
});

describe("an unhealthy switch must roll back (AC#8b)", () => {
  it("restores the recorded image IDs, resets the commit and starts again", async () => {
    const h = harness({ healthy: false });
    const snapshot = await h.run();

    expect(snapshot.result).toBe("rolled-back");
    expect(h.gitCalls).toContainEqual(["reset", "--hard", OLD_SHA]);
    expect(h.dockerCalls).toContainEqual(["tag", "sha256:old-lokyy-brain", `${PROJECT}-lokyy-brain`]);
    expect(h.dockerCalls).toContainEqual(["tag", "sha256:old-lokyy-pwa", `${PROJECT}-lokyy-pwa`]);

    const ups = flat(h.dockerCalls).filter((c) => c.includes(" up "));
    expect(ups.length).toBe(2); // the switch, then the restore
    expect(ups.at(-1)).toContain("--no-deps");
  });

  it("rolls back when a service is not running afterwards", async () => {
    const h = harness({ psAfterSwitch: '{"ID":"c-brain","Service":"lokyy-brain","State":"exited"}' });
    const snapshot = await h.run();
    expect(snapshot.result).toBe("rolled-back");
    expect(snapshot.message).toMatch(/not touched|untouched/);
  });

  it("rolls back when `up` itself fails", async () => {
    const h = harness({ upFails: true });
    const snapshot = await h.run();
    expect(snapshot.result).toBe("rolled-back");
  });

  it("reports the previous version as restored when it comes back healthy", async () => {
    const h = harness({ healthy: false, healthyAfterRollback: true });
    const snapshot = await h.run();
    expect(snapshot.result).toBe("rolled-back");
    expect(snapshot.message).toMatch(/previous version was restored/);
  });

  it("says out loud that a database migration is not undone — on both outcomes", async () => {
    for (const healthyAfterRollback of [true, false]) {
      const h = harness({ healthy: false, healthyAfterRollback });
      const snapshot = await h.run();
      expect(snapshot.message, `healthyAfterRollback=${healthyAfterRollback}`).toMatch(/migration/i);
      expect(snapshot.message).toMatch(/no volume was ever removed/);
    }
  });
});

describe("the resolved compose config must never reach the job log", () => {
  // `docker compose config` prints every environment value in plain text, and
  // the job log is rendered verbatim in the admin UI. Streaming that output into
  // the log publishes the updater token and the database password to a web page.
  const secrets = Object.entries(COMPOSE_SECRETS);
  const carries = (snapshot: { log: string[]; message?: string }) =>
    `${snapshot.log.join("\n")}\n${snapshot.message ?? ""}`;

  it("keeps every compose environment value out of a successful job", async () => {
    const h = harness();
    const snapshot = await h.run();

    expect(snapshot.result).toBe("success");
    for (const [name, secret] of secrets) {
      expect(carries(snapshot), `job leaked ${name}`).not.toContain(secret);
    }
  });

  it("keeps them out when the pulled compose file is rejected", async () => {
    const h = harness({ configFailsAfterPull: true });
    const snapshot = await h.run();

    expect(snapshot.result).toBe("aborted");
    // The operator still gets the actual reason — only the payload is withheld.
    expect(snapshot.message).toMatch(/invalid type/);
    for (const [name, secret] of secrets) {
      expect(carries(snapshot), `job leaked ${name}`).not.toContain(secret);
    }
  });

  it("never gives a `compose config` call a log sink", async () => {
    const h = harness();
    await h.run();

    h.dockerCalls.forEach((args, i) => {
      if (!args.includes("config")) return;
      expect(h.dockerOptions[i]?.onLine, `docker ${args.join(" ")} streams into the job log`).toBeUndefined();
    });
  });
});

describe("parseComposeJson", () => {
  it("reads JSON lines", () => {
    expect(parseComposeJson('{"a":1}\n{"a":2}')).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it("reads a JSON array", () => {
    expect(parseComposeJson('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it("survives noise", () => {
    expect(parseComposeJson("warning: something\n{\"a\":1}")).toEqual([{ a: 1 }]);
  });
});
