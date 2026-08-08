import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import { getVaultById, vaultConfigFor, withCoreConfig } from "@lokyy/core";
import { config } from "./config.js";
import { mountMcp } from "./mcpMount.js";
import { applyApiGuards } from "./middleware/apiGuards.js";
import { setupGate } from "./middleware/setupGate.js";
import { notesRoutes } from "./routes/notes.js";
import { vaultRoutes } from "./routes/vault.js";
import { graphRoutes } from "./routes/graph.js";
import { pipesRoutes } from "./routes/pipes.js";
import { setupRoutes } from "./routes/setup.js";
import { tenantRoutes } from "./routes/tenants.js";
import { vaultsRoutes } from "./routes/vaults.js";
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
import { skillsRoutes } from "./routes/skills.js";
import { forgejoApiRoutes, forgejoOauthRoutes } from "./routes/forgejoOauth.js";
import { voiceRoutes, voiceTitleRoutes } from "./routes/voice.js";
import { voiceSettingsRoutes } from "./routes/voice-settings.js";
import { systemRoutes } from "./routes/system.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { logsRoutes } from "./routes/logs.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { dashboardRoutes } from "./routes/dashboard.js";

/**
 * The lokyy-brain HTTP surface: CORS, the vault switcher, the auth/setup
 * guards, every route group, the MCP mount and the static PWA — in the order
 * Hono dispatches them.
 *
 * Split out of `index.ts` so the mount table can be exercised by tests
 * (`middleware/apiGuards.test.ts` builds the REAL app and asserts that no
 * data route answers an anonymous caller). `index.ts` keeps process
 * concerns: migrations, vault clone, schedulers, `serve()`.
 */

/**
 * Dev fallback for {@link corsOrigins}: Vite's default listeners.
 *
 * In the normal dev loop these are never used — `pwa/vite.config.ts` proxies
 * `/api` to `http://localhost:8787`, so the browser only ever talks to its own
 * origin and CORS does not enter the picture at all. They exist for the case
 * where someone points a separately-served frontend straight at the API port.
 */
const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const;

/**
 * Allowed browser origins for `/api/*`, from `LOKYY_CORS_ORIGINS`
 * (comma-separated, e.g. `https://brain.example.com,https://lokyy.example.com`).
 *
 * There is deliberately no wildcard option. These endpoints authenticate with
 * a cookie, and `Access-Control-Allow-Origin: *` — which is what this server
 * sent until Story #37 — cannot be combined with credentials anyway: it hands
 * every site on the internet a readable response as soon as a browser is
 * willing to attach the session. Same-origin deployments (the single-service
 * container, and dev via the Vite proxy) need no entry here at all.
 */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.LOKYY_CORS_ORIGINS?.trim();
  if (!raw) return [...DEFAULT_CORS_ORIGINS];
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0);
}

