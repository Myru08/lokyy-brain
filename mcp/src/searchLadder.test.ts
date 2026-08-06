import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TreeNode } from "@lokyy/shared";

import { resolveSearchMode } from "./server.js";

/**
 * Story "Suchleiter + 8-Stufen-Pipeline an MCP anschließen" (Paket A).
 *
 * Covers AC#3 (search_vault `mode` switch), AC#4 (`get_index`) and AC#5
 * (clean isError on a bad mode). The critical invariant under test is that
 * `fast` — the default — behaves EXACTLY as before: same payload shape,
 * same empty-hint, same call into the memory provider. `deep` is a new,
 * additive branch that must never leak into the default path.
 */

// ─── Pure resolver (no server boot needed) ──────────────────────────────────

describe("resolveSearchMode (AC#3/AC#5)", () => {
  it("defaults to fast when mode is absent", () => {
    const res = resolveSearchMode({});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mode).toBe("fast");
  });

  it("defaults to fast when mode is explicitly undefined or null", () => {
    for (const mode of [undefined, null]) {
      const res = resolveSearchMode({ mode });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.mode).toBe("fast");
    }
  });

  it("accepts fast and deep", () => {
    for (const mode of ["fast", "deep"] as const) {
      const res = resolveSearchMode({ mode });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.mode).toBe(mode);
    }
  });

  it("rejects an unknown mode with a structured, self-healing error", () => {
    const res = resolveSearchMode({ mode: "turbo" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.error).toBe("invalid-mode");
      expect(res.error.got).toBe("turbo");
      expect(res.error.allowed).toEqual(["fast", "deep"]);
    }
  });

  it("rejects a non-string mode rather than coercing it", () => {
    const res = resolveSearchMode({ mode: 7 });
    expect(res.ok).toBe(false);
  });

  it("NEVER silently falls back to fast on a bad mode", () => {
    // Silent fallback would hide a client bug and make `deep` unreliable.
    const res = resolveSearchMode({ mode: "DEEP " });
    expect(res.ok).toBe(false);
  });
});

// ─── e2e wiring ─────────────────────────────────────────────────────────────

const searchMock = vi.fn(async () => [] as unknown[]);
const getNoteMock = vi.fn(async (_id: string) => null as unknown);
const getTreeMock = vi.fn(async () => [] as TreeNode[]);
const saveMock = vi.fn(async () => "sha");
/** Pipeline result with no hits — the per-test default, restored in beforeEach. */
const EMPTY_PIPELINE_RESULT = {
  query: "q",
  rewrittenQuery: "q",
  intent: "topical",
  hops: 1,
  totalDurationMs: 42,
  steps: [] as unknown[],
  rerankedHits: [] as unknown[],
  degraded: [] as string[],
};
const pipelineExecuteMock = vi.fn(async () => EMPTY_PIPELINE_RESULT);
const buildSearchPipelineMock = vi.fn(async () => ({
  execute: (...a: unknown[]) => pipelineExecuteMock(...(a as [])),
}));

vi.mock("@lokyy/core", async (importActual) => {
  const actual = await importActual<typeof import("@lokyy/core")>();
  return {
    ...actual,
    initCore: vi.fn(),
    initDb: vi.fn(),
    ensureRepo: vi.fn(async () => {}),
    getMemoryProvider: vi.fn(() => ({ search: (...a: unknown[]) => searchMock(...(a as [])) })),
    getNote: (...a: unknown[]) => getNoteMock(...(a as [string])),
    getTree: (...a: unknown[]) => getTreeMock(...(a as [])),
    save: (...a: unknown[]) => saveMock(...(a as [])),
    buildSearchPipeline: (...a: unknown[]) => buildSearchPipelineMock(...(a as [])),
  };
});

vi.mock("./resolveVaultId.js", () => ({
  resolveVaultResolution: vi.fn(async () => ({
    vaultId: "vault-test",
    ambiguous: false,
    candidates: [],
    source: "db",
  })),
}));

