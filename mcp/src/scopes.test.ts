import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canRead,
  canWrite,
  applyRoleGate,
  resolveScopeFor,
  type AgentScope,
} from "./scopes.js";
import { withMcpSession, type McpSession } from "./sessionContext.js";

const SCOPE: AgentScope = {
  readGlobs: ["Freigabe/**", "RAW/kunde/**"],
  writeGlobs: ["RAW/kunde/**"],
  commitPrefix: "[agent:kunde-x]",
};

const session = (scope: AgentScope): McpSession => ({
  vaultId: "vaultA",
  vaultDir: "/tmp/vaultA",
  agentId: "kunde-x",
  role: "write",
  scope,
});

describe("applyRoleGate (LBMT-1.3)", () => {
  it("owner → full unscoped read+write", () => {
    const s = applyRoleGate(SCOPE, "owner");
    expect(s.readGlobs).toEqual(["**/*.md"]);
    expect(s.writeGlobs).toEqual(["**/*.md"]);
  });

  it("read → keeps read globs, drops ALL write", () => {
    const s = applyRoleGate(SCOPE, "read");
    expect(s.readGlobs).toEqual(["Freigabe/**", "RAW/kunde/**"]);
    expect(s.writeGlobs).toEqual([]);
  });

  it("write → unchanged (as declared)", () => {
    expect(applyRoleGate(SCOPE, "write")).toEqual(SCOPE);
  });
});

describe("canRead/canWrite honor the per-request session scope", () => {
  it("filters reads + writes to the session's globs", () => {
    withMcpSession(session(SCOPE), () => {
      // visible
      expect(canRead("Freigabe/notiz.md")).toBe(true);
      expect(canRead("RAW/kunde/inbox.md")).toBe(true);
      // hidden — the customer must NOT see these
      expect(canRead("Wiki/intern.md")).toBe(false);
      expect(canRead("RAW/intern/geheim.md")).toBe(false);
      // writes only into the customer area
      expect(canWrite("RAW/kunde/inbox.md")).toBe(true);
      expect(canWrite("Freigabe/notiz.md")).toBe(false);
      expect(canWrite("Wiki/intern.md")).toBe(false);
    });
  });

  it("a read-role session can read its folders but write nothing", () => {
    withMcpSession(session(applyRoleGate(SCOPE, "read")), () => {
      expect(canRead("Freigabe/notiz.md")).toBe(true);
      expect(canWrite("RAW/kunde/inbox.md")).toBe(false);
      expect(canWrite("Freigabe/notiz.md")).toBe(false);
    });
  });

  it("nested sessions resolve to the innermost scope, then unwind", () => {
    const owner = session(applyRoleGate(SCOPE, "owner"));
    withMcpSession(owner, () => {
      expect(canWrite("Wiki/intern.md")).toBe(true); // owner sees all
      withMcpSession(session(SCOPE), () => {
        expect(canWrite("Wiki/intern.md")).toBe(false); // scoped customer
      });
      expect(canWrite("Wiki/intern.md")).toBe(true); // back to owner
    });
  });
});

describe("resolveScopeFor — load vault globs + apply role", () => {
  async function tmpVaultWithScopes(yaml: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "lokyy-scopes-"));
    await mkdir(join(dir, "00_meta"), { recursive: true });
    await writeFile(join(dir, "00_meta", "mcp-scopes.yaml"), yaml, "utf8");
    return dir;
  }

  const YAML = `scopes:
  kunde-x:
    read: ["Freigabe/**", "RAW/kunde/**"]
    write: ["RAW/kunde/**"]
    commit_prefix: "[agent:kunde-x]"
`;

  it("loads declared globs for a write-role token", async () => {
    const dir = await tmpVaultWithScopes(YAML);
    const s = await resolveScopeFor(dir, "kunde-x", "write");
    expect(s.readGlobs).toEqual(["Freigabe/**", "RAW/kunde/**"]);
    expect(s.writeGlobs).toEqual(["RAW/kunde/**"]);
  });

  it("read-role drops write even when globs are declared", async () => {
    const dir = await tmpVaultWithScopes(YAML);
    const s = await resolveScopeFor(dir, "kunde-x", "read");
    expect(s.writeGlobs).toEqual([]);
  });

  it("undeclared agent → read+write fallback", async () => {
    const dir = await tmpVaultWithScopes(YAML);
    const s = await resolveScopeFor(dir, "fremder-agent", "write");
    expect(s.readGlobs).toEqual(["**/*.md"]);
    expect(s.writeGlobs).toEqual(["**/*.md"]);
  });

  it("missing scopes file + owner role → full access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lokyy-noscopes-"));
    const s = await resolveScopeFor(dir, "owner-agent", "owner");
    expect(s.readGlobs).toEqual(["**/*.md"]);
    expect(s.writeGlobs).toEqual(["**/*.md"]);
  });
});
