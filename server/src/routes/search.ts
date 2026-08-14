import { Hono } from "hono";
import { sql } from "drizzle-orm";
import {
  database,
  EmbeddingUnavailableError,
  LlmRouter,
  RagFusion,
  Tier2Provider,
  buildSearchPipeline,
  getLlmRouting,
  getMemoryProvider,
  getNote,
  getTier1BM25,
  hybridSearch,
  isForgotten,
  listNotes,
  parseFrontmatter,
  type HybridOpts,
  type RetrieveHit,
  type SearchOpts,
  type SearchPipelineInput,
  indexVaultId,
} from "@lokyy/core";

/**
 * Search routes.
 *
 * POST /api/search             — Tier 1 + Tier 2 merged hits (Story 5.5)
 * GET  /api/notes/:id/related  — top-N related notes (Story 5.6)
 * POST /api/search/hybrid      — BM25 (pg_search) + dense (pgvector) via RRF
 *                                fusion (Phase A Wave A1 / Story 2)
 *
 * vaultId is implicit for now (single-active-vault dev mode). Once Story
 * 3's route migration to /api/vaults/:vaultId/* lands, these will move
 * under that scope.
 */


export const searchRoutes = new Hono();

/**
 * POST /api/search/reindex — one-time (re)build of the `note_search` BM25
 * corpus from every note on disk.
 *
 * WHY: the Tier-1 BM25 fast path (commit 6b01360) only serves notes that are
 * present in `note_search`. That table is populated solely by the
 * save/create/move hooks (`queueSearchIndexRefresh`), so notes that pre-date
 * the fix were never indexed — search for them falls back to the slow
 * in-memory rebuild. This endpoint walks `listNotes()` and upserts each note
 * through the SAME `Tier1BM25.upsert` path the live hooks use (reused via
 * `getTier1BM25()`), so the corpus matches the on-disk frontmatter exactly.
 *
 * Defensive by design: per-note failures are caught and counted, never thrown
 * — a single poison note can't 500 the whole run. Returns `{ indexed, ms }`.
 *
 * Gating: mounted under `/api` alongside the other `/api/search/*` routes and
 * subject to the same setup gate as its siblings (see server/src/index.ts).
 */
searchRoutes.post("/search/reindex", async (c) => {
  const started = Date.now();
  const bm25 = getTier1BM25();

  // `listNotes()` returns summaries WITHOUT body — we need the full body +
  // frontmatter to derive the `forgotten` flag and feed the BM25 corpus, so
  // each note is re-read via `getNote()`. Same derivation as the save-path
  // hook in notesService (title, body, tags, isForgotten(frontmatter)).
  const summaries = await listNotes();

  let indexed = 0;
  let failed = 0;
  for (const summary of summaries) {
    try {
      const note = await getNote(summary.id);
      if (!note) {
        // Listed but unreadable (deleted between list + read) — skip, count
        // as a soft failure rather than aborting the run.
        failed += 1;
        continue;
      }
      const forgotten = isForgotten(parseFrontmatter(note.body).data);
      await bm25.upsert(
        note.id,
        indexVaultId(),
        note.title,
        note.body,
        note.tags,
        forgotten,
      );
      indexed += 1;
    } catch {
      // Per-note errors are isolated: a malformed note must not break the
      // whole reindex. Counted so the response still reflects partial success.
      failed += 1;
    }
  }

  return c.json({ indexed, failed, ms: Date.now() - started });
});

// ─── Tier-2 embedding backfill (issue #52) ───────────────────────────────
//
// WHY THIS EXISTS: `/search/reindex` above rebuilds Tier 1 (BM25) ONLY.
// Tier 2 embeddings are written exclusively by the save path
// (`queueIndexRefresh` → `indexNote`), fire-and-forget — so every note saved
// while Ollama was down / mis-wired stayed without embeddings forever, and
// the only repair was re-saving each note by hand (a beta tester had 14 of
// 19 notes unindexed). This endpoint is the manual repair; the
// `embedding-backfill` sleep pass is the unattended one.
//
// WHY A BACKGROUND JOB INSTEAD OF A BLOCKING REQUEST: embedding one note
// costs several Ollama round-trips (title + body_full + one per H2 section)
// and on a CPU-only install each of those is seconds, not milliseconds. A
// blocking request over a realistic vault runs for minutes to hours and dies
// in a reverse-proxy read timeout — with no way to tell "still working" from
// "crashed", and the work silently continuing server-side either way. A
// batch-with-continuation design has the same defect in miniature: any batch
// large enough to be useful can still outlive the proxy timeout, and the
// caller must then guess a safe batch size per hardware. So: POST starts the
// run and returns immediately (202); GET polls progress. Every request stays
// O(ms) regardless of vault size or hardware. `limit` still bounds a single
// run so an operator can take it in deliberate steps.

