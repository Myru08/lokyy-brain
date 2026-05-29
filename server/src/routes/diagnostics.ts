import { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import {
  EmbeddingUnavailableError,
  Tier1Provider,
  Tier2Provider,
  getHealth,
  getLlmProviders,
  getLlmRouting,
  getMemoryProvider,
  maskApiKey,
  sleepAgent,
} from "@lokyy/core";
import type { LlmRole, LlmRoutingConfig, ProviderConfig } from "@lokyy/core";
import { config } from "../config.js";
import { logBuffer } from "../lib/logBuffer.js";

/**
 * `GET /api/diagnostics` — an in-app, per-service self-test suite.
 *
 * Goal: the operator can see EXACTLY what works on a remote deployment without
 * Coolify/SSH. Every check runs defensively and reports `{ ok, detail?,
 * latencyMs?, severity? }`. A failing service yields `ok:false` + a `detail`
 * string — it NEVER throws / 500s the endpoint. Checks fan out concurrently.
 *
 * Reuses the existing service probes (Forgejo/Postgres/Ollama from admin, the
 * embeddings round-trip mirroring Tier2Provider, the MemoryProvider Tier-1/2
 * search path, the sleep-agent run store, the in-process health snapshot) and
 * adds the SPEC-mandated probes: pgvector extension, pg_search/BM25 dependency,
 * embedding round-trip (768-dim), Search Tier-1 + Tier-2 probes (the ones that
 * surface the live empty-search bug), and a cheap git/vault commit-reachable
 * probe.
 *
 * Response:
 *   { checks: [{ service, name, ok, detail?, latencyMs?, severity? }], ranAt }
 */
export const diagnosticsRoutes = new Hono();

const exec = promisify(execFile);

type Severity = "info" | "warn" | "error";

interface DiagnosticCheck {
  service: string;
  name: string;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
  severity?: Severity;
}

const OLLAMA_HOST = () => process.env.OLLAMA_HOST ?? "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
const EMBED_DIM = 768;
const DEFAULT_VAULT = process.env.LOKYY_DEFAULT_VAULT ?? "default";
const SEARCH_PROBE_QUERY = "test";

/** Truncate any detail string to keep the response compact. */
function brief(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a single check function with a hard guard: if it throws, the failure is
 * converted into an `ok:false` check rather than bubbling up. Also times it.
 */
async function guard(
  service: string,
  name: string,
  fn: () => Promise<Omit<DiagnosticCheck, "service" | "name" | "latencyMs">>,
): Promise<DiagnosticCheck> {
  const started = Date.now();
  try {
    const partial = await fn();
    return { service, name, latencyMs: Date.now() - started, ...partial };
  } catch (err) {
    return {
      service,
      name,
      ok: false,
      severity: "error",
      latencyMs: Date.now() - started,
      detail: brief(errMsg(err)),
    };
  }
}

// ── Forgejo ────────────────────────────────────────────────────────────────
// Reuses the same `git ls-remote` probe shape as admin.ts checkForgejo. When
// no remote is wired yet (pre-setup) we report info, not error.
async function checkForgejo(): Promise<DiagnosticCheck> {
  return guard("forgejo", "Remote erreichbar (git ls-remote)", async () => {
    if (!config.gitRemote) {
      return {
        ok: false,
        severity: "info",
        detail: "GIT_REMOTE nicht gesetzt — Vault-Clone wird vom Setup-Wizard provisioniert.",
      };
    }
    await exec("git", ["ls-remote", "--heads", config.gitRemote, config.gitBranch], {
      timeout: 5_000,
    });
    return { ok: true };
  });
}

// ── Postgres: connection + pgvector + pg_search/BM25 ─────────────────────────
// One short-lived connection probes all three so we don't open three pools.
async function checkPostgres(): Promise<DiagnosticCheck[]> {
  const started = Date.now();
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(config.databaseUrl, { max: 1, idle_timeout: 2 });
    await sql`SELECT 1`;
    const connLatency = Date.now() - started;

    const [vectorRows, pgSearchRows] = await Promise.all([
      sql<{ extversion: string }[]>`SELECT extversion FROM pg_extension WHERE extname='vector'`,
      sql<{ extversion: string }[]>`SELECT extversion FROM pg_extension WHERE extname='pg_search'`,
    ]);

    const pgvectorVersion = vectorRows[0]?.extversion ?? null;
    const pgSearchVersion = pgSearchRows[0]?.extversion ?? null;

    return [
      {
        service: "postgres",
        name: "Verbindung (SELECT 1)",
        ok: true,
        latencyMs: connLatency,
        severity: "info",
      },
      {
        service: "postgres",
        name: "pgvector-Extension",
        ok: pgvectorVersion !== null,
        severity: pgvectorVersion !== null ? "info" : "error",
        detail: pgvectorVersion
          ? `vector ${pgvectorVersion}`
          : "Extension 'vector' nicht installiert — semantische Suche (Tier 2) deaktiviert.",
      },
      {
        service: "postgres",
        name: "pg_search/BM25-Extension",
        ok: pgSearchVersion !== null,
        // BM25 has a LIKE-fallback in Tier1BM25, so absence degrades quality
        // rather than breaking — warn, not error.
        severity: pgSearchVersion !== null ? "info" : "warn",
        detail: pgSearchVersion
          ? `pg_search ${pgSearchVersion}`
          : "Extension 'pg_search' fehlt — BM25 fällt auf LIKE-Suche zurück (schlechteres Ranking).",
      },
    ];
  } catch (err) {
    // A failed connection means all three sub-checks are unknown — surface the
    // connection failure as the single actionable error.
    return [
      {
        service: "postgres",
        name: "Verbindung (SELECT 1)",
        ok: false,
        severity: "error",
        latencyMs: Date.now() - started,
        detail: brief(errMsg(err)),
      },
      {
        service: "postgres",
        name: "pgvector-Extension",
        ok: false,
        severity: "error",
        detail: "Nicht prüfbar — DB-Verbindung fehlgeschlagen.",
      },
      {
        service: "postgres",
        name: "pg_search/BM25-Extension",
        ok: false,
        severity: "warn",
        detail: "Nicht prüfbar — DB-Verbindung fehlgeschlagen.",
      },
    ];
  } finally {
    if (sql) await sql.end().catch(() => {});
  }
}

// ── Ollama reachability ──────────────────────────────────────────────────────
// Mirrors admin.ts checkOllama: GET /api/tags + nomic-embed-text presence.
async function checkOllama(): Promise<DiagnosticCheck[]> {
  const result = await guard("ollama", "Erreichbar (/api/tags)", async () => {
    const res = await fetch(`${OLLAMA_HOST()}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { ok: false, severity: "error", detail: `HTTP ${res.status}` };
    const data = (await res.json()) as { models?: { name: string }[] };
    const hasNomic = data.models?.some((m) => m.name.startsWith(EMBED_MODEL)) ?? false;
    return {
      ok: true,
      severity: "info",
      detail: hasNomic
        ? `${EMBED_MODEL} installiert`
        : `${EMBED_MODEL} NICHT installiert — 'ollama pull ${EMBED_MODEL}' ausführen.`,
    };
  });
  return [result];
}

// ── Embeddings round-trip ────────────────────────────────────────────────────
// Embed a short test string and assert a 768-dim vector comes back. This is the
// end-to-end embedding health check (Ollama up + model present + correct dim).
async function checkEmbeddingRoundtrip(): Promise<DiagnosticCheck> {
  return guard("embeddings", "Round-Trip (768-dim Vektor)", async () => {
    const res = await fetch(`${OLLAMA_HOST()}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: "diagnostics probe" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, severity: "error", detail: `Ollama embed HTTP ${res.status}` };
    }
    const data = (await res.json()) as { embedding?: number[] };
    const dim = Array.isArray(data.embedding) ? data.embedding.length : 0;
    if (dim !== EMBED_DIM) {
      return {
        ok: false,
        severity: "error",
        detail: `Unerwartete Vektor-Dimension: ${dim} (erwartet ${EMBED_DIM}).`,
      };
    }
    return { ok: true, severity: "info", detail: `${dim}-dim Vektor erhalten` };
  });
}

