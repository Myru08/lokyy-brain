import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import micromatch from "micromatch";
import { currentMcpSession, type McpSessionRole } from "./sessionContext.js";

/**
 * MCP Scope Resolver (Story 7.2).
 *
 * Reads `<vault>/00_meta/mcp-scopes.yaml` at server startup. File shape:
 *
 *   agents:
 *     claude-desktop:
 *       read_globs: ["**\/*.md"]
 *       write_globs: ["30_captures/**", "70_pai/interventions/**"]
 *       commit_prefix: "[agent:claude]"
 *     consolidation:
 *       read_globs: ["**\/*.md"]
 *       write_globs: ["70_pai/interventions/**"]
 *       commit_prefix: "[agent:consolidation]"
 *
 * Missing agent → default-deny. Missing/invalid file → server refuses to
 * start (logs a clear error).
 */

export interface AgentScope {
  readGlobs: string[];
  writeGlobs: string[];
  commitPrefix: string;
}

// Fallback when no mcp-scopes.yaml exists OR the connecting agent isn't declared.
// Read+write to all markdown: the MCP bearer token is the gatekeeper (single-
// tenant / shared-vault default). Lock this down with an explicit mcp-scopes.yaml
// (per-agent read/write globs) for multi-agent / multi-tenant isolation.
const FALLBACK_SCOPE: AgentScope = {
  readGlobs: ["**/*.md"],
  writeGlobs: ["**/*.md"],
  commitPrefix: "[agent:lokyy]",
};

let agents = new Map<string, AgentScope>();
let activeAgent: string = "unknown";

/**
 * Read + parse `<vault>/00_meta/mcp-scopes.yaml` into an agent→scope map.
 * Returns `null` when the file is absent (caller decides the fallback).
 * Supports both the lokyy-vault SPEC shape (`scopes:`) and the legacy
 * `agents:` shape.
 */
async function readScopeMap(vaultDir: string): Promise<Map<string, AgentScope> | null> {
  const path = join(vaultDir, "00_meta", "mcp-scopes.yaml");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new Error(`[mcp] mcp-scopes.yaml invalid YAML: ${(err as Error).message}`);
  }

  // Support both shapes:
  //  A) lokyy-vault SPEC: `scopes: { <agent>: { read: [...], write: [...], commit_prefix: "x:" } }`
  //  B) older internal: `agents: { <agent>: { read_globs: [...], write_globs: [...], commit_prefix: "x:" } }`
  const root = doc as {
    scopes?: Record<string, unknown>;
    agents?: Record<string, unknown>;
  };
  const source = root.scopes ?? root.agents;
  if (!source) {
    throw new Error("[mcp] mcp-scopes.yaml missing top-level `scopes:` (or legacy `agents:`) map.");
  }

  const map = new Map<string, AgentScope>();
  for (const [name, entryRaw] of Object.entries(source)) {
    const e = entryRaw as {
      read?: string[];
      write?: string[];
      read_globs?: string[];
      write_globs?: string[];
      commit_prefix?: string;
    };
    map.set(name, {
      readGlobs: e.read ?? e.read_globs ?? [],
      writeGlobs: e.write ?? e.write_globs ?? [],
      commitPrefix: e.commit_prefix ?? `[agent:${name}]`,
    });
  }
  return map;
}

/**
 * Boot-time singleton scope load (legacy single-vault path). Sets the
 * module-level `activeAgent`/`agents` that the accessors fall back to when no
 * per-request session is active (`currentMcpSession()` null). Missing file or
 * undeclared agent → read+write fallback (the bearer token is the gatekeeper).
 */
export async function loadScopes(vaultDir: string, agentId: string): Promise<AgentScope> {
  const map = await readScopeMap(vaultDir);
  if (!map) {
    console.warn(
      `[mcp] no mcp-scopes.yaml at ${join(vaultDir, "00_meta", "mcp-scopes.yaml")} — falling back to read+write "**/*.md" for agent "${agentId}".`,
    );
    activeAgent = agentId;
    agents = new Map([[agentId, FALLBACK_SCOPE]]);
    return FALLBACK_SCOPE;
  }
  agents = map;
  activeAgent = agentId;
  const scope = agents.get(agentId);
  if (!scope) {
    // Undeclared agent → read+write fallback instead of hard-failing, so a
    // vault whose scopes file predates this agent-id still works.
    console.warn(
      `[mcp] agent "${agentId}" not declared in mcp-scopes.yaml — using read+write fallback.`,
    );
    agents.set(agentId, FALLBACK_SCOPE);
    return FALLBACK_SCOPE;
  }
  return scope;
}

/**
 * Apply a token's role to a declared scope (LBMT-1.3):
 *   - `owner` → full, unscoped (`**\/*.md` read+write). The operator's own MCP.
 *   - `read`  → read-only: keep readGlobs, drop ALL write.
 *   - `write` → as declared (read + write globs).
 */
export function applyRoleGate(scope: AgentScope, role: McpSessionRole): AgentScope {
  if (role === "owner") {
    return { readGlobs: ["**/*.md"], writeGlobs: ["**/*.md"], commitPrefix: scope.commitPrefix };
  }
  if (role === "read") {
    return { ...scope, writeGlobs: [] };
  }
  return scope;
}

/**
 * Resolve the effective scope for a per-request session: load the vault's
 * declared globs for `agentId` (read+write fallback when file/agent absent),
 * then apply the token `role` gate. Does NOT touch the boot singleton, so
 * concurrent requests for different vaults never clobber each other.
 */
export async function resolveScopeFor(
  vaultDir: string,
  agentId: string,
  role: McpSessionRole,
): Promise<AgentScope> {
  const map = await readScopeMap(vaultDir);
  const declared = map?.get(agentId) ?? FALLBACK_SCOPE;
  return applyRoleGate(declared, role);
}

export function activeScope(): AgentScope {
  // Per-request session (multi-tenant) wins over the boot singleton; legacy
  // single-vault path (no session) falls back to the module-level state.
  const session = currentMcpSession();
  if (session) return session.scope;
  return agents.get(activeAgent) ?? FALLBACK_SCOPE;
}

export function canRead(path: string): boolean {
  return micromatch.isMatch(path, activeScope().readGlobs);
}

export function canWrite(path: string): boolean {
  return micromatch.isMatch(path, activeScope().writeGlobs);
}

export class ScopeViolation extends Error {
  constructor(public readonly action: "read" | "write", public readonly path: string) {
    super(
      `Agent "${currentMcpSession()?.agentId ?? activeAgent}" cannot ${action} path "${path}"`,
    );
    this.name = "ScopeViolation";
  }
}