interface BackfillJob {
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Notes in the vault at run start. */
  total: number;
  /** Already had embeddings → not touched (always 0 when `force`). */
  skipped: number;
  /** Verified to have embeddings after indexNote. */
  indexed: number;
  /** Threw, or produced no rows (embedding service silently down). */
  failed: number;
  /** Candidates left over — per-run `limit`, or an early abort. */
  remaining: number;
  force: boolean;
  limit: number;
  lastError: string | null;
  ms: number;
}

/**
 * Single in-flight run per process, same model as the sleep-agent's
 * `running` flag. A second POST while one is active gets a 409 with the
 * live job rather than starting a competing run — two runs would fight over
 * the same Ollama instance and halve each other's throughput.
 */
let backfillJob: BackfillJob | null = null;

const BACKFILL_DEFAULT_LIMIT = 200;
const BACKFILL_MAX_LIMIT = 5_000;

/**
 * How many consecutive notes may come back WITHOUT embeddings before the run
 * gives up. `CombinedProvider.indexNote` swallows `EmbeddingUnavailableError`
 * (Tier 2 is fire-and-forget on the save path), so a resolved `indexNote`
 * proves nothing — with Ollama down it resolves and writes no rows. Hence
 * every note is verified against `note_embeddings` afterwards, and a run
 * against a dead embedding service stops after a handful of no-ops instead
 * of walking the whole vault.
 */
const BACKFILL_CONSECUTIVE_MISS_ABORT = 5;

const emptyBackfillJob = (): BackfillJob => ({
  running: false,
  startedAt: "",
  finishedAt: null,
  total: 0,
  skipped: 0,
  indexed: 0,
  failed: 0,
  remaining: 0,
  force: false,
  limit: 0,
  lastError: null,
  ms: 0,
});

/**
 * noteIds that already have at least one chunk row.
 *
 * NOT filtered by embeddings generation: the active-generation tag is not
 * exported from `@lokyy/core`, and after a generation migration a note may
 * hold rows of the previous generation only. Effect: such a note reads as
 * "indexed" here and is skipped — `force=true` is the escape hatch, and the
 * sleep pass (inside core, where the generation IS reachable) does the
 * generation-scoped check. For the bug this endpoint repairs — notes with NO
 * embeddings at all — the two are identical.
 */
async function noteIdsWithEmbeddings(vaultId: string): Promise<Set<string>> {
  const rows = await database().execute<{ note_id: string }>(sql`
    SELECT DISTINCT note_id
    FROM note_embeddings
    WHERE vault_id = ${vaultId}
  `);
  const out = new Set<string>();
  for (const row of rows as unknown as Array<{ note_id: string }>) {
    if (typeof row.note_id === "string") out.add(row.note_id);
  }
  return out;
}

/** True once the note has at least one chunk row. */
async function noteHasEmbeddings(
  noteId: string,
  vaultId: string,
): Promise<boolean> {
  const rows = await database().execute<{ note_id: string }>(sql`
    SELECT note_id
    FROM note_embeddings
    WHERE note_id = ${noteId}
      AND vault_id = ${vaultId}
    LIMIT 1
  `);
  return (rows as unknown as unknown[]).length > 0;
}

/**
 * The run itself. Never throws — every failure lands in the job snapshot, so
 * the polling client always gets numbers instead of a dead job.
 */
