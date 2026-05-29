#!/usr/bin/env node
/**
 * lokyy-mcp setup — interaktiver Installer.
 *
 * Erkennt welche AI-Clients lokal installiert sind, patched ihre Configs
 * automatisch wo möglich, und gibt für Clients ohne automatische Anbindung
 * copy-pasteable System-Prompts + JSON-Snippets aus.
 *
 * Usage:
 *   lokyy-mcp setup                # interaktiv mit Y/N prompts
 *   lokyy-mcp setup --auto         # ohne prompts alles patchen wo möglich
 *   lokyy-mcp setup --client=cursor    # nur einen Client targeten
 *   lokyy-mcp setup --print-prompt     # nur den System-Prompt ausgeben (kein patching)
 *
 * Was es macht:
 *   - Claude Code:    `~/.claude.json` patchen + CLAUDE.md addendum vorschlagen
 *   - Claude Desktop: `claude_desktop_config.json` patchen (macOS / Linux Pfad)
 *   - Cursor:         `~/.cursor/mcp.json` patchen
 *   - Continue.dev:   `~/.continue/config.json` patchen
 *   - claude.ai:      Custom-Connector-Snippet ausgeben (UI-Action nötig)
 *   - ChatGPT:        Custom-GPT-Instructions ausgeben (Action-Schema-Hinweis)
 *   - Gemini Apps:    System-Prompt ausgeben (manuelles Einfügen pro Chat)
 *   - generic:        plain text System-Prompt für jeden anderen Client
 *
 * Erstellt + überschreibt KEINE Config ohne Bestätigung (außer --auto).
 * Schreibt Backups vor jedem Patch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ─── Vault-provisioning guard (Story 10.13, AC#3) ──────────────────────────
//
// NOTE ON WHERE VAULT ROWS ARE ACTUALLY CREATED:
//   This file (`mcp/src/setup.ts`) is a CLIENT-CONFIG patcher only — it never
//   touches the DB. The `vaults` table is written in two SERVER-owned routes
//   (out of this agent's file ownership):
//     • server/src/routes/auth.ts:106    — autoProvisionPersonalVault() on
//                                           user creation (slug `personal-…`)
//     • server/src/routes/setup.ts:242   — POST /api/setup/vault (guarded by
//                                           isSetupComplete())
//   The `vaults.slug` column is already UNIQUE at the DB level, so a duplicate
//   *slug* is rejected outright. The residual hazard is two rows with
//   different slugs that point at the SAME git remote (the real "identifier"
//   of a vault). The helper below is the reusable, DB-free idempotency check
//   the provisioning paths SHOULD consult before inserting. It lives here so
//   the guard logic is testable and colocated with the setup story; wiring it
//   into the server insert sites is a follow-up owned by the server agent.

/** A pre-existing vault row, as the guard sees it. */
export interface ExistingVault {
  id: string;
  slug: string;
  gitRemote: string;
}

/** Decision returned by {@link guardVaultProvision}. */
export type VaultProvisionDecision =
  | { action: "create" }
  | { action: "reuse"; vaultId: string; reason: "slug" | "git-remote" };

/**
 * Normalize a git remote so cosmetic differences (trailing slash, `.git`
 * suffix, case) don't defeat the idempotency check.
 */
export function normalizeGitRemote(remote: string): string {
  return remote
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "") // drop trailing slash(es) first…
    .replace(/\.git$/, "") // …so a `repo.git/` suffix collapses to `repo`
    .replace(/\/+$/, ""); // and tidy any slash left exposed by the `.git` strip
}

/**
 * Idempotent vault-provisioning guard (AC#3).
 *
 * Given the vaults that already exist and the identifier of the vault about to
 * be created, decide whether to CREATE a new row or REUSE an existing one.
 * A match on `slug` (the DB's unique key) or on a non-empty, normalized
 * `gitRemote` (the logical vault identifier) means "reuse" — preventing a
 * second row for what is really the same vault.
 *
 * Pure + DB-free so the provisioning routes can call it right before their
 * `insert(vaults)` and so it is unit-testable.
 */
export function guardVaultProvision(
  existing: ExistingVault[],
  desired: { slug: string; gitRemote: string },
): VaultProvisionDecision {
  const slug = desired.slug.trim();
  const bySlug = existing.find((v) => v.slug === slug);
  if (bySlug) {
    return { action: "reuse", vaultId: bySlug.id, reason: "slug" };
  }

  const wantRemote = normalizeGitRemote(desired.gitRemote);
  if (wantRemote) {
    const byRemote = existing.find((v) => normalizeGitRemote(v.gitRemote) === wantRemote);
    if (byRemote) {
      return { action: "reuse", vaultId: byRemote.id, reason: "git-remote" };
    }
  }

  return { action: "create" };
}