// ── Search Tier 1 probe ───────────────────────────────────────────────────────
// Runs a fixed query through the structural (Tier-1) path. This is the probe
// that exposes the live empty-search bug: it reports the actual hit count + any
// error. Zero hits is reported as a WARN (suspicious, not necessarily broken).
async function checkSearchTier1(): Promise<DiagnosticCheck> {
  return guard("search", "Tier 1 Probe (strukturell)", async () => {
    const t1 = new Tier1Provider();
    const hits = await t1.search(SEARCH_PROBE_QUERY, { limit: 5 });
    const count = hits.length;
    return {
      ok: count > 0,
      severity: count > 0 ? "info" : "warn",
      detail:
        count > 0
          ? `${count} Treffer für Probe-Query "${SEARCH_PROBE_QUERY}"`
          : `0 Treffer für Probe-Query "${SEARCH_PROBE_QUERY}" — leerer Index oder Such-Bug.`,
    };
  });
}

// ── Search Tier 2 probe (semantic) ────────────────────────────────────────────
// Same probe through the semantic path. Reports hit count + the `no_embedding`
// degraded flag (Ollama down → no query vector → no semantic hits).
async function checkSearchTier2(): Promise<DiagnosticCheck> {
  return guard("search", "Tier 2 Probe (semantisch)", async () => {
    const t2 = new Tier2Provider({ vaultId: DEFAULT_VAULT });
    try {
      const hits = await t2.search(SEARCH_PROBE_QUERY, { limit: 5 });
      const count = hits.length;
      return {
        ok: count > 0,
        severity: count > 0 ? "info" : "warn",
        detail:
          count > 0
            ? `${count} semantische Treffer für "${SEARCH_PROBE_QUERY}"`
            : `0 semantische Treffer — leerer Embedding-Index oder Such-Bug.`,
      };
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) {
        return {
          ok: false,
          severity: "warn",
          detail: "degraded=no_embedding — Ollama/Embedding-Modell nicht verfügbar; Tier 2 deaktiviert.",
        };
      }
      throw err;
    }
  });
}

