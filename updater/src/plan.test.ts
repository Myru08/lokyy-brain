import { describe, expect, it } from "vitest";
import { assertSafeDockerArgs, forbiddenTokens } from "./guard.js";
import { composeUpArgs, fullGitPlan, fullUpdatePlan, selectTargetServices } from "./plan.js";

const input = {
  project: "my-lokyy-folder",
  composeFiles: ["/repo/docker-compose.local.yml"],
  targetServices: ["lokyy-brain", "lokyy-mcp", "lokyy-pwa"],
  rollbackImages: [
    { imageId: "sha256:aaa", imageRef: "my-lokyy-folder-lokyy-brain" },
    { imageId: "sha256:bbb", imageRef: "my-lokyy-folder-lokyy-pwa" },
  ],
};

describe("the complete command surface of an update (AC#9)", () => {
  const plan = fullUpdatePlan(input);

  it("emits no destructive token on any path, including rollback", () => {
    const forbidden = [...forbiddenTokens().keys()];
    for (const args of plan) {
      for (const token of forbidden) {
        expect(args, `"${token}" appeared in: docker ${args.join(" ")}`).not.toContain(token);
      }
    }
  });

  it("passes the guard on every single command", () => {
    for (const args of plan) {
      expect(() => assertSafeDockerArgs(args, input.project)).not.toThrow();
    }
  });

  it("never addresses a project other than the resolved one", () => {
    for (const args of plan) {
      if (args[0] !== "compose") continue;
      expect(args).toContain("-p");
      expect(args[args.indexOf("-p") + 1]).toBe(input.project);
    }
  });

  it("builds before it switches", () => {
    const buildAt = plan.findIndex((args) => args.includes("build"));
    const upAt = plan.findIndex((args) => args.includes("up"));
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(upAt).toBeGreaterThan(buildAt);
  });

  it("keeps `up` scoped to the listed services", () => {
    expect(composeUpArgs(input, input.targetServices)).toEqual([
      "compose",
      "-p",
      "my-lokyy-folder",
      "-f",
      "/repo/docker-compose.local.yml",
      "up",
      "-d",
      "--no-deps",
      "lokyy-brain",
      "lokyy-mcp",
      "lokyy-pwa",
    ]);
  });

  it("never runs a git command that discards work beyond the recorded commit", () => {
    const gitPlan = fullGitPlan("abc123", "origin", "main");
    for (const args of gitPlan) {
      expect(args).not.toContain("clean");
      expect(args).not.toContain("push");
      if (args[0] === "reset") expect(args).toEqual(["reset", "--hard", "abc123"]);
    }
  });
});

describe("selectTargetServices", () => {
  const config = {
    services: {
      "lokyy-brain": { build: { context: "." } },
      "lokyy-pwa": { build: { context: "." } },
      "lokyy-updater": { build: { context: "." } },
      postgres: { image: "paradedb/paradedb:latest-pg17" },
      forgejo: { image: "codeberg.org/forgejo/forgejo:9" },
    },
  };

  it("excludes itself — recreating the updater would kill the running job", () => {
    expect(selectTargetServices(config, "lokyy-updater")).toEqual(["lokyy-brain", "lokyy-pwa"]);
  });

  it("leaves stateful pinned-image services alone", () => {
    const selected = selectTargetServices(config, "lokyy-updater");
    expect(selected).not.toContain("postgres");
    expect(selected).not.toContain("forgejo");
  });

  it("returns nothing when the compose model has no buildable services", () => {
    expect(selectTargetServices({ services: { postgres: { image: "x" } } }, "lokyy-updater")).toEqual([]);
    expect(selectTargetServices({}, "lokyy-updater")).toEqual([]);
  });
});