// ─── Lokyy-Brain canonical AI usage prompt ─────────────────────────────────
// This is the SAME text the MCP server sends as `initialize.instructions`.
// Used here for clients that don't auto-inject the MCP instructions field.
const LOKYY_BRAIN_SYSTEM_PROMPT = `You have access to Lokyy-Brain — the user's personal knowledge vault (git-backed, SPEC-compliant Markdown notes). Use it actively:

1. BEFORE answering questions about the user's projects, decisions, workflows, or past work: call \`search_vault\` first. Never speculate from memory if the vault might know.
2. AFTER substantial conversations with new insights: call \`create_note\` to persist. Choose type carefully:
   - note → 20_notes/ (general insights)
   - capture → 30_captures/ (external sources, snippets, quotes)
   - decision → 50_decisions/ (trade-offs, ADRs)
   - intervention → 70_pai/interventions/ (proactive suggestions for the user)
   Path pattern: {folder}/{YYYY-MM-DD}-{slug} for chronological sort.
3. ON "save this" / "remember" / "capture": immediately call \`create_note\` type=capture in 30_captures/. Don't ask, just do.
4. ON "what do we know about X" / "have we covered Y": call \`search_vault\` first, then answer citing noteIds.
5. ON "summarize this session" / "write it all down": call \`create_note\` type=note in 70_pai/sessions/{YYYY-MM-DD}-{slug} with structured Markdown.
6. While editing a note, if you spot a conceptual link to another existing note, insert [[Other Note Title]] via \`update_note\` — this organically builds the knowledge graph.

Permission model: your scope is defined in 00_meta/mcp-scopes.yaml. Scope violations are hard limits — don't retry around them.`;

interface ClientDescriptor {
  id: string;
  label: string;
  configPath: () => string;
  supportsAutoInstructions: boolean; // MCP 2025-06-18 instructions field
  patch?: (env: Record<string, string>) => "patched" | "skipped" | "error";
  manualSnippet?: (env: Record<string, string>) => string;
}

const HOME = homedir();
const IS_MAC = platform() === "darwin";