describe("search ladder e2e (AC#2/AC#3/AC#4/AC#5)", () => {
  let vaultDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeAll(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "lokyy-ladder-test-"));
    await mkdir(join(vaultDir, "00_meta"), { recursive: true });
    await writeFile(
      join(vaultDir, "00_meta", "mcp-scopes.yaml"),
      "scopes:\n  test-agent:\n    read: ['**/*.md']\n    write: ['**/*.md']\n    commit_prefix: '[agent:test]'\n",
      "utf8",
    );

    const { buildServer } = await import("./server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    server = await buildServer(
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

  beforeEach(() => {
    searchMock.mockReset();
    searchMock.mockResolvedValue([]);
    getNoteMock.mockReset();
    getNoteMock.mockResolvedValue(null);
    getTreeMock.mockReset();
    getTreeMock.mockResolvedValue([]);
    saveMock.mockReset();
    saveMock.mockResolvedValue("sha");
    buildSearchPipelineMock.mockClear();
    // mockReset (not mockClear): a per-test `mockResolvedValue` would
    // otherwise persist and silently feed hits into the next case.
    pipelineExecuteMock.mockReset();
    pipelineExecuteMock.mockResolvedValue(EMPTY_PIPELINE_RESULT);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function payload(res: any): any {
    return JSON.parse(res.content[0].text);
  }

  /* ---- AC#3: fast is the default and is byte-identical to the old path ---- */

  it("search_vault without mode uses the memory provider, not the pipeline", async () => {
    searchMock.mockResolvedValue([{ noteId: "20_notes/a", score: 1, snippet: "x" }]);
    const res = await client.callTool({
      name: "search_vault",
      arguments: { query: "lokyy" },
    });
    expect(payload(res)).toEqual({
      results: [{ noteId: "20_notes/a", score: 1, snippet: "x" }],
    });
    expect(searchMock).toHaveBeenCalledWith("lokyy", { limit: 10 });
    expect(buildSearchPipelineMock).not.toHaveBeenCalled();
  });

  it("search_vault mode:fast is byte-identical to omitting mode", async () => {
    searchMock.mockResolvedValue([{ noteId: "20_notes/a", score: 1, snippet: "x" }]);
    const a = await client.callTool({ name: "search_vault", arguments: { query: "q" } });
    searchMock.mockResolvedValue([{ noteId: "20_notes/a", score: 1, snippet: "x" }]);
    const b = await client.callTool({
      name: "search_vault",
      arguments: { query: "q", mode: "fast" },
    });
    expect(b.content[0].text).toBe(a.content[0].text);
  });

  it("the fast empty-result hint is unchanged (no mode field leaks in)", async () => {
    searchMock.mockResolvedValue([]);
    const out = payload(
      await client.callTool({ name: "search_vault", arguments: { query: "nix" } }),
    );
    expect(out.empty).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.hint).toContain("KEIN Fehler");
    expect(out).not.toHaveProperty("mode");
  });

  /* ---- AC#3: deep routes into buildSearchPipeline ---- */

  it("search_vault mode:deep runs the 8-step pipeline and maps its hits", async () => {
    pipelineExecuteMock.mockResolvedValue({
      query: "lokyy",
      rewrittenQuery: "lokyy brain",
      intent: "question",
      hops: 2,
      totalDurationMs: 1234,
      steps: [{ step: 3, name: "hybrid-retrieval", durationMs: 10 }],
      rerankedHits: [
        { noteId: "20_notes/a", finalScore: 0.9, rerankScore: 0.9, baseScore: 0.5 },
        { noteId: "20_notes/b", finalScore: 0.4, rerankScore: 0.4, baseScore: 0.2 },
      ],
      degraded: ["rerank_failed"],
    } as never);
    getNoteMock.mockImplementation(async (id: string) => ({
      id,
      title: `Titel ${id}`,
      body: "---\ntype: note\n---\n\nInhalt von " + id,
    }));

    const out = payload(
      await client.callTool({
        name: "search_vault",
        arguments: { query: "lokyy", mode: "deep" },
      }),
    );

    expect(buildSearchPipelineMock).toHaveBeenCalledTimes(1);
    expect(searchMock).not.toHaveBeenCalled();
    expect(out.mode).toBe("deep");
    expect(out.intent).toBe("question");
    expect(out.degraded).toEqual(["rerank_failed"]);
    expect(out.results.map((r: { noteId: string }) => r.noteId)).toEqual([
      "20_notes/a",
      "20_notes/b",
    ]);
    expect(out.results[0].title).toBe("Titel 20_notes/a");
    expect(out.results[0].score).toBe(0.9);
  });

  it("deep passes the query and the server's vaultId into the pipeline", async () => {
    await client.callTool({
      name: "search_vault",
      arguments: { query: "was ist lokyy", mode: "deep" },
    });
    const input = pipelineExecuteMock.mock.calls[0]?.[0] as unknown as {
      query: string;
      vaultId: string;
    };
    expect(input.query).toBe("was ist lokyy");
    expect(input.vaultId).toBe("vault-test");
  });

  it("deep respects the limit argument", async () => {
    pipelineExecuteMock.mockResolvedValue({
      query: "q",
      rewrittenQuery: "q",
      intent: "topical",
      hops: 1,
      totalDurationMs: 1,
      steps: [],
      rerankedHits: [
        { noteId: "a", finalScore: 3 },
        { noteId: "b", finalScore: 2 },
        { noteId: "c", finalScore: 1 },
      ],
      degraded: [],
    } as never);
    getNoteMock.mockImplementation(async (id: string) => ({ id, title: id, body: "x" }));
    const out = payload(
      await client.callTool({
        name: "search_vault",
        arguments: { query: "q", mode: "deep", limit: 2 },
      }),
    );
    expect(out.results).toHaveLength(2);
  });

  it("deep with no hits returns the same self-explaining empty contract", async () => {
    const out = payload(
      await client.callTool({
        name: "search_vault",
        arguments: { query: "nichts", mode: "deep" },
      }),
    );
    expect(out.empty).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.hint).toContain("KEIN Fehler");
  });

  /* ---- AC#5: bad mode → clean isError ---- */

  it("an unknown mode fails with isError and never touches a backend", async () => {
    const res = await client.callTool({
      name: "search_vault",
      arguments: { query: "q", mode: "turbo" },
    });
    expect(res.isError).toBe(true);
    const out = payload(res);
    expect(out.error).toBe("invalid-mode");
    expect(out.allowed).toEqual(["fast", "deep"]);
    expect(searchMock).not.toHaveBeenCalled();
    expect(buildSearchPipelineMock).not.toHaveBeenCalled();
  });

  /* ---- AC#4: get_index ---- */

  const TREE: TreeNode[] = [
    {
      type: "folder",
      name: "20_notes",
      path: "20_notes",
      children: [{ type: "note", name: "Alpha", path: "20_notes/alpha", children: [] }],
    },
  ];

  it("get_index is advertised with a ladder-explaining description", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t: { name: string }) => t.name === "get_index");
    expect(tool).toBeDefined();
    expect(tool.description).toMatch(/search_vault/);
    expect(tool.description).toMatch(/read_note/);
  });

  it("generates the index on the fly when 00_meta/INDEX.md is missing", async () => {
    getNoteMock.mockResolvedValue(null);
    getTreeMock.mockResolvedValue(TREE);

    const out = payload(await client.callTool({ name: "get_index", arguments: {} }));
    expect(out.path).toBe("00_meta/INDEX");
    expect(out.generated).toBe(true);
    expect(out.content).toContain("Vault-Index");
    expect(out.content).toContain("20_notes/alpha");
    // The regenerated index is persisted through the injected save API.
    expect(saveMock).toHaveBeenCalledWith(
      "00_meta/INDEX.md",
      expect.stringContaining("type: reference"),
      expect.any(String),
    );
  });

  it("serves a fresh existing index verbatim without regenerating", async () => {
    const fresh = new Date().toISOString();
    getNoteMock.mockImplementation(async (id: string) =>
      id === "00_meta/INDEX"
        ? {
            id,
            title: "Vault-Index",
            body:
              `---\nid: 01KSFC0T2J8XG91RV6Z6D825X9\ntype: reference\ntitle: Vault-Index\n` +
              `created: '${fresh}'\nupdated: '${fresh}'\n---\n\n# Vault-Index\n\nBESTAND\n`,
          }
        : null,
    );

    const out = payload(await client.callTool({ name: "get_index", arguments: {} }));
    expect(out.generated).toBe(false);
    expect(out.content).toContain("BESTAND");
    expect(getTreeMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("regenerates an index older than 24h", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    getNoteMock.mockImplementation(async (id: string) =>
      id === "00_meta/INDEX"
        ? {
            id,
            title: "Vault-Index",
            body:
              `---\nid: 01KSFC0T2J8XG91RV6Z6D825X9\ntype: reference\ntitle: Vault-Index\n` +
              `created: '${old}'\nupdated: '${old}'\n---\n\n# Vault-Index\n\nVERALTET\n`,
          }
        : null,
    );
    getTreeMock.mockResolvedValue(TREE);

    const out = payload(await client.callTool({ name: "get_index", arguments: {} }));
    expect(out.generated).toBe(true);
    expect(out.content).not.toContain("VERALTET");
    expect(out.content).toContain("20_notes/alpha");
    // Stable identity across regenerations.
    expect(out.content).toContain("01KSFC0T2J8XG91RV6Z6D825X9");
  });

  it("still answers with the fresh index when the write fails", async () => {
    getNoteMock.mockResolvedValue(null);
    getTreeMock.mockResolvedValue(TREE);
    saveMock.mockRejectedValue(new Error("forgejo unreachable"));

    const res = await client.callTool({ name: "get_index", arguments: {} });
    expect(res.isError).toBeUndefined();
    const out = payload(res);
    expect(out.generated).toBe(true);
    expect(out.persisted).toBe(false);
    expect(out.content).toContain("20_notes/alpha");
  });

  it("refresh:true forces a regeneration even when the index is fresh", async () => {
    const fresh = new Date().toISOString();
    getNoteMock.mockImplementation(async (id: string) =>
      id === "00_meta/INDEX"
        ? {
            id,
            title: "Vault-Index",
            body:
              `---\nid: 01KSFC0T2J8XG91RV6Z6D825X9\ntype: reference\ntitle: Vault-Index\n` +
              `created: '${fresh}'\nupdated: '${fresh}'\n---\n\n# Vault-Index\n\nBESTAND\n`,
          }
        : null,
    );
    getTreeMock.mockResolvedValue(TREE);

    const out = payload(
      await client.callTool({ name: "get_index", arguments: { refresh: true } }),
    );
    expect(out.generated).toBe(true);
    expect(getTreeMock).toHaveBeenCalled();
  });

  /* ---- AC#2: the ladder lives in the server instructions ---- */

  it("the server instructions teach the Brain-First ladder", async () => {
    const { LOKYY_BRAIN_INSTRUCTIONS } = await import("./server.js");
    expect(LOKYY_BRAIN_INSTRUCTIONS).toContain("get_index");
    expect(LOKYY_BRAIN_INSTRUCTIONS).toContain("mode");
    expect(LOKYY_BRAIN_INSTRUCTIONS).toMatch(/deep/);
    expect(LOKYY_BRAIN_INSTRUCTIONS).toMatch(/Token/i);
    // The existing structure must survive — these headings are load-bearing
    // for every other tool's guidance.
    expect(LOKYY_BRAIN_INSTRUCTIONS).toContain("## Which tool, when");
    expect(LOKYY_BRAIN_INSTRUCTIONS).toContain("## Writing correctly");
    expect(LOKYY_BRAIN_INSTRUCTIONS).toContain("## Interpreting results & errors");
    expect(LOKYY_BRAIN_INSTRUCTIONS).toContain("## Permissions & skills");
  });

  it("every tool name still matches the MCP name pattern (no dots)", async () => {
    const { tools } = await client.listTools();
    for (const t of tools as { name: string }[]) {
      expect(t.name, `tool "${t.name}"`).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });
});
