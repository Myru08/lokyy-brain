import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import {
  ensureRepo,
  getLlmProviders,
  initCore,
  initDb,
  initLlmFromConfig,
  registerHandler,
  resumePendingMigration,
  runMigrations,
  sleepAgent,
} from "@lokyy/core";
import { notesRoutes } from "./routes/notes.js";
import { vaultRoutes } from "./routes/vault.js";
import { graphRoutes } from "./routes/graph.js";
import { pipesRoutes } from "./routes/pipes.js";
import { setupRoutes } from "./routes/setup.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { searchRoutes } from "./routes/search.js";
import { dataviewRoutes } from "./routes/dataview.js";
import { templatesRoutes } from "./routes/templates.js";
import { settingsRoutes } from "./routes/settings.js";
import { llmRoutes } from "./routes/llm.js";
import { llmMigrationRoutes } from "./routes/llm-migration.js";
import { scoringRoutes } from "./routes/scoring.js";
import { intentRoutes } from "./routes/intent.js";
import { hydeRoutes } from "./routes/hyde.js";
import { selfRagRoutes } from "./routes/self-rag.js";
import { tracesRoutes } from "./routes/traces.js";
import { sleepAgentRoutes } from "./routes/sleep-agent.js";
import { mem0ReviewRoutes } from "./routes/mem0-review.js";
import { pprRoutes } from "./routes/ppr.js";
import { rerankRoutes } from "./routes/rerank.js";
import { surfaceRoutes, workingMemoryRoutes } from "./routes/surface.js";
import { layoutRoutes } from "./routes/layout.js";
import { encodingRoutes } from "./routes/encoding.js";
import { edgesRoutes } from "./routes/edges.js";
import { temporalEdgesRoutes } from "./routes/temporal-edges.js";
import { lintRoutes } from "./routes/lint.js";
import { agentReviewRoutes } from "./routes/agent-review.js";
import { entitiesRoutes } from "./routes/entities.js";
import { peersRoutes } from "./routes/peers.js";
import { forgetRoutes } from "./routes/forget.js";
import { backfillRoutes } from "./routes/backfill.js";
import { setupGate } from "./middleware/setupGate.js";
import { youtubeHandler } from "./pipes/handlers/youtube.js";
import { crawlHandler, scrapeHandler } from "./pipes/handlers/scrape.js";

/**
 * lokyy-brain Server. Hält die einzige echte Git-Working-Copy des Vaults
 * und stellt Notizen, Graph und Pipes als JSON-API bereit.
 */

const app = new Hono();

// einfaches CORS fuer die getrennt laufende PWA im Dev
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

// Setup + auth endpoints — always reachable (auth needs to work before setup,
// and register/login obviously can't sit behind setupGate).
app.route("/api/setup", setupRoutes);
app.route("/api/auth", authRoutes);

// Data + admin routes — gated by setup state.
app.use("/api/notes/*", setupGate);
app.use("/api/vault/*", setupGate);
app.use("/api/graph/*", setupGate);
app.use("/api/pipes/*", setupGate);
app.use("/api/admin/*", setupGate);
app.use("/api/llm/*", setupGate);
app.route("/api/admin", adminRoutes);
app.route("/api/llm", llmRoutes);
app.route("/api/llm/migration", llmMigrationRoutes);

// Phase A Wave A1 / Story 1 — importance scoring.
app.use("/api/scoring/*", setupGate);
app.route("/api/scoring", scoringRoutes);

// Phase A Wave A1 / Story 4 — intent classification (pre-retrieval routing).
app.use("/api/intent/*", setupGate);
app.route("/api/intent", intentRoutes);

// Phase B Wave B1 / Story 2 — HyDE (Hypothetical Document Embedding).
// Triggered for question-intent queries — see packages/core/src/llm/hyde.ts.
app.use("/api/hyde", setupGate);
app.use("/api/hyde/*", setupGate);
app.route("/api/hyde", hydeRoutes);