// ── Combined search (MemoryProvider) probe ────────────────────────────────────
// The actual path /api/search uses: Tier1 first, Tier2 merged in. Reports the
// merged hit count so the operator sees what the app's search box returns.
async function checkSearchCombined(): Promise<DiagnosticCheck> {
  return guard("search", "Combined Probe (Tier 1 + 2)", async () => {
    const hits = await getMemoryProvider(DEFAULT_VAULT).search(SEARCH_PROBE_QUERY, {
      limit: 5,
    });
    const count = hits.length;
    return {
      ok: count > 0,
      severity: count > 0 ? "info" : "warn",
      detail:
        count > 0
          ? `${count} kombinierte Treffer für "${SEARCH_PROBE_QUERY}"`
          : `0 kombinierte Treffer — die App-Suche liefert aktuell nichts.`,
    };
  });
}

// ── Sleep-agent scheduler + last run ──────────────────────────────────────────
async function checkSleepAgent(): Promise<DiagnosticCheck[]> {
  const armed = await guard("sleep-agent", "Scheduler armiert", async () => {
    const running = sleepAgent().isRunning();
    return {
      ok: true,
      severity: "info",
      detail: running ? "Lauf aktuell in-flight" : "bereit (idle)",
    };
  });

  const lastRun = await guard("sleep-agent", "Letzter Lauf", async () => {
    const runs = await sleepAgent().listRecent(1);
    const last = runs[0];
    if (!last) {
      return {
        ok: false,
        severity: "info",
        detail: "Noch kein Lauf protokolliert.",
      };
    }
    const finished = last.finishedAt ? last.finishedAt.toISOString() : "läuft noch";
    return {
      ok: last.status === "completed",
      severity:
        last.status === "completed"
          ? "info"
          : last.status === "failed"
            ? "error"
            : "warn",
      detail: `${last.phase}/${last.trigger} → ${last.status} (${finished}), ${last.notesProcessed} Notizen${
        last.errorMessage ? ` — ${brief(last.errorMessage, 120)}` : ""
      }`,
    };
  });

  return [armed, lastRun];
}

