import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  initCore,
  initDb,
  ensureRepo,
  findByUlid,
  getNote,
  getTree,
  createNote,
  isUlid,
  saveNote,
  getMemoryProvider,
  type CoreConfig,
} from "@lokyy/core";
import { canRead, canWrite, activeScope, loadScopes, ScopeViolation } from "./scopes.js";

/**
 * Lokyy-Brain Usage Conventions — auto-injected as system-prompt addendum
 * via MCP `initialize.serverInfo.instructions`. Compatible clients (Claude
 * Code, Claude Desktop, claude.ai Custom Connectors) pick this up on
 * connect — the user only needs to add the MCP server; the AI then knows
 * HOW to use it automatically.
 *
 * Keep this short. Long instructions waste tokens on every conversation
 * turn. Six trigger patterns, each one-line.
 */
const LOKYY_BRAIN_INSTRUCTIONS = `You have access to Lokyy-Brain — the user's personal knowledge vault (git-backed, SPEC-compliant Markdown notes). Use it actively:

1. BEFORE answering questions about the user's projects, decisions, workflows, or past work: call \`search_vault\` first. Never speculate from memory if the vault might know.
2. AFTER substantial conversations with new insights: call \`create_note\` to persist. Choose type carefully:
   - note → 20_notes/ (general insights)
   - capture → 30_captures/ (external sources, snippets, quotes)
   - decision → 50_decisions/ (trade-offs, ADRs)
   - intervention → 70_pai/interventions/ (proactive suggestions for the user)
   Path pattern: \`{folder}/{YYYY-MM-DD}-{slug}\` for chronological sort.
3. ON "save this" / "remember" / "capture": immediately \`create_note\` type=capture in 30_captures/. Don't ask, just do.
4. ON "what do we know about X" / "have we covered Y": \`search_vault\` first, then answer citing noteIds.
5. ON "summarize this session" / "write it all down": \`create_note\` type=note in 70_pai/sessions/{YYYY-MM-DD}-{slug} with structured Markdown (TL;DR / Decisions / Next Steps / Related notes via [[wikilink]]).
6. While editing a note, if you notice a conceptual link to another existing note, insert \`[[Other Note Title]]\` via \`update_note\` — this builds the knowledge graph organically.

Search uses Tier 1 (full-text + tags + wikilinks) and Tier 2 (semantic embeddings, when Ollama is up). Multi-token queries are supported. Empty folders appear with "(empty)" marker — they exist for the SPEC structure even before notes land there.

Permission model: your scope is defined in the vault's \`00_meta/mcp-scopes.yaml\` under your agent-id. Scope violations return a structured error — treat them as hard limits, don't retry around them.`;

/**
 * lokyy-brain MCP server (Story 7.1–7.7).
 *
 * Tools exposed:
 *   - read_note       (Story 7.3)  — read a scoped note
 *   - search_vault    (Story 7.4)  — Tier 1+2 search via @lokyy/core memory
 *   - list_tree       (Story 7.6)  — scoped file tree
 *   - create_note     (Story 7.7)  — create with SPEC-valid frontmatter
 *   - update_note     (Story 7.7)  — save with id/created preservation
 *
 * Pipe handlers (trigger_import — Story 7.8) and related_notes
 * (Story 7.5) are deferred.
 */

