import { serve } from "@hono/node-server";
import { initMcp } from "./mcpMount.js";
// Install the console.warn/error → ring-buffer capture as EARLY as possible so
// startup warnings (LLM registry, sleep-agent scheduler) land in /api/logs.
// This runs at module-eval time, before main() and before any other import's
// side effects log anything.
import { installConsoleCapture } from "./lib/logBuffer.js";
installConsoleCapture();
import { config } from "./config.js";
import { createApp } from "./app.js";
import {
  ensureRepo,
  getLlmProviders,
  healVaultHook,
  initCore,
  initDb,
  initLlmFromConfig,
  registerHandler,
  resumePendingMigration,
  runMigrations,
  setLlmProviders,
  sleepAgent,
  startUpdateCheckTimer,
  warmUpdateCheck,
} from "@lokyy/core";
import { youtubeHandler } from "./pipes/handlers/youtube.js";
import { crawlHandler, scrapeHandler } from "./pipes/handlers/scrape.js";
import { voiceHandler } from "./pipes/handlers/voiceHandler.js";

/**
 * lokyy-brain Server. Hält die einzige echte Git-Working-Copy des Vaults
 * und stellt Notizen, Graph und Pipes als JSON-API bereit.
 *
 * Die HTTP-Oberfläche (CORS, Auth-/Setup-Gates, Routen, MCP, statische PWA)
 * liegt in `app.ts`; hier bleiben die Prozess-Belange: Migrationen,
 * Vault-Klon, LLM-Registry, Scheduler, `serve()`.
 */

const app = createApp();

// Pipe-Handler registrieren — ein neuer Pipe ist eine Zeile mehr hier.
registerHandler("youtube", youtubeHandler);
registerHandler("url", scrapeHandler); // einzelne Seite
registerHandler("crawl", crawlHandler); // ganze Website
registerHandler("voice", voiceHandler); // OpenAI Whisper (cloud)

