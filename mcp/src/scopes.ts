import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import micromatch from "micromatch";

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

export async function loadScopes(vaultDir: string, agentId: string): Promise<AgentScope> {
  const path = join(vaultDir, "00_meta", "mcp-scopes.yaml");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    console.warn(
      `[mcp] no mcp-scopes.yaml at ${path} — falling back to read-only "**\/*.md" for agent "${agentId}".`,
    );
    activeAgent = agentId;
    agents.set(agentId, FALLBACK_SCOPE);
    return FALLBACK_SCOPE;
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

  agents = new Map();
  for (const [name, entryRaw] of Object.entries(source)) {
    const e = entryRaw as {
      read?: string[];
      write?: string[];
      read_globs?: string[];
      write_globs?: string[];
      commit_prefix?: string;
    };
    agents.set(name, {
      readGlobs: e.read ?? e.read_globs ?? [],
      writeGlobs: e.write ?? e.write_globs ?? [],
      commitPrefix: e.commit_prefix ?? `[agent:${name}]`,
    });
  }

  activeAgent = agentId;
  const scope = agents.get(agentId);
  if (!scope) {
    // Undeclared agent → use the read+write fallback instead of hard-failing,
    // so a vault whose scopes file predates this agent-id still works. Register
    // it so activeScope()/canWrite() resolve consistently.
    console.warn(
      `[mcp] agent "${agentId}" not declared in mcp-scopes.yaml — using read+write fallback.`,
    );
    agents.set(agentId, FALLBACK_SCOPE);
    return FALLBACK_SCOPE;
  }
  return scope;
}

export function activeScope(): AgentScope {
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
    super(`Agent "${activeAgent}" cannot ${action} path "${path}"`);
    this.name = "ScopeViolation";
  }
}