// Phase B Wave B1 / Story 4 — Self-RAG-style Reflection (prompt-level).
// Two endpoints: /reflect for post-generation hop-decisions, /critique for
// pre-generation per-chunk relevance filtering. See packages/core/src/llm/selfRag.ts.
app.use("/api/self-rag", setupGate);
app.use("/api/self-rag/*", setupGate);
app.route("/api/self-rag", selfRagRoutes);

// Phase A Wave A1 / Story 3 — Retrieval-Trace-Log (Multi-Trace-Theory).
// Fire-and-forget telemetry endpoint for non-API retrieval sources
// (cmd-k, cmd-o, wikilink, hover, embed). Server-side note GETs call
// `logRetrieval` directly inside notesRoutes — no round-trip needed.
app.use("/api/traces", setupGate);
app.use("/api/traces/*", setupGate);
app.route("/api/traces", tracesRoutes);

// Phase A Wave A2 / Story 7 — Sleep-Agent walking skeleton.
// Manual triggers, run history, cancellation. Idle + nightly scheduler is
// armed below in main() after the LLM registry is up.
app.use("/api/sleep-agent", setupGate);
app.use("/api/sleep-agent/*", setupGate);
app.route("/api/sleep-agent", sleepAgentRoutes);

// Phase D Wave D1 / Story 1 — ULID-Backfill for legacy notes.
//   POST /api/backfill/ulid     manual trigger (delegates to sleepAgent).
//   GET  /api/backfill/status   pending count (notes without ULID).
// The PWA Settings page mounts a "Vault-Wartung" section that hits these.
app.use("/api/backfill", setupGate);
app.use("/api/backfill/*", setupGate);
app.route("/api/backfill", backfillRoutes);

// Phase C Wave C1 / Story 1 — Mem0 review queue.
// Lists/accepts/rejects ADD/UPDATE/DELETE/NOOP decisions emitted by the
// `mem0-classifier` REM-sleep pass. Vault mutations only happen on accept,
// never inside the classifier itself.
app.use("/api/mem0", setupGate);
app.use("/api/mem0/*", setupGate);
app.route("/api/mem0/review", mem0ReviewRoutes);

// Phase B Wave B1 / Story 1 — Personalized PageRank (HippoRAG-style)
// über den Wikilink-Graph. Seeds aus RRF-Top-N → spreading activation.
app.use("/api/ppr", setupGate);
app.use("/api/ppr/*", setupGate);
app.route("/api/ppr", pprRoutes);

// Phase B Wave B2 / Story 1 — Re-Ranker (Cohere Rerank-3 / LocalReranker)
// mit Importance-Score-Boost. Zweite Retrieval-Stufe nach Hybrid+PPR.
app.use("/api/rerank", setupGate);
app.use("/api/rerank/*", setupGate);
app.route("/api/rerank", rerankRoutes);

// Phase B Wave B2 / Story 2 — Working-Memory + Spacing-Effect-Surfacing.
//   /api/surface/*         → cold-notes-linked-to-hot-notes (runtime computed)
//   /api/working-memory/*  → in-process per-session retrieval cache + boosts
app.use("/api/surface", setupGate);
app.use("/api/surface/*", setupGate);
app.use("/api/working-memory", setupGate);
app.use("/api/working-memory/*", setupGate);
app.route("/api/surface", surfaceRoutes);
app.route("/api/working-memory", workingMemoryRoutes);

// Phase B Wave B2 / Story 3 — Lost-in-the-Middle Context-Layout.
// Pure debug/preview endpoint — composes the prompt that downstream
// answer-routes will send to the LLM. No model calls, no state.
app.use("/api/layout", setupGate);
app.use("/api/layout/*", setupGate);
app.route("/api/layout", layoutRoutes);

// Phase B Wave B3 / Story 1 — Encoding-Context-Match-Boost (Tulving 1973).
//   /api/encoding/capture       → derive an EncodedContext from request UA + body
//   /api/encoding/match-boost   → batch-apply context-match-boost to scored hits
// Pure compute, no DB / git. Keeps the matching logic available outside
// the in-process createNote path (pipe handlers, MCP, future Wave B3 Story 2).
app.use("/api/encoding", setupGate);
app.use("/api/encoding/*", setupGate);
app.route("/api/encoding", encodingRoutes);