async function runEmbeddingBackfill(job: BackfillJob): Promise<void> {
  const started = Date.now();
  try {
    const vaultId = indexVaultId();
    const summaries = await listNotes();
    job.total = summaries.length;

    const alreadyIndexed = job.force
      ? new Set<string>()
      : await noteIdsWithEmbeddings(vaultId);
    const candidates = summaries
      .map((s) => s.id)
      .filter((id) => !alreadyIndexed.has(id));
    job.skipped = summaries.length - candidates.length;
    job.remaining = candidates.length;

    const provider = getMemoryProvider(vaultId);
    const batch = candidates.slice(0, job.limit);
    let consecutiveMisses = 0;

    for (const noteId of batch) {
      try {
        await provider.indexNote(noteId);
        if (await noteHasEmbeddings(noteId, vaultId)) {
          job.indexed += 1;
          consecutiveMisses = 0;
        } else {
          job.failed += 1;
          consecutiveMisses += 1;
          job.lastError = `no embeddings written for "${noteId}" — embedding service (Ollama) reachable?`;
        }
      } catch (err) {
        // Per-note errors are counted, never thrown: one poison note must
        // not abort the run for every note behind it.
        job.failed += 1;
        consecutiveMisses += 1;
        job.lastError = `${noteId}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      job.remaining = Math.max(0, candidates.length - job.indexed - job.failed);
      job.ms = Date.now() - started;

      if (consecutiveMisses >= BACKFILL_CONSECUTIVE_MISS_ABORT) {
        job.lastError = `stopped early: no vectors written for ${consecutiveMisses} notes in a row — check that the embedding service is running`;
        break;
      }
    }
  } catch (err) {
    job.lastError = err instanceof Error ? err.message : String(err);
  } finally {
    job.ms = Date.now() - started;
    job.finishedAt = new Date().toISOString();
    job.running = false;
  }
}

/**
 * POST /api/search/embeddings/backfill — start a Tier-2 backfill run.
 *
 * Params (query string or JSON body, query wins):
 *   force  — `true` re-indexes every note, not just those without embeddings.
 *            Cheap in practice: `Tier2Provider` skips chunks whose content
 *            hash is unchanged, so a forced run over an up-to-date vault
 *            costs DB reads, not Ollama calls.
 *   limit  — max notes to process in THIS run (default 200, max 5000).
 *            Leftovers are reported as `remaining`; POST again to continue.
 *
 * Returns 202 `{ started: true, job }` immediately, or 409
 * `{ started: false, reason: "already_running", job }`.
 */
searchRoutes.post("/search/embeddings/backfill", async (c) => {
  if (backfillJob?.running) {
    return c.json(
      { started: false, reason: "already_running", job: backfillJob },
      409,
    );
  }

  const body = await c.req
    .json<{ force?: boolean; limit?: number }>()
    .catch(() => ({}) as { force?: boolean; limit?: number });
  const forceParam = c.req.query("force");
  const limitParam = c.req.query("limit");
  const force =
    forceParam === undefined
      ? body.force === true
      : forceParam === "1" || forceParam === "true";
  const rawLimit = Number(limitParam ?? body.limit ?? BACKFILL_DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(BACKFILL_MAX_LIMIT, Math.floor(rawLimit)))
    : BACKFILL_DEFAULT_LIMIT;

  const job: BackfillJob = {
    ...emptyBackfillJob(),
    running: true,
    startedAt: new Date().toISOString(),
    force,
    limit,
  };
  backfillJob = job;
  // Detached on purpose — see the design note above. Errors are captured
  // inside `runEmbeddingBackfill`; the `.catch` is belt-and-braces so an
  // unexpected throw can never surface as an unhandled rejection.
  void runEmbeddingBackfill(job).catch((err) => {
    job.lastError = err instanceof Error ? err.message : String(err);
    job.running = false;
    job.finishedAt = new Date().toISOString();
  });

  return c.json({ started: true, job }, 202);
});

/**
 * GET /api/search/embeddings/backfill — progress of the current/last run.
 *
 * Always answers with the full job shape (zeroed when no run ever started),
 * so the caller can render numbers without a null check:
 *   { running, startedAt, finishedAt, total, skipped, indexed, failed,
 *     remaining, force, limit, lastError, ms }
 */
searchRoutes.get("/search/embeddings/backfill", (c) => {
  return c.json(backfillJob ?? emptyBackfillJob());
});

/** Test seam — drops job state so cases start from a clean slate. */
export function _resetEmbeddingBackfillForTests(): void {
  backfillJob = null;
}

searchRoutes.post("/search", async (c) => {
  const { query, limit, tagFilter, folderPrefix } = await c.req.json<{
    query: string;
    limit?: number;
    tagFilter?: string[];
    folderPrefix?: string;
  }>();
  const opts: SearchOpts = { limit, tagFilter, folderPrefix };
  const hits = await getMemoryProvider(indexVaultId()).search(query ?? "", opts);
  return c.json({ results: hits, degraded: hits.every((h) => h.tier === "t1") && hits.length > 0 ? false : false });
});

searchRoutes.get("/notes/:id{.+}/related", async (c) => {
  const noteId = c.req.param("id");
  const limit = Number(c.req.query("limit") ?? "5");
  const hits = await getMemoryProvider(indexVaultId()).relatedNotes(noteId, { limit });
  return c.json({ results: hits });
});

/**
 * POST /api/search/hybrid — BM25 + Dense via RRF.
 *
 * Body:
 *   { query: string, intent?: "exact_recall" | "topical" | "associative" | "question",
 *     topK?: number, rrfK?: number }
 *
 * Response:
 *   { hits: [{ noteId, title, score, snippet? }],
 *     degraded?: "no_embedding" | "no_bm25" }
 *
 * Degradation:
 *   - Ollama unreachable → no query embedding → returns BM25-only via the
 *     `note_search` path (still useful). `degraded: "no_embedding"`.
 *   - Both unavailable → empty hits.
 */
searchRoutes.post("/search/hybrid", async (c) => {
  const body = await c.req.json<{
    query: string;
    intent?: HybridOpts["intent"];
    topK?: number;
    rrfK?: number;
  }>();
  const query = body.query ?? "";
  if (!query.trim()) {
    return c.json({ hits: [] });
  }

  // Embed the query via Tier-2 (which already speaks Ollama). On failure,
  // fall back to a zero-vector — the dense leg will return useless rankings
  // but the BM25 leg keeps working. Mark the response as degraded.
  const t2 = new Tier2Provider({ vaultId: indexVaultId() });
  let queryEmbedding: number[];
  let degraded: "no_embedding" | undefined;
  try {
    // Tier2Provider.embed is private — exercise it indirectly via search()
    // would re-run the SQL we want to subsume. Instead use a tiny utility:
    // call the public `indexNote` path? No — that writes. We need a
    // dedicated embed helper. Use a direct fetch matching Tier2Provider.
    queryEmbedding = await embedQuery(query);
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError || err instanceof Error) {
      // Zero-vector keeps the SQL valid; dense leg contributes no useful
      // signal so the result is effectively BM25-only.
      queryEmbedding = new Array<number>(768).fill(0);
      degraded = "no_embedding";
    } else {
      throw err;
    }
  }

  const hits = await hybridSearch(query, queryEmbedding, {
    intent: body.intent,
    topK: body.topK,
    rrfK: body.rrfK,
    vaultId: indexVaultId(),
  });
  // Eliminate accidental unused-binding lint on t2 — placeholder until the
  // embed helper migrates into core.
  void t2;
  return c.json(degraded ? { hits, degraded } : { hits });
});

/**
 * Local embedding helper — mirrors Tier2Provider.embed. Lives here until a
 * dedicated embed-only export lands in core; duplicates ~15 lines for now.
 */
async function embedQuery(text: string): Promise<number[]> {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  const model = "nomic-embed-text";
  const res = await fetch(`${host}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}`);
  const data = (await res.json()) as { embedding: number[] };
  if (!Array.isArray(data.embedding) || data.embedding.length !== 768) {
    throw new Error(`Unexpected embedding shape: ${data.embedding?.length}`);
  }
  return data.embedding;
}

/**
 * POST /api/search/rag-fusion — Multi-Query Rewrite + RRF (Phase B Wave B1 / Story 3).
 *
 * Body:
 *   { query: string, numRewrites?: number, rrfK?: number, topK?: number,
 *     includeOriginal?: boolean, intent?: HybridOpts["intent"] }
 *
 * Response:
 *   { rewrites: [{ text, isOriginal }],
 *     fused:    [{ noteId, title?, score, sources }],
 *     durationMs, degraded? }
 *
 * The retrieval function passed to `RagFusion` wraps `hybridSearch` so each
 * variant gets the full BM25+dense pipeline. Embedding failures degrade
 * gracefully to a zero-vector (BM25-only) per variant — same behaviour as
 * `/api/search/hybrid`. LLM rewrite failures degrade to original-only and
 * are flagged via `degraded: true` in the response.
 */
let _ragRouter: LlmRouter | null = null;
async function getRagRouter(): Promise<LlmRouter> {
  if (!_ragRouter) {
    const routing = await getLlmRouting();
    _ragRouter = new LlmRouter(routing);
  }
  return _ragRouter;
}

searchRoutes.post("/search/rag-fusion", async (c) => {
  const body = await c.req.json<{
    query?: string;
    numRewrites?: number;
    rrfK?: number;
    topK?: number;
    includeOriginal?: boolean;
    intent?: HybridOpts["intent"];
  }>();
  const query = (body.query ?? "").trim();
  if (query.length === 0) {
    return c.json({ rewrites: [], fused: [], durationMs: 0 });
  }

  const router = await getRagRouter();

  // Wrap hybridSearch into a uniform retrieval-fn the fuser expects.
  // Embedding errors per-variant are absorbed into a zero-vector so the
  // BM25 leg still contributes — mirrors /api/search/hybrid.
  const retrieve = async (variant: string): Promise<RetrieveHit[]> => {
    let embedding: number[];
    try {
      embedding = await embedQuery(variant);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError || err instanceof Error) {
        embedding = new Array<number>(768).fill(0);
      } else {
        throw err;
      }
    }
    const hits = await hybridSearch(variant, embedding, {
      intent: body.intent,
      topK: body.topK,
      rrfK: body.rrfK,
      vaultId: indexVaultId(),
    });
    return hits.map((h) => ({ noteId: h.noteId, score: h.score }));
  };

  const fuser = new RagFusion(router, retrieve);
  const result = await fuser.fuse(query, {
    numRewrites: body.numRewrites,
    rrfK: body.rrfK,
    topK: body.topK,
    includeOriginal: body.includeOriginal,
  });

  // Enrich fused hits with note titles so the PWA doesn't need an extra
  // round-trip. Missing notes (deleted between index and request) are
  // dropped silently — same policy as other search routes.
  const enriched = await Promise.all(
    result.fused.map(async (h) => {
      const note = await getNote(h.noteId);
      if (!note) return null;
      return {
        noteId: h.noteId,
        title: note.title,
        score: h.score,
        sources: h.sources,
      };
    }),
  );

  return c.json({
    rewrites: result.rewrites,
    fused: enriched.filter((x): x is NonNullable<typeof x> => x !== null),
    durationMs: result.durationMs,
    ...(result.degraded ? { degraded: true } : {}),
  });
});

/**
 * POST /api/search/pipeline — Phase B Wave B3 / Story 2.
 *
 * Run the full 8-step cognitive retrieval pipeline:
 *   conversational rewrite → intent classify → hybrid (or RAG-Fusion for
 *   question intent) → working-memory boost → PPR (associative only) →
 *   encoding-context boost → rerank → lost-in-middle layout → generate
 *   with Self-RAG reflection.
 *
 * Body matches `SearchPipelineInput`:
 *   { query: string,
 *     conversationHistory?, sessionId?, sessionContext?,
 *     generate?, forceIntent?, maxRetrievalHops?, vaultId? }
 *
 * Response is the full `SearchPipelineResult` including per-step
 * telemetry and `degraded[]` flags. The pipeline never throws — caller
 * always gets a result, possibly with `rerankedHits: []` if retrieval
 * found nothing.
 *
 * Note on cost: when `generate=true` and the LLM judges the answer
 * incomplete, the pipeline may issue up to `maxRetrievalHops-1` extra
 * direct-hybrid retrievals + LLM regenerations. Cap at the default 3
 * if you care about p99 latency; bump for research-grade answers.
 */
searchRoutes.post("/search/pipeline", async (c) => {
  // Reuse the request's JSON as `SearchPipelineInput`. Defensive: missing
  // body / missing query short-circuits with an empty-shape response so
  // the PWA gets predictable JSON instead of a 400.
  let body: Partial<SearchPipelineInput>;
  try {
    body = (await c.req.json()) as Partial<SearchPipelineInput>;
  } catch {
    body = {};
  }
  const query = (body.query ?? "").trim();
  if (query.length === 0) {
    return c.json({
      query: "",
      rewrittenQuery: "",
      intent: "topical" as const,
      hops: 0,
      totalDurationMs: 0,
      steps: [],
      rerankedHits: [],
      degraded: ["empty_query"],
    });
  }
  const pipeline = await buildSearchPipeline();
  // Cast through SearchPipelineInput so optional fields propagate without
  // re-declaring the body shape here.
  const result = await pipeline.execute({ ...body, query } as SearchPipelineInput);
  return c.json(result);
});

export { getNote };