export function createApp(): Hono {
  const app = new Hono();

  // ── CORS ────────────────────────────────────────────────────────────────
  // Scoped to /api/* and to a configured origin list. `credentials: true`
  // is what lets a cross-origin frontend send `lokyy_session` at all; it is
  // only ever paired with an explicit origin, never a wildcard.
  app.use(
    "/api/*",
    cors({
      origin: corsOrigins(),
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  // MCP keeps the permissive wildcard it has always had. It is authenticated
  // per request by a bearer token and never by a cookie, so a readable
  // cross-origin response requires the caller to already hold the secret —
  // the risk the /api rules exist to remove does not apply here. Production
  // additionally fronts /mcp with the Caddyfile's claude.ai rules; keeping the
  // in-process headers identical to before means that path is untouched.
  app.use(
    "/mcp",
    cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] }),
  );
  app.use(
    "/mcp/*",
    cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] }),
  );

  // Owner vault-switcher (LBMT-C): a `lokyy_vault` cookie rebinds API requests to
  // the selected vault via withCoreConfig — notes/tree/graph/dashboard then read
  // THAT vault's working copy. No cookie or the personal singleton → default
  // behaviour (the vault at config.vaultDir). MCP is unaffected (it routes by
  // bearer token, not cookie). Scoped to /api/* so static assets never hit the DB.
  //
  // The `lokyy_session` check keeps an anonymous caller from spending a database
  // lookup here: the switcher is a logged-in UI affordance, and every route it
  // affects now demands a session a few lines below anyway.
  app.use("/api/*", async (c, next) => {
    const selected = getCookie(c, "lokyy_vault");
    if (!selected || selected === config.lokyyVaultId) return next();
    if (!getCookie(c, "lokyy_session")) return next();
    const vault = await getVaultById(selected);
    if (!vault || vault.id === config.lokyyVaultId) return next();
    const cfg = vaultConfigFor({
      vaultId: vault.id,
      gitRemote: vault.gitRemote,
      gitBranch: vault.gitBranch,
    });
    return withCoreConfig(cfg, () => next());
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // Setup + auth endpoints — always reachable (auth needs to work before setup,
  // and register/login obviously can't sit behind setupGate).
  app.route("/api/setup", setupRoutes);
  app.route("/api/tenants", tenantRoutes);
  app.route("/api/vaults", vaultsRoutes);
  app.route("/api/auth", authRoutes);

  // Forgejo OAuth (setup-wizard). Not setupGate-protected — the whole point
  // is to run BEFORE setup is complete. The /api/forgejo/* helpers also stay
  // open here so the wizard can list/create repos before flipping the setup
  // flag; they enforce their own session check + token-present check.
  app.route("/api/auth/forgejo", forgejoOauthRoutes);
  app.route("/api/forgejo", forgejoApiRoutes);

  // ── Auth + setup guards for every data route ────────────────────────────
  // One table, applied before a single data route is mounted. See
  // `middleware/apiGuards.ts` for what is guarded, what is deliberately open,
  // and why `requireAuth` runs ahead of `setupGate`.
  applyApiGuards(app);

  // `/api/admin` is the one data prefix that is NOT in the table: `adminRoutes`
  // applies `requireAdmin` to `*` itself, which is strictly stronger than
  // `requireAuth`. Stacking both would only buy a second session lookup per
  // request, so admin keeps the setup gate here and its own auth inside.
  app.use("/api/admin/*", setupGate);
  app.route("/api/admin", adminRoutes);
  app.route("/api/llm", llmRoutes);
  app.route("/api/llm/migration", llmMigrationRoutes);

  // In-app diagnostics + log viewer (Observability epic). Lets the operator see
  // per-service self-test results and a recent-events ring buffer WITHOUT
  // Coolify/SSH.
  //   GET /api/diagnostics            per-service checks + ranAt
  //   GET /api/logs?limit=&level=&service=   ring-buffer events, newest-first
  app.route("/api/diagnostics", diagnosticsRoutes);
  app.route("/api/logs", logsRoutes);

  // Phase A Wave A1 / Story 1 — importance scoring.
  app.route("/api/scoring", scoringRoutes);

  // Phase A Wave A1 / Story 4 — intent classification (pre-retrieval routing).
  app.route("/api/intent", intentRoutes);

  // Phase B Wave B1 / Story 2 — HyDE (Hypothetical Document Embedding).
  // Triggered for question-intent queries — see packages/core/src/llm/hyde.ts.
  app.route("/api/hyde", hydeRoutes);

  // Phase B Wave B1 / Story 4 — Self-RAG-style Reflection (prompt-level).
  // Two endpoints: /reflect for post-generation hop-decisions, /critique for
  // pre-generation per-chunk relevance filtering. See packages/core/src/llm/selfRag.ts.
  app.route("/api/self-rag", selfRagRoutes);

  // Phase A Wave A1 / Story 3 — Retrieval-Trace-Log (Multi-Trace-Theory).
  // Fire-and-forget telemetry endpoint for non-API retrieval sources
  // (cmd-k, cmd-o, wikilink, hover, embed). Server-side note GETs call
  // `logRetrieval` directly inside notesRoutes — no round-trip needed.
  app.route("/api/traces", tracesRoutes);

  // Phase A Wave A2 / Story 7 — Sleep-Agent walking skeleton.
  // Manual triggers, run history, cancellation. Idle + nightly scheduler is
  // armed in index.ts's main() after the LLM registry is up.
  app.route("/api/sleep-agent", sleepAgentRoutes);

  // Phase D Wave D1 / Story 1 — ULID-Backfill for legacy notes.
  //   POST /api/backfill/ulid     manual trigger (delegates to sleepAgent).
  //   GET  /api/backfill/status   pending count (notes without ULID).
  // The PWA Settings page mounts a "Vault-Wartung" section that hits these.
  app.route("/api/backfill", backfillRoutes);

  // Phase C Wave C1 / Story 1 — Mem0 review queue.
  // Lists/accepts/rejects ADD/UPDATE/DELETE/NOOP decisions emitted by the
  // `mem0-classifier` REM-sleep pass. Vault mutations only happen on accept,
  // never inside the classifier itself.
  app.route("/api/mem0/review", mem0ReviewRoutes);

  // Phase B Wave B1 / Story 1 — Personalized PageRank (HippoRAG-style)
  // über den Wikilink-Graph. Seeds aus RRF-Top-N → spreading activation.
  app.route("/api/ppr", pprRoutes);

  // Phase B Wave B2 / Story 1 — Re-Ranker (Cohere Rerank-3 / LocalReranker)
  // mit Importance-Score-Boost. Zweite Retrieval-Stufe nach Hybrid+PPR.
  app.route("/api/rerank", rerankRoutes);

  // Phase B Wave B2 / Story 2 — Working-Memory + Spacing-Effect-Surfacing.
  //   /api/surface/*         → cold-notes-linked-to-hot-notes (runtime computed)
  //   /api/working-memory/*  → in-process per-session retrieval cache + boosts
  app.route("/api/surface", surfaceRoutes);
  app.route("/api/working-memory", workingMemoryRoutes);

  // Phase B Wave B2 / Story 3 — Lost-in-the-Middle Context-Layout.
  // Pure debug/preview endpoint — composes the prompt that downstream
  // answer-routes will send to the LLM. No model calls, no state.
  app.route("/api/layout", layoutRoutes);

  // Phase B Wave B3 / Story 1 — Encoding-Context-Match-Boost (Tulving 1973).
  //   /api/encoding/capture       → derive an EncodedContext from request UA + body
  //   /api/encoding/match-boost   → batch-apply context-match-boost to scored hits
  // Pure compute, no DB / git. Keeps the matching logic available outside
  // the in-process createNote path (pipe handlers, MCP, future Wave B3 Story 2).
  app.route("/api/encoding", encodingRoutes);

  // Phase C Wave C1 / Story 4 — Synaptic-Pruning (Tononi & Cirelli 2003/2014/2020).
  //   /api/edges/pruned       → graveyard listing
  //   /api/edges/resurrect    → un-prune a single edge (user intervention)
  //   /api/edges/weights      → all tracked outbound edges for a note
  //   /api/edges/weight       → single edge weight (or null)
  // The actual pruning happens inside the NREM `synaptic-pruning` sleep pass.
  app.route("/api/edges", edgesRoutes);

  // Phase C Wave C2 / Story 1 — Bi-Temporal Edges (Graphiti pattern).
  //   GET  /api/temporal-edges/from/:noteId             active outbound edges
  //   GET  /api/temporal-edges/from/:noteId/at?ts=ISO   point-in-time query
  //   POST /api/temporal-edges/invalidate               mark an edge invalid
  //   GET  /api/temporal-edges/history/:edgeId          full (from,to,kind) lineage
  // Writes (note-save / note-create) populate temporal_edges via a fire-and-
  // forget hook in notesService.
  app.route("/api/temporal-edges", temporalEdgesRoutes);

  // Phase C Wave C1 / Story 3 — Karpathy-Lint review queue.
  //   GET  /api/lint/findings?status=open&kind=...
  //   POST /api/lint/findings/:id/acknowledge
  //   POST /api/lint/findings/:id/dismiss
  //   POST /api/lint/findings/:id/mark-fixed
  // The findings themselves are produced by the `karpathy-lint` sleep-pass
  // (phase=`lint`); this route is read + transition only.
  app.route("/api/lint", lintRoutes);

  // Phase C Wave C3 / Story 1 — Aggregated user-acceptance dashboard.
  //   GET  /api/agent-review/queue                   pending mem0 + lint + topic-notes
  //   POST /api/agent-review/topic-note/:id/accept   move to user folder, mark curated
  //   POST /api/agent-review/topic-note/:id/reject   delete the auto-generated note
  // Backed by mem0_review_queue + lint_findings + 70_pai/topics/auto-* on disk.
  app.route("/api/agent-review", agentReviewRoutes);

  // Phase C Wave C2 / Story 2 — Entity-Extraction-Pipeline.
  //   GET /api/entities?type=person&limit=50&minMentions=2
  //   GET /api/entities/by-note/:noteId
  //   GET /api/entities/:id
  //   GET /api/entities/:id/notes
  //   GET /api/entities/:id/co-occurrence?limit=20
  // The mention rows are produced by the `entity-extraction` REM sleep-pass
  // (LLM-as-NER via the `ner`-role provider); routes are read-only.
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
  app.route("/api/peers", peersRoutes);

  // Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive.
  //   POST /api/notes/:id/forget    → set frontmatter.forgotten = ISO-ts
  //   POST /api/notes/:id/unforget  → remove frontmatter.forgotten
  // MUST be registered BEFORE `app.route("/api/notes", notesRoutes)` so the
  // literal `/forget` and `/unforget` suffixes win over the catch-all
  // `/:id{.+}` PUT inside notesRoutes. Hono dispatches in registration
  // order. Already covered by the `/api/notes` guards above.
  app.route("/api", forgetRoutes);

  app.route("/api/notes", notesRoutes);
  app.route("/api/vault", vaultRoutes);
  app.route("/api/graph", graphRoutes);
  // Voice pipe: multipart upload endpoint. Sub-route under /api/pipes/voice.
  // Must be mounted before the generic pipesRoutes so Hono dispatches the more
  // specific path first.
  app.route("/api/pipes/voice", voiceRoutes);
  app.route("/api/pipes", pipesRoutes);

  // Epic 12 / Story 12.3 — folder-skill import.
  //   POST /api/skills/import   multipart folder upload → core importSkill →
  //                             70_pai/skills/<slug>/ written through gitService.
  // Flat (no :vaultId).
  app.route("/api/skills", skillsRoutes);

  // Voice defaults — folder, title pattern, language, mode. Persisted in
  // `system_config[voice_defaults]`. Consumed by voiceHandler.
  app.route("/api/voice/settings", voiceSettingsRoutes);
  // Opt-in AI title generation from a transcript (no audio upload).
  app.route("/api/voice/suggest-title", voiceTitleRoutes);

  // Global system settings — the display timezone (IANA string, default `UTC`),
  // the running build version and the update-check result. Container clock stays
  // UTC; the timezone only drives user-visible date rendering.
  //
  // Behind `requireAuth` since Story #37, including `GET /version`: the PWA reads
  // it from inside the app shell, which only mounts after AuthGate has a session,
  // and the updater sidecar polls `/health` — not this. `/api/system/update/*`
  // keeps its own `requireAdmin` on top; reading a version is not executing one.
  app.route("/api/system", systemRoutes);

  // Epic 11 / Story 11.1 — Lokyy-Workspace sidebar menu config.
  //   GET /api/workspace/menu → System + Custom merged { version, items }
  //   PUT /api/workspace/menu ← { items }  (System-Items rejected server-side;
  //                                          only custom items persisted via
  //                                          gitService → 00_meta/sidebar-menu.yaml)
  // Flat, single-vault route (no :vaultId), camelCase JSON.
  app.route("/api/workspace", workspaceRoutes);

  // Epic 11 / Story 11.11 — Dashboard (Home) data.
  //   GET /api/dashboard               → cheap tiles (DashboardSummary), synchronous
  //   GET /api/dashboard/activity?days → git-log streak/heatmap (DashboardActivity), lazy
  //   GET /api/dashboard/loose-ends    → vault-wide #todo/checkbox scan, lazy
  // Flat, single-vault, camelCase JSON. All data from existing core surfaces +
  // read-only vaultActivity/looseEnds helpers (no MCP, no new git write path).
  app.route("/api/dashboard", dashboardRoutes);

  app.route("/api", searchRoutes);
  app.route("/api/dataview", dataviewRoutes);
  app.route("/api/templates", templatesRoutes);

  // Read-only Einstellungen für die PWA (Story 4b: import defaults) plus the
  // consolidated runtime view (vault, DB host, Ollama host, MCP public URL).
  // The runtime payload describes the deployment's plumbing, so it sits behind
  // the same session gate as the rest of the data routes.
  app.route("/api/settings", settingsRoutes);

  // ── MCP (in-process) — Lese+Schreib-Endpoint /mcp für claude.ai-Connector.
  // MUSS vor den statischen Catch-all-Routen stehen, sonst verschluckt der
  // SPA-Fallback (app.get("*")) die /mcp-Requests.
  mountMcp(app);

  // ── Statische PWA (Single-Service-Demo) ────────────────────────────────
  // NACH allen /api-Routen + /health registriert, damit die API Vorrang hat.
  // Der Server liefert die mitgebaute PWA (pwa/dist, vom Dockerfile kopiert) aus
  // und fällt für unbekannte Routen auf index.html zurück (SPA-Routing).
  // cwd ist /app/server (Dockerfile WORKDIR), pwa/dist liegt unter /app/pwa/dist.
  app.use("/*", serveStatic({ root: "../pwa/dist" }));
  app.get("*", serveStatic({ path: "../pwa/dist/index.html" }));

  return app;
}