const CLIENTS: ClientDescriptor[] = [
  {
    id: "claude-code",
    label: "Claude Code (CLI)",
    configPath: () => join(HOME, ".claude.json"),
    supportsAutoInstructions: true,
    patch: (env) => patchClaudeCode(env),
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop (App)",
    configPath: () =>
      IS_MAC
        ? join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : join(HOME, ".config", "Claude", "claude_desktop_config.json"),
    supportsAutoInstructions: true,
    patch: (env) => patchJsonMcpConfig(claudeDesktopConfigPath(), "lokyy-brain", env),
  },
  {
    id: "cursor",
    label: "Cursor IDE",
    configPath: () => join(HOME, ".cursor", "mcp.json"),
    supportsAutoInstructions: true,
    patch: (env) => patchJsonMcpConfig(join(HOME, ".cursor", "mcp.json"), "lokyy-brain", env),
  },
  {
    id: "continue",
    label: "Continue.dev",
    configPath: () => join(HOME, ".continue", "config.json"),
    supportsAutoInstructions: false, // continue uses its own MCP convention
    manualSnippet: (env) => continueSnippet(env),
  },
  {
    id: "claude-ai",
    label: "claude.ai Web/App (Custom Connector)",
    configPath: () => "(no local config — set up in claude.ai → Settings → Connectors)",
    supportsAutoInstructions: true,
    manualSnippet: (env) => claudeAiSnippet(env),
  },
  {
    id: "chatgpt",
    label: "ChatGPT (Custom GPT with Actions)",
    configPath: () => "(no local config — set up in ChatGPT → My GPTs → Create)",
    supportsAutoInstructions: false,
    manualSnippet: (env) => chatgptSnippet(env),
  },
  {
    id: "gemini",
    label: "Google Gemini Apps",
    configPath: () => "(no local config — paste system prompt per chat)",
    supportsAutoInstructions: false,
    manualSnippet: (env) => genericPromptSnippet("Gemini"),
  },
  {
    id: "generic",
    label: "Any other LLM client",
    configPath: () => "(any client — copy the prompt below as system instructions)",
    supportsAutoInstructions: false,
    manualSnippet: (env) => genericPromptSnippet("any LLM client"),
  },
];

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = collectEnv(args);

  console.log("\n  🧠  Lokyy-Brain Setup\n");

  if (args["print-prompt"]) {
    console.log(LOKYY_BRAIN_SYSTEM_PROMPT);
    return;
  }

  const targetIds = args.client
    ? [args.client]
    : CLIENTS.filter((c) => c.id !== "generic").map((c) => c.id);

  if (!args.auto && !args.client) {
    console.log("Detected clients (auto-patchable, will ask Y/N):");
    for (const c of CLIENTS.filter((c) => c.patch)) {
      const path = c.configPath();
      const present = path.startsWith("(") ? false : existsSync(path);
      console.log(`  ${present ? "✅" : "  "} ${c.label.padEnd(35)} ${path}`);
    }
    console.log("\nManual-setup clients (will print snippets):");
    for (const c of CLIENTS.filter((c) => !c.patch)) {
      console.log(`  📋 ${c.label}`);
    }
    console.log();
  }

  const rl = args.auto ? null : createInterface({ input, output });

  for (const id of targetIds) {
    const c = CLIENTS.find((x) => x.id === id);
    if (!c) {
      console.warn(`unknown client id: ${id}`);
      continue;
    }

    if (c.patch) {
      const path = c.configPath();
      const present = !path.startsWith("(") && existsSync(path);
      const should = args.auto
        ? present
        : present &&
          (
            await rl!.question(`  Patch ${c.label}? (${path}) [Y/n] `)
          )
            .trim()
            .toLowerCase() !== "n";
      if (should) {
        console.log(`  → patching ${c.label} …`);
        const result = c.patch(env);
        console.log(`    ${result}`);
      } else if (!present) {
        console.log(`  ⏭  ${c.label} not installed, skipping`);
      } else {
        console.log(`  ⏭  ${c.label} skipped`);
      }
    } else if (c.manualSnippet) {
      console.log(`\n━━━ ${c.label} (manual setup) ━━━`);
      console.log(c.manualSnippet(env));
      console.log();
    }
  }

  rl?.close();

  console.log("\n  ✅  Done. Restart your AI client to pick up the new MCP connection.\n");
  console.log("  📖 Full canonical instructions: see your Lokyy-Brain vault at 00_meta/AGENTS.md\n");
}

// ─── Client-specific patchers ──────────────────────────────────────────────
function patchClaudeCode(env: Record<string, string>): "patched" | "skipped" | "error" {
  return patchJsonMcpConfig(join(HOME, ".claude.json"), "lokyy-brain", env);
}

function claudeDesktopConfigPath(): string {
  return IS_MAC
    ? join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : join(HOME, ".config", "Claude", "claude_desktop_config.json");
}

function patchJsonMcpConfig(
  configPath: string,
  serverName: string,
  env: Record<string, string>,
): "patched" | "skipped" | "error" {
  try {
    if (!existsSync(configPath)) {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2));
    } else {
      // backup
      copyFileSync(configPath, configPath + ".lokyy-backup-" + Date.now());
    }
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers[serverName] = mcpServerEntry(env);
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    return "patched";
  } catch (err) {
    console.error(`    error: ${(err as Error).message}`);
    return "error";
  }
}

function mcpServerEntry(env: Record<string, string>) {
  return {
    command: "node",
    args: [resolve(env.BINARY_PATH ?? "./mcp/dist/bin.js")],
    env: {
      LOKYY_DB_URL: env.LOKYY_DB_URL,
      LOKYY_VAULT_DIR: env.LOKYY_VAULT_DIR,
      LOKYY_GIT_REMOTE: env.LOKYY_GIT_REMOTE,
      LOKYY_GIT_BRANCH: env.LOKYY_GIT_BRANCH ?? "main",
      LOKYY_VAULT_ID: env.LOKYY_VAULT_ID,
      LOKYY_AGENT_ID: env.LOKYY_AGENT_ID ?? "claude-code",
    },
  };
}

// ─── Manual-setup snippet generators ───────────────────────────────────────
function continueSnippet(env: Record<string, string>): string {
  return `Add to ~/.continue/config.json under "experimental.modelContextProtocolServers":

${JSON.stringify(
  {
    transport: "stdio",
    command: "node",
    args: [env.BINARY_PATH ?? "./mcp/dist/bin.js"],
    env: mcpServerEntry(env).env,
  },
  null,
  2,
)}

Then in any Continue prompt, include the system instructions:
${LOKYY_BRAIN_SYSTEM_PROMPT}`;
}