// ── MCP / backend health snapshot ─────────────────────────────────────────────
// `getHealth()` is the same in-process snapshot the MCP get_health tool serves.
// Cheap + synchronous (AC#6 in core forbids heavy queries here).
async function checkMcpHealth(): Promise<DiagnosticCheck> {
  return guard("mcp", "Backend-Health-Snapshot", async () => {
    const h = getHealth({ vaultId: DEFAULT_VAULT });
    const quarantined = h.quarantined.length;
    return {
      ok: quarantined === 0,
      severity: quarantined === 0 ? "info" : "warn",
      detail: `sync=${h.sync_state}, pool_max=${h.db_pool_max}, quarantäniert=${quarantined}, breaker=${h.breaker_entries}`,
    };
  });
}

// ── Git / vault: lock healthy + last commit reachable ─────────────────────────
// Cheap, NO write: `git -C <vaultDir> rev-parse HEAD`. If the working copy is
// present and HEAD resolves, the lock isn't wedging reads and the last commit
// is reachable. Pre-setup (no vault dir / no commit) reports info.
async function checkGitVault(): Promise<DiagnosticCheck> {
  return guard("git", "Working-Copy HEAD erreichbar", async () => {
    try {
      const { stdout } = await exec("git", ["-C", config.vaultDir, "rev-parse", "HEAD"], {
        timeout: 5_000,
      });
      return {
        ok: true,
        severity: "info",
        detail: `HEAD ${stdout.trim().slice(0, 12)} (Vault: ${config.vaultDir})`,
      };
    } catch (err) {
      const msg = errMsg(err);
      // No commits yet / not a repo → pre-setup, info not error.
      if (/not a git repository|unknown revision|ambiguous argument|does not have any commits/i.test(msg)) {
        return {
          ok: false,
          severity: "info",
          detail: "Kein Vault-Working-Copy / kein Commit — Setup-Wizard noch nicht durchlaufen.",
        };
      }
      return { ok: false, severity: "error", detail: brief(msg) };
    }
  });
}

// ── KI / Task-Routing: provider credentials + role assignments ────────────────
// Surfaces the ROOT cause of empty semantic search: an unassigned Embedding role
// in Task-Routing. The existing search probes report "0 hits" — these checks say
// WHY. Provider-agnostic: reads the persisted LLM config (configStore) without
// caring which cloud/local provider is wired.
//
// Service string "ki-routing" flows through the same DiagnosticCheck shape, so
// the Diagnose UI renders this group generically — no UI change required.

// Cloud providers we surface as credential checks. Ollama is intentionally
// excluded from the "needs an API key" set — it's local and keyless.
const CLOUD_PROVIDER_NAMES = ["anthropic", "openai", "google", "cohere", "voyage"] as const;

// Human-facing role labels (German UI). Embedding is the load-bearing one.
const ROLE_LABELS: Record<LlmRole, string> = {
  embedding: "Embedding",
  rerank: "Re-Rank",
  "topic-synthesis": "Topic-Synthesis",
  "query-rewrite": "Query-Rewrite",
  hyde: "HyDE",
  "self-rag": "Self-RAG",
  lint: "Lint",
  ner: "NER",
  "mem0-classifier": "mem0-Classifier",
  "intent-classifier": "Intent-Classifier",
};

