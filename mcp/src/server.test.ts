import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DOC_TYPES, getVaultConventions, getSkillSchema, getHealth } from "@lokyy/core";
import { resolveCreateNoteInput, classifyToolError } from "./server.js";

/**
 * Story 10.2 — MCP `create_note` input resolution.
 *
 * These cover the bug-fix surface that lives in the MCP layer (the SDK does
 * NOT validate arguments against the inputSchema, so validation must be
 * explicit in the handler):
 *   - AC#1: a present-but-unknown type is REJECTED, never coerced to "note".
 *   - AC#2: every DOC_TYPE (incl. `skill`, `peer`) is accepted 1:1.
 *   - AC#4: path derived from type+slug when no full path is supplied.
 */
describe("resolveCreateNoteInput — type fidelity (AC#1/2)", () => {
  it("accepts EVERY DOC_TYPE 1:1 (no drift, skill included)", () => {
    for (const type of DOC_TYPES) {
      const res = resolveCreateNoteInput({ type, path: `x/${type}` });
      expect(res.ok, `type "${type}" should be accepted`).toBe(true);
      if (res.ok) expect(res.type).toBe(type);
    }
  });

  it("type:skill is passed through (not silently rewritten to note)", () => {
    const res = resolveCreateNoteInput({ type: "skill", path: "70_pai/skills/x" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.type).toBe("skill");
  });

  it("rejects an unknown type with a structured invalid-type error", () => {
    const res = resolveCreateNoteInput({ type: "wizard", path: "x/y" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.error).toBe("invalid-type");
      if (res.error.error === "invalid-type") {
        expect(res.error.got).toBe("wizard");
        expect(res.error.allowed).toEqual([...DOC_TYPES]);
        expect(res.error.allowed).toContain("skill");
      }
    }
  });

  it("NEVER coerces an unknown type to note", () => {
    const res = resolveCreateNoteInput({ type: "totally-bogus", path: "x/y" });
    // Must be a rejection, not `{ ok:true, type:"note" }`.
    expect(res.ok).toBe(false);
  });

  it("defaults to note only when type is absent", () => {
    const res = resolveCreateNoteInput({ path: "20_notes/x" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.type).toBe("note");
  });
});

describe("resolveCreateNoteInput — path derivation (AC#4)", () => {
  it("derives a plain canonical path from type+slug (no path supplied)", () => {
    const res = resolveCreateNoteInput({ type: "note", slug: "my-insight" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("20_notes/my-insight");
  });

  it("derives a dated path for captures", () => {
    const res = resolveCreateNoteInput({ type: "capture", slug: "yt-video" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.path).toMatch(/^30_captures\/\d{4}-\d{2}-\d{2}-yt-video$/);
    }
  });

  it("a supplied full path wins over slug derivation", () => {
    const res = resolveCreateNoteInput({
      type: "capture",
      path: "30_captures/youtube/explicit",
      slug: "ignored",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("30_captures/youtube/explicit");
  });

  it("missing both path and slug → structured missing-path error", () => {
    const res = resolveCreateNoteInput({ type: "decision" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.error).toBe("missing-path");
      if (res.error.error === "missing-path") {
        expect(res.error.expectedFolder).toBe("50_decisions");
      }
    }
  });
});

/**
 * Story 10.7 — structured-error classifier (`classifyToolError`).
 *
 * The dispatch wrapper routes every uncaught throw through this so a calling
 * agent always gets `{ error: "tool-execution-failed", error_class, ... }`
 * with the retry taxonomy, and NEVER the raw backend message.
 */
describe("classifyToolError — taxonomy + no leak (Story 10.7)", () => {
  it("maps pool exhaustion to transient backend with retry_after_ms", () => {
    const out = classifyToolError(
      new Error("remaining connection slots are reserved; pool exhausted"),
      "create_note",
    );
    expect(out.error).toBe("tool-execution-failed");
    expect(out.error_class).toBe("transient");
    expect(out.tool).toBe("create_note");
    expect(out.retry_after_ms).toBeGreaterThan(0);
  });

  it("maps git lock contention to transient", () => {
    const out = classifyToolError(new Error("Unable to acquire git lock (locked)"), "update_note");
    expect(out.error_class).toBe("transient");
    expect(out.retry_after_ms).toBeGreaterThan(0);
  });

  it("classifies an unknown throw as backend without leaking the raw message", () => {
    const secret = "PG: relation \"notes\" does not exist at /home/x/secret/path.ts:42";
    const out = classifyToolError(new Error(secret), "search_vault");
    expect(out.error).toBe("tool-execution-failed");
    expect(out.error_class).toBe("backend");
    expect(out.message).not.toContain(secret);
    expect(out.message).not.toContain("notes");
    expect(out.retry_after_ms).toBeUndefined();
  });
});

/**
 * Story 10.4 / 10.5 / 10.8 — the pure core payloads served by the new tools,
 * resolved THROUGH the `@lokyy/core` barrel (proves the re-export wiring,
 * 10.8 AC#5). These are the exact objects the tools return via `text()`.
 */
describe("get_vault_conventions payload (Story 10.4)", () => {
  it("contains every DOC_TYPE and the canonical folders", () => {
    const conv = getVaultConventions();
    const types = conv.types.map((t) => t.type);
    for (const t of DOC_TYPES) {
      expect(types, `type ${t} present`).toContain(t);
    }
    const folders = conv.folders.map((f) => f.path);
    for (const f of ["00_meta", "20_notes", "30_captures", "50_decisions", "99_archive"]) {
      expect(folders, `folder ${f} present`).toContain(f);
    }
    expect(conv.frontmatter.required).toEqual(
      expect.arrayContaining(["id", "type", "title", "created", "updated"]),
    );
  });
});

describe("get_skill_schema payload (Story 10.5)", () => {
  it("ships a schema + a non-empty example + field docs", () => {
    const info = getSkillSchema();
    expect(info.schema).toBeTypeOf("object");
    expect(info.example.length).toBeGreaterThan(0);
    expect(info.example).toContain("type: skill");
    // {{var}} substitution is the mechanism callers must know about.
    expect(info.example).toMatch(/\{\{.+\}\}/);
    expect(info.fieldDocs.map((f) => f.field)).toEqual(
      expect.arrayContaining(["skill_name", "description", "input_schema"]),
    );
  });
});

describe("get_health payload (Story 10.8)", () => {
  it("returns all documented fields; vault_id flows from context", () => {
    const h = getHealth({ vaultId: "vault-xyz" });
    expect(h.vault_id).toBe("vault-xyz");
    expect(h.db_pool_max).toBeGreaterThan(0);
    expect(h).toHaveProperty("sync_state");
    expect(h).toHaveProperty("last_successful_index_at");
    expect(h).toHaveProperty("pending_writes");
    expect(h).toHaveProperty("db_pool_used");
    expect(h).toHaveProperty("breaker_entries");
    expect(Array.isArray(h.quarantined)).toBe(true);
  });
});

/**
 * End-to-end MCP wiring of the new tools through the REAL CallTool handler
 * `buildServer` registers — driven over an in-memory transport pair so the
 * ListTools entry, the switch case, the scope checks, and the structured-error
 * wrapper are all exercised. Heavy I/O (`initCore`/`initDb`/`ensureRepo`) and
 * the per-tool note helpers (`getNote`/`trashEntry`/`deleteEntry`) are stubbed;
 * the pure payload functions (conventions/skill-schema/health) stay REAL.
 */
const trashEntryMock = vi.fn();
const deleteEntryMock = vi.fn();
const getNoteMock = vi.fn();
// Wave-3 (Story 10.9/10.10/10.11/10.14) core-call mocks.
const moveEntryMock = vi.fn();
const backlinksMock = vi.fn(async () => [] as unknown[]);
const createNotesMock = vi.fn();
const updateNotesMock = vi.fn();
const queryNotesMock = vi.fn(async () => [] as unknown[]);
const createFolderMock = vi.fn(async () => {});
const createNoteMock = vi.fn();
// Wave-4 (Story 10.16/10.17) core-call mocks. validateFrontmatter +
// parseFrontmatter are PURE → left REAL (via ...actual) so the invalid-
// frontmatter test exercises the real schema validator.
const findBrokenLinksMock = vi.fn(async () => [] as unknown[]);
const listTagsMock = vi.fn(async () => [] as unknown[]);
const noteHistoryMock = vi.fn(async () => [] as unknown[]);
const noteDiffMock = vi.fn(async () => ({ sha: null, diff: "" }));
// Story 10.13 — resolveVaultResolution drives get_health.vault_warning at boot.
const resolveVaultResolutionMock = vi.fn();

vi.mock("@lokyy/core", async (importActual) => {
  const actual = await importActual<typeof import("@lokyy/core")>();
  return {
    ...actual,
    initCore: vi.fn(),
    initDb: vi.fn(),
    ensureRepo: vi.fn(async () => {}),
    getMemoryProvider: vi.fn(() => ({ search: async () => [] })),
    getNote: (...a: unknown[]) => getNoteMock(...a),
    trashEntry: (...a: unknown[]) => trashEntryMock(...a),
    deleteEntry: (...a: unknown[]) => deleteEntryMock(...a),
    moveEntry: (...a: unknown[]) => moveEntryMock(...a),
    backlinks: (...a: unknown[]) => backlinksMock(...a),
    createNotes: (...a: unknown[]) => createNotesMock(...a),
    updateNotes: (...a: unknown[]) => updateNotesMock(...a),
    queryNotes: (...a: unknown[]) => queryNotesMock(...a),
    createFolder: (...a: unknown[]) => createFolderMock(...a),
    createNote: (...a: unknown[]) => createNoteMock(...a),
    findBrokenLinks: (...a: unknown[]) => findBrokenLinksMock(...a),
    listTags: (...a: unknown[]) => listTagsMock(...a),
    noteHistory: (...a: unknown[]) => noteHistoryMock(...a),
    noteDiff: (...a: unknown[]) => noteDiffMock(...a),
  };
});

// Story 10.13 — mock the multi-vault detection so buildServer never touches a
// real DB at boot. Default: unambiguous (no warning) for the shared e2e server.
vi.mock("./resolveVaultId.js", () => ({
  resolveVaultResolution: (...a: unknown[]) => resolveVaultResolutionMock(...a),
}));

describe("MCP tool wiring (e2e via InMemoryTransport)", () => {
  let vaultDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeAll(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "lokyy-mcp-test-"));
    await mkdir(join(vaultDir, "00_meta"), { recursive: true });
    // Full read/write scope so canWrite passes for delete_note.
    await writeFile(
      join(vaultDir, "00_meta", "mcp-scopes.yaml"),
      "scopes:\n  test-agent:\n    read: ['**/*.md']\n    write: ['**/*.md']\n    commit_prefix: '[agent:test]'\n",
      "utf8",
    );

    // Shared server boots unambiguous → get_health.vault_warning stays null.
    resolveVaultResolutionMock.mockResolvedValue({
      vaultId: "vault-test",
      ambiguous: false,
      candidates: [],
      source: "db",
    });

    const { buildServer } = await import("./server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const server = await buildServer(
      { vaultDir } as never,
      "postgres://unused",
      "vault-test",
      "test-agent",
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([client.connect(clientT), server.connect(serverT)]);
  });

  afterAll(async () => {
    await client?.close();
    await rm(vaultDir, { recursive: true, force: true });
  });

  // Parse the JSON the `text()` helper wraps every payload in.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function payload(res: any): any {
    return JSON.parse(res.content[0].text);
  }

  it("lists all new tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "delete_note",
        "get_vault_conventions",
        "get_skill_schema",
        "get_health",
        // Wave 3 (Story 10.9/10.10/10.11/10.14).
        "move_note",
        "rename_note",
        "create_notes",
        "update_notes",
        "list_notes",
        "create_folder",
        // Wave 4 (Story 10.16/10.17).
        "get_backlinks",
        "find_broken_links",
        "get_tags",
        "get_history",
        "get_note_diff",
        "validate_note",
      ]),
    );
  });

  it("delete_note soft-delete → mode soft via trashEntry", async () => {
    getNoteMock.mockResolvedValueOnce({ id: "20_notes/x" });
    trashEntryMock.mockResolvedValueOnce({ from: "20_notes/x", to: "99_archive/_trash/2026-05-29-x" });
    const res = await client.callTool({ name: "delete_note", arguments: { path: "20_notes/x" } });
    const out = payload(res);
    expect(out.mode).toBe("soft");
    expect(out.deleted.to).toContain("99_archive/_trash/");
    expect(trashEntryMock).toHaveBeenCalledWith("20_notes/x");
    expect(deleteEntryMock).not.toHaveBeenCalled();
  });

  it("delete_note hard=true → mode hard via deleteEntry", async () => {
    getNoteMock.mockResolvedValueOnce({ id: "20_notes/y" });
    deleteEntryMock.mockResolvedValueOnce(undefined);
    const res = await client.callTool({
      name: "delete_note",
      arguments: { path: "20_notes/y", hard: true },
    });
    const out = payload(res);
    expect(out.mode).toBe("hard");
    expect(deleteEntryMock).toHaveBeenCalledWith("20_notes/y", "note");
  });

  it("delete_note on a missing note → structured not-found", async () => {
    getNoteMock.mockResolvedValueOnce(null);
    const res = await client.callTool({ name: "delete_note", arguments: { path: "20_notes/gone" } });
    const out = payload(res);
    expect(out.error).toBe("not-found");
    expect(out.path).toBe("20_notes/gone");
  });

  it("get_vault_conventions returns DOC_TYPES + folders", async () => {
    const res = await client.callTool({ name: "get_vault_conventions", arguments: {} });
    const out = payload(res);
    expect(out.types.map((t: { type: string }) => t.type)).toContain("skill");
    expect(out.folders.map((f: { path: string }) => f.path)).toContain("20_notes");
  });

  it("get_skill_schema returns an example skill", async () => {
    const res = await client.callTool({ name: "get_skill_schema", arguments: {} });
    const out = payload(res);
    expect(out.example).toContain("type: skill");
    expect(out.fieldDocs.length).toBeGreaterThan(0);
  });

  it("get_health returns the snapshot with the server's vault_id", async () => {
    const res = await client.callTool({ name: "get_health", arguments: {} });
    const out = payload(res);
    expect(out.vault_id).toBe("vault-test");
    expect(out.db_pool_max).toBeGreaterThan(0);
    expect(Array.isArray(out.quarantined)).toBe(true);
  });

  it("structured-error wrapper maps a thrown helper error to tool-execution-failed", async () => {
    getNoteMock.mockResolvedValueOnce({ id: "20_notes/z" });
    trashEntryMock.mockRejectedValueOnce(new Error("pool exhausted: no connection slots"));
    const res = await client.callTool({ name: "delete_note", arguments: { path: "20_notes/z" } });
    const out = payload(res);
    expect(out.error).toBe("tool-execution-failed");
    expect(out.error_class).toBe("transient");
    expect(out.tool).toBe("delete_note");
    // The raw backend message must not leak to the client.
    expect(out.message).not.toContain("connection slots");
  });

  /* ---- Story 10.9 — move_note / rename_note ---- */

  it("move_note re-files via moveEntry(kind=note) and returns moved{from,to}", async () => {
    getNoteMock.mockResolvedValueOnce({ id: "20_notes/draft" });
    moveEntryMock.mockResolvedValueOnce(undefined);
    backlinksMock.mockResolvedValueOnce([]); // no backlinks → no warning
    const res = await client.callTool({
      name: "move_note",
      arguments: { from: "20_notes/draft", to: "50_decisions/draft" },
    });
    const out = payload(res);
    expect(out.moved).toEqual({ from: "20_notes/draft", to: "50_decisions/draft" });
    expect(out.warning).toBeUndefined();
    expect(moveEntryMock).toHaveBeenCalledWith("20_notes/draft", "50_decisions/draft", "note");
  });

  it("move_note surfaces backlinks as a non-blocking warning (no rewrite)", async () => {
    getNoteMock.mockResolvedValueOnce({ id: "20_notes/draft" });
    moveEntryMock.mockResolvedValueOnce(undefined);
    backlinksMock.mockResolvedValueOnce([
      { noteId: "20_notes/refA", title: "A", context: "see [[20_notes/draft]]" },
    ]);
    const res = await client.callTool({
      name: "move_note",
      arguments: { from: "20_notes/draft", to: "20_notes/final" },
    });
    const out = payload(res);
    expect(out.moved).toEqual({ from: "20_notes/draft", to: "20_notes/final" });
    expect(out.warning).toContain("20_notes/refA");
    expect(out.warning).toMatch(/not rewritten/i);
  });

  it("rename_note keeps the parent folder, swaps only the slug", async () => {
    getNoteMock.mockResolvedValueOnce({ id: "20_notes/old-name" });
    moveEntryMock.mockResolvedValueOnce(undefined);
    backlinksMock.mockResolvedValueOnce([]);
    const res = await client.callTool({
      name: "rename_note",
      arguments: { path: "20_notes/old-name", new_slug: "new-name" },
    });
    const out = payload(res);
    expect(out.moved).toEqual({ from: "20_notes/old-name", to: "20_notes/new-name" });
    expect(moveEntryMock).toHaveBeenCalledWith("20_notes/old-name", "20_notes/new-name", "note");
  });

  it("move_note on a missing source → structured not-found (no move attempted)", async () => {
    // moveEntryMock is a suite-shared spy that accumulated calls from the
    // earlier (legitimate) move/rename tests — clear it so this assertion
    // checks ONLY that THIS missing-source call does not attempt a move.
    moveEntryMock.mockClear();
    getNoteMock.mockResolvedValueOnce(null);
    const res = await client.callTool({
      name: "move_note",
      arguments: { from: "20_notes/gone", to: "20_notes/elsewhere" },
    });
    const out = payload(res);
    expect(out.error).toBe("not-found");
    expect(out.path).toBe("20_notes/gone");
    expect(moveEntryMock).not.toHaveBeenCalled();
  });

  /* ---- Story 10.10 — create_notes / update_notes (bulk) ---- */

  it("create_notes lands all items (returns the bulk result)", async () => {
    createNotesMock.mockResolvedValueOnce({
      ok: true,
      notes: [{ id: "10_projects/p/a" }, { id: "10_projects/p/b" }],
    });
    const res = await client.callTool({
      name: "create_notes",
      arguments: {
        notes: [
          { id: "10_projects/p/a", title: "A", type: "note" },
          { id: "10_projects/p/b", title: "B", type: "note" },
        ],
      },
    });
    const out = payload(res);
    expect(out.ok).toBe(true);
    expect(out.notes.map((n: { id: string }) => n.id)).toEqual([
      "10_projects/p/a",
      "10_projects/p/b",
    ]);
    // Per-item opts carry validatePlacement + type (Story 10.2 coupling).
    const items = createNotesMock.mock.calls[0][0] as Array<{
      id: string;
      opts: { type?: string; validatePlacement?: boolean };
    }>;
    expect(items[0].opts.validatePlacement).toBe(true);
    expect(items[0].opts.type).toBe("note");
  });

  it("create_notes with one bad item commits nothing (core reports the failure)", async () => {
    createNotesMock.mockResolvedValueOnce({
      ok: false,
      error: { id: "10_projects/p/bad", reason: "type-folder-mismatch", message: "nope" },
      committed: [],
    });
    const res = await client.callTool({
      name: "create_notes",
      arguments: {
        notes: [
          { id: "10_projects/p/ok", type: "note" },
          { id: "10_projects/p/bad", type: "decision" },
        ],
      },
    });
    const out = payload(res);
    expect(out.ok).toBe(false);
    expect(out.error.id).toBe("10_projects/p/bad");
    expect(out.error.reason).toBe("type-folder-mismatch");
    expect(out.committed).toEqual([]);
  });

  it("update_notes lands all updates (bulk result)", async () => {
    updateNotesMock.mockResolvedValueOnce({
      ok: true,
      notes: [{ id: "20_notes/a" }, { id: "20_notes/b" }],
    });
    const res = await client.callTool({
      name: "update_notes",
      arguments: {
        updates: [
          { id: "20_notes/a", body: "# A\n\nnew" },
          { id: "20_notes/b", body: "# B\n\nnew" },
        ],
      },
    });
    const out = payload(res);
    expect(out.ok).toBe(true);
    const items = updateNotesMock.mock.calls[0][0] as Array<{ id: string; body: string }>;
    expect(items.map((i) => i.id)).toEqual(["20_notes/a", "20_notes/b"]);
    expect(items[0].body).toContain("new");
  });

  it("update_notes with one missing target commits nothing (core reports it)", async () => {
    updateNotesMock.mockResolvedValueOnce({
      ok: false,
      error: { id: "20_notes/missing", reason: "not-found", message: "missing" },
      committed: [],
    });
    const res = await client.callTool({
      name: "update_notes",
      arguments: {
        updates: [
          { id: "20_notes/here", body: "x" },
          { id: "20_notes/missing", body: "y" },
        ],
      },
    });
    const out = payload(res);
    expect(out.ok).toBe(false);
    expect(out.error.id).toBe("20_notes/missing");
    expect(out.error.reason).toBe("not-found");
  });

  /* ---- Story 10.11 — list_notes (filter + scope + pagination) ---- */

  it("list_notes maps a type filter to queryNotes.where and projects rows", async () => {
    queryNotesMock.mockResolvedValueOnce([
      { id: "50_decisions/d1", title: "D1", type: "decision", status: "open", updated: "2026-05-20" },
      { id: "50_decisions/d2", title: "D2", type: "decision", status: "open", updated: "2026-05-21" },
    ]);
    const res = await client.callTool({
      name: "list_notes",
      arguments: { filter: { type: "decision", folder: "50_decisions" } },
    });
    const out = payload(res);
    expect(out.total).toBe(2);
    expect(out.notes[0].noteId).toBe("50_decisions/d1");
    expect(out.notes[0].type).toBe("decision");
    // The query passed to core carries the equality where + folder `from`.
    const q = queryNotesMock.mock.calls[0][0] as { where: Record<string, unknown>; from?: string };
    expect(q.where.type).toBe("decision");
    expect(q.from).toBe("50_decisions");
  });

  it("list_notes drops out-of-scope notes is covered by the restricted-scope suite; here updated_after filters", async () => {
    queryNotesMock.mockResolvedValueOnce([
      { id: "20_notes/older", title: "Older", type: "note", status: null, updated: "2026-05-01" },
      { id: "20_notes/newer", title: "Newer", type: "note", status: null, updated: "2026-05-28" },
    ]);
    const res = await client.callTool({
      name: "list_notes",
      arguments: { filter: { updated_after: "2026-05-15" } },
    });
    const out = payload(res);
    expect(out.total).toBe(1);
    expect(out.notes[0].noteId).toBe("20_notes/newer");
  });

  it("list_notes paginates via limit/offset and reports hasMore/total", async () => {
    queryNotesMock.mockResolvedValueOnce([
      { id: "20_notes/a", title: "a", type: "note", status: null, updated: "2026-05-04" },
      { id: "20_notes/b", title: "b", type: "note", status: null, updated: "2026-05-03" },
      { id: "20_notes/c", title: "c", type: "note", status: null, updated: "2026-05-02" },
    ]);
    const res = await client.callTool({
      name: "list_notes",
      arguments: { limit: 2, offset: 1 },
    });
    const out = payload(res);
    expect(out.total).toBe(3);
    expect(out.limit).toBe(2);
    expect(out.offset).toBe(1);
    expect(out.hasMore).toBe(false); // offset 1 + limit 2 == 3 == total
    expect(out.notes.map((n: { noteId: string }) => n.noteId)).toEqual(["20_notes/b", "20_notes/c"]);
  });

  /* ---- Story 10.14 — create_folder (+ with_readme) ---- */

  it("create_folder creates the folder (.gitkeep via createFolder) only", async () => {
    createFolderMock.mockResolvedValueOnce(undefined);
    const res = await client.callTool({
      name: "create_folder",
      arguments: { path: "10_projects/new-project" },
    });
    const out = payload(res);
    expect(out.created).toBe("10_projects/new-project");
    expect(out.readme).toBeUndefined();
    expect(createFolderMock).toHaveBeenCalledWith("10_projects/new-project");
    expect(createNoteMock).not.toHaveBeenCalled();
  });

  it("create_folder with_readme also creates a README note (type:note)", async () => {
    createFolderMock.mockResolvedValueOnce(undefined);
    createNoteMock.mockResolvedValueOnce({ id: "10_projects/np/README", type: "note" });
    const res = await client.callTool({
      name: "create_folder",
      arguments: { path: "10_projects/np", with_readme: true },
    });
    const out = payload(res);
    expect(out.created).toBe("10_projects/np");
    expect(out.readme.id).toBe("10_projects/np/README");
    expect(createNoteMock).toHaveBeenCalledWith(
      "10_projects/np/README",
      undefined,
      expect.objectContaining({ type: "note", title: "README" }),
    );
  });

  /* ---- Story 10.16 — get_backlinks / find_broken_links / get_tags ---- */

  it("get_backlinks returns incoming links and drops out-of-scope sources", async () => {
    backlinksMock.mockResolvedValueOnce([
      { noteId: "20_notes/refA", title: "A", context: "see [[20_notes/topic]]" },
      { noteId: "20_notes/refB", title: "B", context: "links [[topic]]" },
    ]);
    const res = await client.callTool({
      name: "get_backlinks",
      arguments: { path: "20_notes/topic" },
    });
    const out = payload(res);
    // Full read-scope ('**/*.md') → both linkers kept; core was asked by id.
    expect(backlinksMock).toHaveBeenCalledWith("20_notes/topic");
    expect(out.backlinks.map((b: { noteId: string }) => b.noteId)).toEqual([
      "20_notes/refA",
      "20_notes/refB",
    ]);
    expect(out.backlinks[0].context).toContain("[[20_notes/topic]]");
  });

  it("find_broken_links returns the vault-wide broken-wikilink scan", async () => {
    findBrokenLinksMock.mockResolvedValueOnce([
      { sourceId: "20_notes/a", sourceTitle: "A", linkText: "Nonexistent" },
      { sourceId: "20_notes/b", sourceTitle: "B", linkText: "Gone Note" },
    ]);
    const res = await client.callTool({ name: "find_broken_links", arguments: {} });
    const out = payload(res);
    expect(out.broken_links).toHaveLength(2);
    expect(out.broken_links[0]).toEqual({
      sourceId: "20_notes/a",
      sourceTitle: "A",
      linkText: "Nonexistent",
    });
  });

  it("get_tags returns every tag with its count", async () => {
    listTagsMock.mockResolvedValueOnce([
      { tag: "ai", count: 3, noteIds: ["20_notes/a", "20_notes/b", "20_notes/c"] },
      { tag: "pkm", count: 1, noteIds: ["20_notes/a"] },
    ]);
    const res = await client.callTool({ name: "get_tags", arguments: {} });
    const out = payload(res);
    expect(out.tags.map((t: { tag: string }) => t.tag)).toEqual(["ai", "pkm"]);
    expect(out.tags[0].count).toBe(3);
  });

  /* ---- Story 10.17 — get_history / get_note_diff / validate_note ---- */

  it("get_history calls core with the '.md' path and returns commits", async () => {
    noteHistoryMock.mockResolvedValueOnce([
      { sha: "abc123", date: "2026-05-20T10:00:00Z", message: "edit topic" },
      { sha: "def456", date: "2026-05-19T09:00:00Z", message: "create topic" },
    ]);
    const res = await client.callTool({
      name: "get_history",
      arguments: { path: "20_notes/topic", limit: 5 },
    });
    const out = payload(res);
    expect(noteHistoryMock).toHaveBeenCalledWith("20_notes/topic.md", 5);
    expect(out.history.map((h: { sha: string }) => h.sha)).toEqual(["abc123", "def456"]);
  });

  it("get_note_diff (no sha) returns the working-tree diff with sha:null", async () => {
    noteDiffMock.mockResolvedValueOnce({ sha: null, diff: "@@ -1 +1 @@\n-old\n+new" });
    const res = await client.callTool({
      name: "get_note_diff",
      arguments: { path: "20_notes/topic" },
    });
    const out = payload(res);
    expect(noteDiffMock).toHaveBeenCalledWith("20_notes/topic.md", undefined);
    expect(out.sha).toBeNull();
    expect(out.diff).toContain("+new");
  });

  it("get_note_diff (with sha) forwards the sha to core", async () => {
    noteDiffMock.mockResolvedValueOnce({ sha: "abc123", diff: "@@ commit patch @@" });
    const res = await client.callTool({
      name: "get_note_diff",
      arguments: { path: "20_notes/topic", sha: "abc123" },
    });
    const out = payload(res);
    expect(noteDiffMock).toHaveBeenCalledWith("20_notes/topic.md", "abc123");
    expect(out.sha).toBe("abc123");
  });

  it("validate_note (body) → valid:true for SPEC-compliant frontmatter", async () => {
    const body = [
      "---",
      "id: 01KSFC0T2J8XG91RV6Z6D825X9",
      "type: note",
      "title: Valid Note",
      'created: "2026-05-29T10:00:00Z"',
      'updated: "2026-05-29T10:00:00Z"',
      "---",
      "",
      "# Valid Note",
      "",
      "body text",
    ].join("\n");
    const res = await client.callTool({ name: "validate_note", arguments: { body } });
    const out = payload(res);
    expect(out.valid).toBe(true);
    expect(out.errors).toEqual([]);
  });

  it("validate_note (body) → valid:false with errors for missing required fields", async () => {
    // Missing id/created/updated — the real note schema must flag them.
    const body = ["---", "type: note", "title: Broken", "---", "", "# Broken"].join("\n");
    const res = await client.callTool({ name: "validate_note", arguments: { body } });
    const out = payload(res);
    expect(out.valid).toBe(false);
    expect(Array.isArray(out.errors)).toBe(true);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it("validate_note (path) reads the note and validates its frontmatter", async () => {
    const body = [
      "---",
      "id: 01KSFC0T2J8XG91RV6Z6D825X9",
      "type: note",
      "title: From Disk",
      'created: "2026-05-29T10:00:00Z"',
      'updated: "2026-05-29T10:00:00Z"',
      "---",
      "",
      "# From Disk",
    ].join("\n");
    getNoteMock.mockResolvedValueOnce({ id: "20_notes/topic", body });
    const res = await client.callTool({
      name: "validate_note",
      arguments: { path: "20_notes/topic" },
    });
    const out = payload(res);
    expect(getNoteMock).toHaveBeenCalledWith("20_notes/topic");
    expect(out.valid).toBe(true);
  });

  it("validate_note (path) on a missing note → structured not-found", async () => {
    getNoteMock.mockResolvedValueOnce(null);
    const res = await client.callTool({
      name: "validate_note",
      arguments: { path: "20_notes/gone" },
    });
    const out = payload(res);
    expect(out.valid).toBe(false);
    expect(out.error).toBe("not-found");
  });
});

/**
 * Restricted-scope server — write only `30_captures/**`, read only
 * `30_captures/**`. Proves the scope gate (Story 10.9/10.11/10.14) under a
 * real SPEC-style `folder/**` scope: create_folder is denied outside scope and
 * allowed inside it (the `.gitkeep` path matches `folder/**`), and list_notes
 * drops out-of-scope rows.
 */
describe("MCP tool wiring — restricted scope (e2e)", () => {
  let vaultDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeAll(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "lokyy-mcp-scope-"));
    await mkdir(join(vaultDir, "00_meta"), { recursive: true });
    await writeFile(
      join(vaultDir, "00_meta", "mcp-scopes.yaml"),
      "scopes:\n  scoped-agent:\n    read: ['30_captures/**']\n    write: ['30_captures/**']\n    commit_prefix: '[agent:scoped]'\n",
      "utf8",
    );

    resolveVaultResolutionMock.mockResolvedValue({
      vaultId: "vault-scoped",
      ambiguous: false,
      candidates: [],
      source: "db",
    });

    const { buildServer } = await import("./server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const server = await buildServer(
      { vaultDir } as never,
      "postgres://unused",
      "vault-scoped",
      "scoped-agent",
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([client.connect(clientT), server.connect(serverT)]);
  });

  afterAll(async () => {
    await client?.close();
    await rm(vaultDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function payload(res: any): any {
    return JSON.parse(res.content[0].text);
  }

  it("create_folder OUTSIDE write-scope → structured scope_violation (no createFolder)", async () => {
    createFolderMock.mockClear();
    const res = await client.callTool({
      name: "create_folder",
      arguments: { path: "10_projects/secret" },
    });
    const out = payload(res);
    expect(out.error).toBe("scope_violation");
    expect(out.action).toBe("write");
    expect(out.path).toBe("10_projects/secret");
    expect(createFolderMock).not.toHaveBeenCalled();
  });

  it("create_folder INSIDE write-scope succeeds under a `folder/**` scope", async () => {
    createFolderMock.mockResolvedValueOnce(undefined);
    const res = await client.callTool({
      name: "create_folder",
      arguments: { path: "30_captures/imports" },
    });
    const out = payload(res);
    expect(out.created).toBe("30_captures/imports");
    expect(createFolderMock).toHaveBeenCalledWith("30_captures/imports");
  });

  it("list_notes drops out-of-scope notes (read-scope filter)", async () => {
    queryNotesMock.mockResolvedValueOnce([
      { id: "30_captures/c1", title: "in scope", type: "capture", status: null, updated: "2026-05-20" },
      { id: "20_notes/n1", title: "out of scope", type: "note", status: null, updated: "2026-05-21" },
    ]);
    const res = await client.callTool({ name: "list_notes", arguments: {} });
    const out = payload(res);
    expect(out.total).toBe(1);
    expect(out.notes.map((n: { noteId: string }) => n.noteId)).toEqual(["30_captures/c1"]);
  });
});

/**
 * Story 10.13/10.8 — get_health.vault_warning. Boots a server against an
 * AMBIGUOUS multi-vault detection result and asserts the warning surfaces the
 * competing candidates (so an operator can pin LOKYY_VAULT_ID).
 */
describe("MCP get_health — vault_warning when ambiguous (e2e)", () => {
  let vaultDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  beforeAll(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "lokyy-mcp-ambig-"));
    await mkdir(join(vaultDir, "00_meta"), { recursive: true });
    await writeFile(
      join(vaultDir, "00_meta", "mcp-scopes.yaml"),
      "scopes:\n  test-agent:\n    read: ['**/*.md']\n    write: ['**/*.md']\n    commit_prefix: '[agent:test]'\n",
      "utf8",
    );

    // Detection reports two competing vault rows, no env override → ambiguous.
    resolveVaultResolutionMock.mockResolvedValue({
      vaultId: "vault-aaa",
      ambiguous: true,
      candidates: [
        { id: "vault-aaa", slug: "personal" },
        { id: "vault-bbb", slug: "work" },
      ],
      source: "db",
    });

    const { buildServer } = await import("./server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const server = await buildServer(
      { vaultDir } as never,
      "postgres://unused",
      "vault-aaa",
      "test-agent",
    );
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([client.connect(clientT), server.connect(serverT)]);
  });

  afterAll(async () => {
    await client?.close();
    await rm(vaultDir, { recursive: true, force: true });
  });

  it("get_health.vault_warning surfaces the competing candidates", async () => {
    const res = await client.callTool({ name: "get_health", arguments: {} });
    const out = JSON.parse(res.content[0].text);
    expect(out.vault_id).toBe("vault-aaa");
    expect(out.vault_warning).toBeTruthy();
    // The competing ids/slugs must be visible so the operator can pin one.
    expect(out.vault_warning).toContain("vault-bbb");
    expect(out.vault_warning).toContain("work");
    expect(out.vault_warning).toContain("LOKYY_VAULT_ID");
  });
});