export async function buildServer(
  coreConfig: CoreConfig,
  databaseUrl: string,
  vaultId: string,
  agentId: string,
): Promise<Server> {
  // Wire core (gitService + DB + memory) before serving any tool.
  initCore(coreConfig);
  initDb(databaseUrl);
  await ensureRepo();
  await loadScopes(coreConfig.vaultDir, agentId);

  const server = new Server(
    { name: "lokyy-brain", version: "0.0.1" },
    {
      capabilities: { tools: {} },
      // MCP 2025-06-18: instructions are auto-injected by compatible clients
      // (Claude Code, Claude Desktop, claude.ai) as system-prompt addendum.
      // This is how Lokyy-Brain teaches the AI to use itself without the
      // user editing any local prompt files.
      instructions: LOKYY_BRAIN_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read_note",
        description:
          "Read a single Lokyy-Brain note (markdown body + frontmatter). CALL THIS whenever the user references a specific note, project, decision, or past insight — never paraphrase from memory if you can read the source. Path is the note id without .md extension (e.g. '70_pai/sessions/2026-05-24-claude-marathon').",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Note id, e.g. 'pai/hermes'" } },
          required: ["path"],
        },
      },
      {
        name: "resolve_by_id",
        description:
          "Resolve a Lokyy-Brain note by its stable 26-character ULID (the value of `id:` in the note's frontmatter). Use this when the user pastes an 'AI prompt' block copied from the editor — the block carries the ULID, which survives renames/moves whereas the path does not. Returns the full markdown (with frontmatter), the current path, the title, and the parsed frontmatter map. If the ULID is malformed or no note matches, returns an `error` field.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description:
                "ULID — 26 chars, Crockford base32 (no I/L/O/U). Example: '01KSFC0T2J8XG91RV6Z6D825X9'.",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "search_vault",
        description:
          "Search Lokyy-Brain (Tier 1 full-text + Tier 2 semantic embeddings, merged). CALL FIRST whenever the user asks 'what do we know about X', 'have we covered Y', 'where did we discuss Z', or before stating anything about the user's projects/workflows/history. Multi-token queries are scored per-word with title-bonus — use 1–4 keyword tokens for best results. Returns scored hits with snippets and noteIds.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", default: 10 },
          },
          required: ["query"],
        },
      },
      {
        name: "list_tree",
        description:
          "List the Lokyy-Brain folder/note tree, filtered to your readable scope. Empty folders surface with '(empty)' marker so you can see the canonical SPEC structure (10_projects, 20_notes, 30_captures, …) even before notes land there.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "create_note",
        description:
          "Create a new Lokyy-Brain note with SPEC-valid frontmatter (ULID, type, title, created, updated auto-filled). CALL THIS proactively whenever the user says 'save this', 'remember this', 'capture this' — don't ask, just do it. Also call after substantial conversations where insights worth preserving emerged. Choose `type` deliberately (note/capture/decision/project/task/...) — wrong type = wrong folder. Path pattern: '{folder}/{YYYY-MM-DD}-{slug}'.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Note id, e.g. '30_captures/youtube/foo'" },
            body: { type: "string", description: "Markdown body (optional)" },
            title: { type: "string" },
            type: {
              type: "string",
              enum: [
                "note",
                "capture",
                "project",
                "task",
                "decision",
                "meeting",
                "customer",
                "workflow",
                "intervention",
                "content",
              ],
              default: "note",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "update_note",
        description:
          "Save/upsert a Lokyy-Brain note. Preserves on-disk id + created (immutable), bumps updated. Caller's frontmatter merges in for everything else. CALL THIS to add wikilinks ('[[Other Note]]') when you spot conceptual connections — this organically builds the knowledge graph. Also for appending to existing notes (full body replace; you must include the existing content + your addition).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            body: { type: "string" },
          },
          required: ["path", "body"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "read_note": {
          const path = String(args.path);
          if (!canRead(`${path}.md`)) throw new ScopeViolation("read", path);
          const note = await getNote(path);
          if (!note) return text({ error: "not-found", path });
          return text(note);
        }
        case "resolve_by_id": {
          const id = String(args.id ?? "");
          if (!isUlid(id)) {
            return text({ error: "invalid-ulid-format", id });
          }
          const resolved = await findByUlid(id);
          if (!resolved) return text({ error: "not-found", id });
          // Apply the same scope-read gate path-based read_note uses, so a
          // shared ULID cannot bypass an agent's read-scope restrictions.
          if (!canRead(`${resolved.path}.md`)) {
            throw new ScopeViolation("read", resolved.path);
          }
          return text(resolved);
        }
        case "search_vault": {
          const query = String(args.query ?? "");
          const limit = Number(args.limit ?? 10);
          const provider = getMemoryProvider(vaultId);
          const hits = await provider.search(query, { limit });
          const filtered = hits.filter((h) => canRead(`${h.noteId}.md`));
          return text({ results: filtered });
        }
        case "list_tree": {
          const tree = await getTree();
          return text({ tree: filterTreeByScope(tree) });
        }
        case "create_note": {
          const path = String(args.path);
          if (!canWrite(`${path}.md`)) throw new ScopeViolation("write", path);
          const note = await createNote(path, args.body as string | undefined, {
            title: args.title as string | undefined,
            type: (args.type as Parameters<typeof createNote>[2] extends { type?: infer T } ? T : never) ?? "note",
          });
          return text({ created: note, commitPrefix: activeScope().commitPrefix });
        }
        case "update_note": {
          const path = String(args.path);
          if (!canWrite(`${path}.md`)) throw new ScopeViolation("write", path);
          const note = await saveNote(path, String(args.body ?? ""));
          return text({ updated: note, commitPrefix: activeScope().commitPrefix });
        }
        default:
          return text({ error: "unknown-tool", name });
      }
    } catch (err) {
      if (err instanceof ScopeViolation) {
        return text({ error: "scope_violation", action: err.action, path: err.path });
      }
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return server;
}

export async function start(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[lokyy-mcp] connected via stdio");
}

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

interface TreeNode {
  type: "folder" | "note";
  name: string;
  path: string;
  children: TreeNode[];
}

function filterTreeByScope(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.type === "note") {
      if (canRead(`${n.path}.md`)) out.push(n);
    } else {
      const kids = filterTreeByScope(n.children);
      // Include folder if EITHER it has readable child notes OR the agent has
      // write-scope to it (so it knows where to put new notes). Empty folders
      // with only .gitkeep are surfaced with a [(empty)] marker so the model
      // sees the canonical SPEC structure (10_projects, 20_notes, …) even
      // before any notes land there.
      if (kids.length > 0) {
        out.push({ ...n, children: kids });
      } else if (canWrite(`${n.path}/.gitkeep`) || canWrite(`${n.path}/_.md`)) {
        out.push({
          ...n,
          name: `${n.name} (empty)`,
          children: [],
        });
      }
    }
  }
  return out;
}
