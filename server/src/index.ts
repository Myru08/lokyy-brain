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

  serve({ fetch: app.fetch, port: config.port });
  console.log(`lokyy-brain Server laeuft auf :${config.port}`);
  console.log(`Vault: ${config.vaultDir}`);
}

main().catch((err) => {
  console.error("Start fehlgeschlagen:", err);
  process.exit(1);
});