// Phase C Wave C1 / Story 4 — Synaptic-Pruning (Tononi & Cirelli 2003/2014/2020).
//   /api/edges/pruned       → graveyard listing
//   /api/edges/resurrect    → un-prune a single edge (user intervention)
//   /api/edges/weights      → all tracked outbound edges for a note
//   /api/edges/weight       → single edge weight (or null)
// The actual pruning happens inside the NREM `synaptic-pruning` sleep pass.
app.use("/api/edges", setupGate);
app.use("/api/edges/*", setupGate);
app.route("/api/edges", edgesRoutes);

// Phase C Wave C2 / Story 1 — Bi-Temporal Edges (Graphiti pattern).
//   GET  /api/temporal-edges/from/:noteId             active outbound edges
//   GET  /api/temporal-edges/from/:noteId/at?ts=ISO   point-in-time query
//   POST /api/temporal-edges/invalidate               mark an edge invalid
//   GET  /api/temporal-edges/history/:edgeId          full (from,to,kind) lineage
// Writes (note-save / note-create) populate temporal_edges via a fire-and-
// forget hook in notesService.
app.use("/api/temporal-edges", setupGate);
app.use("/api/temporal-edges/*", setupGate);
app.route("/api/temporal-edges", temporalEdgesRoutes);

// Phase C Wave C1 / Story 3 — Karpathy-Lint review queue.
//   GET  /api/lint/findings?status=open&kind=...
//   POST /api/lint/findings/:id/acknowledge
//   POST /api/lint/findings/:id/dismiss
//   POST /api/lint/findings/:id/mark-fixed
// The findings themselves are produced by the `karpathy-lint` sleep-pass
// (phase=`lint`); this route is read + transition only.
app.use("/api/lint", setupGate);
app.use("/api/lint/*", setupGate);
app.route("/api/lint", lintRoutes);

// Phase C Wave C3 / Story 1 — Aggregated user-acceptance dashboard.
//   GET  /api/agent-review/queue                   pending mem0 + lint + topic-notes
//   POST /api/agent-review/topic-note/:id/accept   move to user folder, mark curated
//   POST /api/agent-review/topic-note/:id/reject   delete the auto-generated note
// Backed by mem0_review_queue + lint_findings + 70_pai/topics/auto-* on disk.
app.use("/api/agent-review", setupGate);
app.use("/api/agent-review/*", setupGate);
app.route("/api/agent-review", agentReviewRoutes);

// Phase C Wave C2 / Story 2 — Entity-Extraction-Pipeline.
//   GET /api/entities?type=person&limit=50&minMentions=2
//   GET /api/entities/by-note/:noteId
//   GET /api/entities/:id
//   GET /api/entities/:id/notes
//   GET /api/entities/:id/co-occurrence?limit=20
// The mention rows are produced by the `entity-extraction` REM sleep-pass
// (LLM-as-NER via the `ner`-role provider); routes are read-only.
app.use("/api/entities", setupGate);
app.use("/api/entities/*", setupGate);
app.route("/api/entities", entitiesRoutes);

// Phase C Wave C2 / Story 3 — Honcho peer abstraction.
//   GET  /api/peers                                  all peer profiles
//   GET  /api/peers/suggestions?minMentions=5        unbacked person-entities
//   GET  /api/peers/:noteId                          one peer profile
//   POST /api/peers/from-entity { entityId, peerType } materialize peer-note
//   POST /api/peers/:noteId/recompute                refresh sidecar
// Sidecar is written by the `peer-profile-update` REM sleep-pass; routes
// are read + materialize + manual-recompute. Frontmatter is the source of
// truth, the DB is an index.
app.use("/api/peers", setupGate);
app.use("/api/peers/*", setupGate);
app.route("/api/peers", peersRoutes);

// Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
//   POST /api/notes/:id/forget    → set frontmatter.forgotten = ISO-ts
//   POST /api/notes/:id/unforget  → remove frontmatter.forgotten
// MUST be registered BEFORE `app.route("/api/notes", notesRoutes)` so the
// literal `/forget` and `/unforget` suffixes win over the catch-all
// `/:id{.+}` PUT inside notesRoutes. Hono dispatches in registration
// order. Already covered by the `/api/notes/*` setupGate above.
app.route("/api", forgetRoutes);

app.use("/api/search", setupGate);
app.use("/api/dataview", setupGate);
app.use("/api/dataview/*", setupGate);
app.use("/api/templates", setupGate);
app.use("/api/templates/*", setupGate);
app.route("/api/notes", notesRoutes);
app.route("/api/vault", vaultRoutes);
app.route("/api/graph", graphRoutes);
app.route("/api/pipes", pipesRoutes);
app.route("/api", searchRoutes);
app.route("/api/dataview", dataviewRoutes);
app.route("/api/templates", templatesRoutes);

// Read-only Einstellungen für die PWA (Story 4b: import defaults).
// Bewusst KEIN setupGate — die PWA fragt diese Defaults beim Mount ab und
// darf nicht in eine Setup-Wall laufen, wenn der Setup schon durch ist.
app.use("/api/settings/*", setupGate);
app.route("/api/settings", settingsRoutes);

// Pipe-Handler registrieren — ein neuer Pipe ist eine Zeile mehr hier.
registerHandler("youtube", youtubeHandler);
registerHandler("url", scrapeHandler); // einzelne Seite
registerHandler("crawl", crawlHandler); // ganze Website
// registerHandler("voice", voiceHandler);  // TODO: self-hosted Whisper

async function main() {
  initCore(config);
  try {
    await runMigrations(config.databaseUrl);
    initDb(config.databaseUrl);
  } catch (err) {
    console.error("[lokyy-brain] DB init failed — server cannot start:", err);
    process.exit(1);
  }
  await ensureRepo();

  // ── LLM registry init (Phase-0 Wave C-Backend) ─────────────────────────
  // Read persisted provider configs and instantiate the runtime registry.
  // Failures here MUST NOT abort startup — a missing/broken provider is
  // expected on first boot (config empty) and recoverable via PUT /api/llm/config.
  try {
    const providers = await getLlmProviders();
    const result = await initLlmFromConfig(providers);
    console.log(
      `[lokyy-brain] LLM registry initialised — registered: [${result.registered.join(", ")}], errors: ${result.errors.length}`,
    );
    for (const e of result.errors) {
      console.warn(`[lokyy-brain] LLM provider ${e.providerName} failed: ${e.error}`);
    }
  } catch (err) {
    console.warn(
      `[lokyy-brain] LLM registry init skipped — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Resume any in-flight embedding migration (Phase-0 Wave D) ─────────
  // A migration row in status=pending/running means the previous process
  // exited mid-run. Re-spawn the worker, skipping notes already marked done.
  // Failures here MUST NOT abort startup.
  try {
    await resumePendingMigration();
  } catch (err) {
    console.warn(
      `[lokyy-brain] resumePendingMigration skipped — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Sleep-Agent scheduler (Phase A Wave A2 / Story 7) ─────────────────
  // Arm the idle + nightly timers. Best-effort: a failure here must NOT
  // prevent the server from accepting requests — manual triggers via
  // /api/sleep-agent/trigger still work even if the scheduler didn't arm.
  try {
    sleepAgent().startScheduler();
    console.log("[lokyy-brain] sleep-agent scheduler armed (idle=30min, nightly=03:00)");
  } catch (err) {
    console.warn(
      `[lokyy-brain] sleep-agent scheduler skipped — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  serve({ fetch: app.fetch, port: config.port });
  console.log(`lokyy-brain Server laeuft auf :${config.port}`);
  console.log(`Vault: ${config.vaultDir}`);
}

main().catch((err) => {
  console.error("Start fehlgeschlagen:", err);
  process.exit(1);
});