// All non-embedding roles, reported as info so the operator sees full routing
// state. Order = display order.
const SECONDARY_ROLES: LlmRole[] = [
  "rerank",
  "topic-synthesis",
  "query-rewrite",
  "hyde",
  "self-rag",
  "ner",
  "mem0-classifier",
  "intent-classifier",
  "lint",
];

/** True if a provider config carries usable credentials/connection info. */
function providerHasCreds(p: ProviderConfig | undefined): boolean {
  if (!p) return false;
  const name = (p.name ?? "").toLowerCase();
  // Local providers (Ollama / any explicitly local baseUrl) need no API key —
  // a configured + enabled entry counts as "ready".
  if (name === "ollama") return true;
  return typeof p.apiKey === "string" && p.apiKey.trim().length > 0;
}

/** Look up a provider config by (case-insensitive) name. */
function findProvider(providers: ProviderConfig[], name: string): ProviderConfig | undefined {
  const lower = name.toLowerCase();
  return providers.find((p) => (p.name ?? "").toLowerCase() === lower);
}

/**
 * Provider-credentials sub-checks. Ollama-local present → ok. Empty cloud →
 * info (local-only is a valid deployment, not an error).
 */
function checkProviderCredentials(providers: ProviderConfig[]): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];

  // Ollama (local, keyless) — present+enabled = ok, otherwise info (cloud-only
  // setups don't need it, but Tier-2 embeddings via Ollama do).
  const ollama = findProvider(providers, "ollama");
  checks.push({
    service: "ki-routing",
    name: "Provider-Credentials: Ollama (lokal)",
    ok: !!ollama,
    severity: ollama ? "info" : "info",
    detail: ollama
      ? `konfiguriert (${ollama.enabled ? "aktiv" : "deaktiviert"})${
          ollama.baseUrl ? ` @ ${ollama.baseUrl}` : ""
        }`
      : "nicht konfiguriert — für lokale Embeddings (Tier 2) Ollama-Provider anlegen.",
  });

  // Cloud providers — empty = info (local-only is valid), present = ok with a
  // masked key so the operator can confirm WHICH key is wired without leaking it.
  for (const name of CLOUD_PROVIDER_NAMES) {
    const p = findProvider(providers, name);
    const hasCreds = providerHasCreds(p);
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    checks.push({
      service: "ki-routing",
      name: `Provider-Credentials: ${label}`,
      ok: hasCreds,
      // No creds is informational — running local-only is a legitimate choice.
      severity: "info",
      detail: hasCreds
        ? `Credentials gesetzt${p?.apiKey ? ` (${maskApiKey(p.apiKey)})` : ""}${
            p && !p.enabled ? " — Provider deaktiviert" : ""
          }`
        : "keine Credentials — Cloud-Provider ungenutzt (local-only ist gültig).",
    });
  }

  return checks;
}

/**
 * Role-assignment sub-checks. Embedding unassigned → error (it's the documented
 * root cause of empty Tier-2 / semantic search). Everything else → info.
 */
