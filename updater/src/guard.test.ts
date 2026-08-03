import { describe, expect, it } from "vitest";
import {
  assertSafeDockerArgs,
  extractComposeSubcommand,
  extractProjectNames,
  UnsafeCommandError,
} from "./guard.js";

const PROJECT = "lokyy-brain";
const FILE = "/repo/docker-compose.local.yml";
const base = ["compose", "-p", PROJECT, "-f", FILE];

describe("assertSafeDockerArgs — commands that must never be possible (AC#9)", () => {
  it.each([
    ["compose down", [...base, "down"]],
    ["compose down -v", [...base, "down", "-v"]],
    ["compose down --volumes", [...base, "down", "--volumes"]],
    ["compose up --remove-orphans", [...base, "up", "-d", "--no-deps", "--remove-orphans"]],
    ["compose rm", [...base, "rm"]],
    ["volume rm", ["volume", "rm", "lokyy-brain_postgres-data"]],
    ["volume prune", ["volume", "prune", "-f"]],
    ["system prune", ["system", "prune", "-a"]],
    ["image rm", ["image", "rm", "sha256:abc"]],
    ["rmi", ["rmi", "sha256:abc"]],
    ["builder prune", ["builder", "prune"]],
    ["compose up --renew-anon-volumes", [...base, "up", "-d", "--no-deps", "--renew-anon-volumes"]],
  ])("refuses %s", (_label, args) => {
    expect(() => assertSafeDockerArgs(args, PROJECT)).toThrow(UnsafeCommandError);
  });

  it("refuses a compose call that carries no project name at all", () => {
    // Without -p, compose derives the project from the working directory, which
    // inside this container is /repo — a name that has nothing to do with the
    // user's stack. That is how a second stack on empty volumes gets created.
    expect(() => assertSafeDockerArgs(["compose", "-f", FILE, "up", "-d", "--no-deps"], PROJECT)).toThrow(
      /without an explicit -p/,
    );
  });

  it.each([
    ["a different project", [...base.slice(0, 2), "lokyy-brain-2", "-f", FILE, "ps"]],
    ["--project-name=other", ["compose", "--project-name=other", "-f", FILE, "ps"]],
  ])("refuses %s", (_label, args) => {
    expect(() => assertSafeDockerArgs(args, PROJECT)).toThrow(/does not match the resolved project/);
  });

  it("refuses an unusable project name even when the command itself is fine", () => {
    expect(() => assertSafeDockerArgs([...base, "ps"], "")).toThrow(/unusable project name/);
  });

  it("refuses verbs outside the allowlist", () => {
    expect(() => assertSafeDockerArgs(["exec", "-i", "c", "sh"], PROJECT)).toThrow(/not on the allowlist/);
    expect(() => assertSafeDockerArgs(["run", "--privileged", "alpine"], PROJECT)).toThrow(/not on the allowlist/);
  });

  it("refuses compose subcommands outside the allowlist", () => {
    expect(() => assertSafeDockerArgs([...base, "kill"], PROJECT)).toThrow(/not on the allowlist/);
    expect(() => assertSafeDockerArgs([...base, "restart"], PROJECT)).toThrow(/not on the allowlist/);
  });

  it("requires up to be detached and scoped with --no-deps", () => {
    expect(() => assertSafeDockerArgs([...base, "up", "-d"], PROJECT)).toThrow(/--no-deps/);
    expect(() => assertSafeDockerArgs([...base, "up", "--no-deps"], PROJECT)).toThrow(/detached/);
  });
});

describe("assertSafeDockerArgs — commands the update actually needs", () => {
  it.each([
    ["config", [...base, "config", "--format", "json"]],
    ["ps", [...base, "ps", "--format", "json", "--all", "lokyy-brain"]],
    ["build", [...base, "build", "lokyy-brain", "lokyy-pwa"]],
    ["up", [...base, "up", "-d", "--no-deps", "lokyy-brain", "lokyy-pwa"]],
    ["inspect", ["inspect", "--type", "container", "--format", "{{json .}}", "abc123"]],
    ["image inspect", ["image", "inspect", "--format", "{{.Id}}", "sha256:abc"]],
    ["tag", ["tag", "sha256:abc", "lokyy-brain-lokyy-brain"]],
  ])("allows %s", (_label, args) => {
    expect(() => assertSafeDockerArgs(args, PROJECT)).not.toThrow();
  });
});

describe("argv parsing helpers", () => {
  it("finds project names in every spelling", () => {
    expect(extractProjectNames(["compose", "-p", "a", "ps"])).toEqual(["a"]);
    expect(extractProjectNames(["compose", "--project-name", "b", "ps"])).toEqual(["b"]);
    expect(extractProjectNames(["compose", "--project-name=c", "ps"])).toEqual(["c"]);
  });

  it("does not mistake an option value for the subcommand", () => {
    // "-f build" would make a naive parser believe the subcommand is "build".
    expect(extractComposeSubcommand(["compose", "-p", "up", "-f", "build", "ps"])).toBe("ps");
  });
});