function claudeAiSnippet(env: Record<string, string>): string {
  const httpUrl = env.LOKYY_PUBLIC_URL ?? "https://your-deployed-host.tld/mcp";
  return `claude.ai Custom Connector setup (OAuth 2.1 — Dynamic Client Registration):
  1. Open claude.ai → Settings → Connectors → Add custom connector
  2. Name:                    lokyy-brain
  3. Remote MCP Server URL:   ${httpUrl}
  4. OAuth Client ID:         (leave empty — the server self-registers via Dynamic Client Registration)
  5. OAuth Client Secret:     (leave empty — same as above)
  6. Click Connect.
     claude.ai will open a login/consent page hosted by the MCP server.
     Enter the value of LOKYY_OAUTH_PASSWORD (or LOKYY_MCP_TOKEN if
     LOKYY_OAUTH_PASSWORD is not set in your deployment).
  7. After authorizing, the 5 tools should appear:
     read_note, search_vault, list_tree, create_note, update_note

claude.ai picks up the MCP \`instructions\` field automatically when the
connector is added — no separate prompt needed. But for a more aggressive
behavior, ALSO paste this into claude.ai → Profile → Custom Instructions
OR into your Project's System Prompt:

${LOKYY_BRAIN_SYSTEM_PROMPT}`;
}

function chatgptSnippet(env: Record<string, string>): string {
  return `ChatGPT does NOT speak MCP natively. Two options:

A) Custom GPT with Actions (recommended)
   1. ChatGPT → Explore GPTs → Create
   2. Configure → Add Actions → Import OpenAPI schema
   3. Schema URL: ${env.LOKYY_PUBLIC_URL ?? "https://your-host.tld"}/api/openapi.json
      (NOTE: Lokyy-Brain currently exposes REST under /api/* — you may need
       to generate an OpenAPI schema for the relevant routes; not auto-generated yet)
   4. Auth: Bearer Token = your LOKYY_MCP_TOKEN
   5. System prompt (Instructions field):

${LOKYY_BRAIN_SYSTEM_PROMPT}

B) Quick-and-dirty: just paste the system prompt above into a new Project's
   custom instructions and tell the model to call your REST API directly.
   No tool-use, but the model knows your vault structure.`;
}

function genericPromptSnippet(client: string): string {
  return `For ${client}: paste this as the system prompt / pre-prompt of every chat:

${LOKYY_BRAIN_SYSTEM_PROMPT}

(If ${client} supports MCP via plugin / extension, point it to the
lokyy-brain binary at ${process.env.BINARY_PATH ?? "./mcp/dist/bin.js"}
with the same env vars used elsewhere.)`;
}

// ─── Arg + env collection ──────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a === "--auto") out.auto = true;
    else if (a === "--print-prompt") out["print-prompt"] = true;
    else if (a.startsWith("--client=")) out.client = a.slice("--client=".length);
  }
  return out;
}

function collectEnv(args: Record<string, string | boolean>): Record<string, string> {
  return {
    BINARY_PATH:
      process.env.LOKYY_BINARY_PATH ??
      resolve(dirname(new URL(import.meta.url).pathname), "bin.js"),
    LOKYY_DB_URL: process.env.LOKYY_DB_URL ?? "postgres://postgres:lokyy@localhost:5439/lokyy_brain",
    LOKYY_VAULT_DIR: process.env.LOKYY_VAULT_DIR ?? "/tmp/lokyy-vault-live",
    LOKYY_GIT_REMOTE:
      process.env.LOKYY_GIT_REMOTE ?? "https://forgejo.paione.de/oliver/mein-vault",
    LOKYY_GIT_BRANCH: process.env.LOKYY_GIT_BRANCH ?? "main",
    LOKYY_VAULT_ID: process.env.LOKYY_VAULT_ID ?? "<set-LOKYY_VAULT_ID>",
    LOKYY_AGENT_ID: process.env.LOKYY_AGENT_ID ?? "claude-code",
    LOKYY_PUBLIC_URL: process.env.LOKYY_PUBLIC_URL ?? "",
  };
}

// Run the interactive wizard ONLY when this module is the process entry point.
// Importing it (e.g. from setup.test.ts to exercise the exported guard
// helpers) must NOT kick off the wizard / block on a readline prompt.
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === new URL(`file://${resolve(entry)}`).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await main();
}