function checkRoleAssignments(
  routing: LlmRoutingConfig,
  providers: ProviderConfig[],
): DiagnosticCheck[] {
  const roles = routing.roles ?? {};
  const checks: DiagnosticCheck[] = [];

  // ── Embedding — the load-bearing role. ──
  const embedding = roles.embedding;
  if (!embedding || !embedding.provider) {
    checks.push({
      service: "ki-routing",
      name: "Rolle: Embedding",
      ok: false,
      severity: "error",
      detail:
        "Embedding-Rolle nicht zugewiesen → Tier 2 / semantische Suche bleibt leer. " +
        "AI → Task-Routing → Embedding zuweisen, dann Migrate Embeddings.",
    });
  } else {
    const provider = findProvider(providers, embedding.provider);
    const model = embedding.model ?? provider?.defaultModel;
    // Assigned-but-provider-missing is suspicious → warn; otherwise ok.
    const providerKnown = !!provider;
    checks.push({
      service: "ki-routing",
      name: "Rolle: Embedding",
      ok: providerKnown,
      severity: providerKnown ? "info" : "warn",
      detail: providerKnown
        ? `zugewiesen → ${embedding.provider}${model ? ` / ${model}` : ""}`
        : `zugewiesen an unbekannten Provider "${embedding.provider}"${
            model ? ` / ${model}` : ""
          } — Provider in der Provider-Liste fehlt.`,
    });
  }

  // ── All other roles — informational routing state. ──
  for (const role of SECONDARY_ROLES) {
    const assignment = roles[role];
    const assigned = !!(assignment && assignment.provider);
    const model = assignment?.model;
    checks.push({
      service: "ki-routing",
      name: `Rolle: ${ROLE_LABELS[role]}`,
      ok: true,
      severity: "info",
      detail: assigned
        ? `zugewiesen → ${assignment.provider}${model ? ` / ${model}` : ""}`
        : "nicht zugewiesen",
    });
  }

  return checks;
}

/**
 * KI / Task-Routing check group. Reads the persisted LLM config defensively —
 * any failure (DB down, malformed JSON, core import error) degrades to a single
 * info/error check instead of throwing.
 */
async function checkKiRouting(): Promise<DiagnosticCheck[]> {
  const started = Date.now();
  try {
    const [providers, routing] = await Promise.all([
      getLlmProviders(),
      getLlmRouting(),
    ]);
    const checks = [
      ...checkProviderCredentials(providers),
      ...checkRoleAssignments(routing, providers),
    ];
    // Stamp a shared latency on the first check so the UI shows the read cost.
    if (checks[0]) checks[0].latencyMs = Date.now() - started;
    return checks;
  } catch (err) {
    return [
      {
        service: "ki-routing",
        name: "LLM-Konfiguration lesbar",
        ok: false,
        severity: "error",
        latencyMs: Date.now() - started,
        detail: brief(`LLM-Config nicht lesbar (${errMsg(err)}) — Provider/Routing nicht prüfbar.`),
      },
    ];
  }
}

diagnosticsRoutes.get("/", async (c) => {
  // Each group is independently guarded; Promise.all over already-guarded
  // promises can never reject. We still wrap the whole assembly so a truly
  // unexpected failure (e.g. core import-time error) degrades to a single
  // error check instead of a 500.
  let checks: DiagnosticCheck[];
  try {
    const groups = await Promise.all([
      checkForgejo().then((x) => [x]),
      checkPostgres(),
      checkOllama(),
      checkEmbeddingRoundtrip().then((x) => [x]),
      checkSearchTier1().then((x) => [x]),
      checkSearchTier2().then((x) => [x]),
      checkSearchCombined().then((x) => [x]),
      checkSleepAgent(),
      checkMcpHealth().then((x) => [x]),
      checkGitVault().then((x) => [x]),
      checkKiRouting(),
    ]);
    checks = groups.flat();
  } catch (err) {
    // Should be unreachable — every check is internally guarded. Log it so the
    // ring buffer captures the anomaly, and still return 200 with a marker.
    logBuffer.error(`diagnostics suite assembly failed: ${errMsg(err)}`, "diagnostics");
    checks = [
      {
        service: "diagnostics",
        name: "Suite-Ausführung",
        ok: false,
        severity: "error",
        detail: brief(errMsg(err)),
      },
    ];
  }

  // Surface any failing checks into the log ring buffer too, so the Logs view
  // reflects the most recent diagnostics run without a separate write path.
  const failed = checks.filter((c) => !c.ok && c.severity === "error");
  if (failed.length > 0) {
    logBuffer.warn(
      `diagnostics: ${failed.length} Fehler — ${failed.map((f) => `${f.service}/${f.name}`).join(", ")}`,
      "diagnostics",
    );
  }

  return c.json({ checks, ranAt: new Date().toISOString() });
});