async function main() {
  // Story 5.8 AC#2: hand core the REAL vaults-table id so both search tiers
  // index under it. `initMcp()` later re-injects the same field with the id it
  // resolved (env, else the DB fallback) — that is the only path that fills it
  // when `LOKYY_VAULT_ID` is unset.
  initCore({ ...config, vaultId: config.lokyyVaultId });
  try {
    await runMigrations(config.databaseUrl);
    initDb(config.databaseUrl);
  } catch (err) {
    console.error("[lokyy-brain] DB init failed — server cannot start:", err);
    process.exit(1);
  }
  // Skip the initial clone when the operator hasn't wired a remote yet —
  // the Forgejo OAuth wizard will provision the working-copy via
  // `setupVaultFromForgejo` when the user picks/creates a repo. ensureRepo
  // also no-ops internally on an empty remote, but logging at this layer
  // keeps the startup banner explicit about why the vault is empty.
  if (config.gitRemote === "") {
    console.log(
      "[lokyy-brain] GIT_REMOTE not set — vault clone deferred to setup wizard.",
    );
  } else {
    // Best-effort, like every other init step below: a failed vault clone
    // (e.g. expired/again-rotated credentials, transient Forgejo outage) must
    // NOT crash the whole server — it would take the dashboard, MCP and every
    // OTHER vault down with it. Log loudly and boot; the vault simply shows
    // whatever is already on disk until the clone/pull recovers.
    try {
      await ensureRepo();
    } catch (err) {
      console.error(
        `[lokyy-brain] ensureRepo (vault clone) failed — booting anyway: ${
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        }`,
      );
    }
  }

  // ── Pre-Commit-Hook heilen (Windows-CRLF-Blocker) ──────────────────────
  // Ein mit CRLF ausgecheckter Hook macht den Vault KOMPLETT schreibunfähig:
  // der Kernel sucht den Interpreter `/bin/sh\r` und jeder Commit stirbt mit
  // `fatal: cannot exec '.githooks/pre-commit'`. Deshalb direkt nach dem
  // Klon/Pull und VOR dem ersten möglichen Write. Idempotent (ein gesunder
  // Hook kostet einen stat), wirft per Vertrag nie, und schreibt nur, wenn
  // sich wirklich etwas ändert.
  try {
    const heal = await healVaultHook();
    if (heal.status === "healed") {
      console.log(
        `[lokyy-brain] Pre-Commit-Hook repariert (Zeilenenden: ${heal.lineEndingsFixed}, ` +
          `Rechte: ${heal.modeFixed}, committet: ${heal.committed})`,
      );
    }
    if (heal.error) console.warn(`[lokyy-brain] Hook-Reparatur unvollständig — ${heal.error}`);
  } catch (err) {
    // healVaultHook wirft per Vertrag nicht; dieser catch schützt nur gegen
    // künftige Änderungen an diesem Vertrag — der Start darf hier nie sterben.
    console.warn(
      `[lokyy-brain] Hook-Selbstheilung übersprungen — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // ── LLM registry init (Phase-0 Wave C-Backend) ─────────────────────────
  // Read persisted provider configs and instantiate the runtime registry.
  // Failures here MUST NOT abort startup — a missing/broken provider is
  // expected on first boot (config empty) and recoverable via PUT /api/llm/config.
  try {
    // Auto-register Ollama when OLLAMA_HOST is set and no Ollama row exists
    // in DB yet. Ollama is the local embedding source — the deployment depends
    // on it — so we don't make the operator open the UI just to enable a
    // provider whose URL is already wired via env. Idempotent: subsequent
    // restarts find the row and skip the insert; operator-edits via the UI
    // are preserved (we never overwrite an existing row).
    let providers = await getLlmProviders();
    const ollamaHostEnv = process.env.OLLAMA_HOST?.trim();
    if (ollamaHostEnv && !providers.some((p) => p.name === "ollama")) {
      const seeded = [
        ...providers,
        {
          name: "ollama",
          enabled: true,
          baseUrl: ollamaHostEnv,
        },
      ];
      await setLlmProviders(seeded);
      providers = seeded;
      console.log(
        `[lokyy-brain] auto-registered Ollama provider from OLLAMA_HOST=${ollamaHostEnv}`,
      );
    }
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

  // ── MCP in-process init (Lese+Schreib-Endpoint /mcp, claude.ai-Connector) ──
  // Best-effort: ein MCP-Init-Fehler darf den Server NICHT abbrechen.
  try {
    await initMcp();
  } catch (err) {
    console.warn(
      `[lokyy-brain] MCP mount skipped — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  serve({ fetch: app.fetch, port: config.port });
  console.log(`lokyy-brain Server laeuft auf :${config.port}`);
  console.log(`Vault: ${config.vaultDir}`);

  // ── Update-Check aufwärmen (Story 7.12) ──────────────────────────────
  // Deliberately AFTER serve() and deliberately NOT awaited: the server is
  // already accepting requests while this runs. It fills the 6h cache once
  // per start, so "beim Start wird immer geprüft" holds without any page view
  // triggering a network request. `warmUpdateCheck` swallows every failure;
  // the extra .catch() only guards against future changes to that contract.
  void warmUpdateCheck().catch(() => {});

  // ── …und danach periodisch nachprüfen (Default alle 8 h, 3×/Tag) ──────
  // Ohne das sieht ein laufender Server ein frisches Release erst beim
  // nächsten Neustart. Der Timer ist `unref`'d und schluckt jeden Fehler:
  // weder Start noch Shutdown hängen daran. `LOKYY_UPDATE_CHECK=off` armiert
  // gar nichts, `LOKYY_UPDATE_CHECK_INTERVAL_HOURS` verschiebt den Takt.
  try {
    startUpdateCheckTimer();
  } catch (err) {
    console.warn(
      `[lokyy-brain] periodischer Update-Check nicht armiert — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

main().catch((err) => {
  console.error("Start fehlgeschlagen:", err);
  process.exit(1);
});
