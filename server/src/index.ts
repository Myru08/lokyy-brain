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
import { pprRoutes } from "./routes/ppr.js";
import { rerankRoutes } from "./routes/rerank.js";
import { surfaceRoutes, workingMemoryRoutes } from "./routes/surface.js";
import { layoutRoutes } from "./routes/layout.js";
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
