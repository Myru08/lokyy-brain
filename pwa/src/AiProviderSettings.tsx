import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, X, Loader2, ChevronDown, ChevronRight, Download } from "lucide-react";
import { C, FONT } from "./theme.js";
import {
  api,
  type LlmRole,
  type MigrationProgress,
  type OllamaModelStatus,
  type OllamaPullProgress,
  type PrivacyTier,
  type ProviderConfig,
  type LlmRoutingConfig,
  type UsageStats,
  type TestConnectionResult,
  type OpenAICompatPreset,
} from "./api.js";

/**
 * AI-Provider Settings (Phase-0 Wave C-Frontend).
 *
 * Self-contained Section, mounted inside `Settings.tsx` next to the
 * existing "Integrations" block. Layout (top → bottom):
 *
 *   1. Profile-Buttons        → one-shot routing presets
 *   2. Provider Credentials   → API keys + Test buttons (cloud + Ollama)
 *   3. OpenAI-Compat          → collapsible block, 8 presets
 *   4. Task-Routing           → 10 LlmRole → {provider, model} dropdowns
 *   5. Privacy                → tier radio + folder chips
 *   6. Budget                 → per-provider usage / cap progress bars
 *   7. Save                   → PUT /api/llm/config
 *
 * The UI graceful-degrades when the backend endpoints are not yet wired
 * (404 / 500) — load() catches and sets an inline error banner.
 */

// ───────────────────────── Static metadata ─────────────────────────

const CORE_PROVIDERS: {
  name: string;
  label: string;
  /** key field rendered: api-key or base-url */
  field: "apiKey" | "baseUrl";
  placeholder: string;
  /** whether local (Ollama) so we don't mask the URL */
  isLocal: boolean;
}[] = [
  { name: "anthropic", label: "Anthropic", field: "apiKey", placeholder: "sk-ant-…", isLocal: false },
  { name: "openai", label: "OpenAI", field: "apiKey", placeholder: "sk-…", isLocal: false },
  { name: "google", label: "Google", field: "apiKey", placeholder: "AIza…", isLocal: false },
  { name: "cohere", label: "Cohere", field: "apiKey", placeholder: "…", isLocal: false },
  { name: "voyage", label: "Voyage", field: "apiKey", placeholder: "pa-…", isLocal: false },
  { name: "ollama", label: "Ollama (local)", field: "baseUrl", placeholder: "http://localhost:11434", isLocal: true },
];

const ROLES: { role: LlmRole; label: string; hint?: string }[] = [
  { role: "embedding", label: "Embedding", hint: "Vector index (Tier 2)" },
  { role: "rerank", label: "Re-Rank", hint: "Cross-encoder for search results" },
  { role: "topic-synthesis", label: "Topic-Synthesis", hint: "Consolidation Agent" },
  { role: "query-rewrite", label: "Query-Rewrite" },
  { role: "hyde", label: "HyDE" },
  { role: "self-rag", label: "Self-RAG" },
  { role: "lint", label: "Lint" },
  { role: "ner", label: "NER" },
  { role: "mem0-classifier", label: "mem0-Classifier" },
  { role: "intent-classifier", label: "Intent-Classifier" },
];

/** Known model lists per provider — used as Dropdown options. */
const KNOWN_MODELS: Record<string, string[]> = {
  anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-7"],
  openai: [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-5",
    "text-embedding-3-small",
    "text-embedding-3-large",
  ],
  google: ["gemini-2.0-flash", "gemini-2.0-pro", "text-embedding-004"],
  cohere: ["command-r-08-2024", "rerank-3", "embed-english-v3.0"],
  voyage: ["voyage-3", "voyage-3-large", "rerank-2"],
  ollama: ["nomic-embed-text", "llama3.1:8b", "qwen2.5:7b", "mistral:7b"],
};

const LOCAL_BGE_RERANK = "bge-reranker-v2-m3";

// ─────────────── Ollama local-model helpers (issue #46) ───────────────
// Mirror packages/core/src/llm/ollamaModels.ts. Duplicated (not imported)
// because @lokyy/core carries node-only deps and is banned from the PWA bundle —
// same reason the LLM types are inlined at the top of api.ts. Keep in sync.

const OLLAMA_DEFAULT_CHAT_MODEL = "llama3.1:8b";
const OLLAMA_DEFAULT_EMBED_MODEL = "nomic-embed-text";

/** Approx download sizes for the models we offer to install. */
const OLLAMA_MODEL_SIZES: Record<string, string> = {
  "llama3.1:8b": "~4.9 GB",
  "nomic-embed-text": "~274 MB",
  "qwen2.5:7b": "~4.7 GB",
  "mistral:7b": "~4.1 GB",
  "llama3.2:3b": "~2.0 GB",
};

interface ConfiguredOllamaModel {
  model: string;
  roles: LlmRole[];
  kind: "chat" | "embedding";
}

/** Distinct Ollama models the current (in-memory) routing points at. */
function configuredOllamaModels(routing: LlmRoutingConfig): ConfiguredOllamaModel[] {
  const byModel = new Map<string, { roles: LlmRole[]; hasEmbedding: boolean }>();
  for (const [role, assignment] of Object.entries(routing.roles ?? {}) as [
    LlmRole,
    { provider: string; model?: string } | undefined,
  ][]) {
    if (!assignment || assignment.provider !== "ollama") continue;
    const isEmbedding = role === "embedding";
    const model =
      (assignment.model ?? "").trim() ||
      (isEmbedding ? OLLAMA_DEFAULT_EMBED_MODEL : OLLAMA_DEFAULT_CHAT_MODEL);
    const entry = byModel.get(model) ?? { roles: [], hasEmbedding: false };
    entry.roles.push(role);
    if (isEmbedding) entry.hasEmbedding = true;
    byModel.set(model, entry);
  }
  return Array.from(byModel.entries()).map(([model, { roles, hasEmbedding }]) => ({
    model,
    roles,
    kind: hasEmbedding ? "embedding" : "chat",
  }));
}

/** Does `wanted` appear in the installed list (tag-aware)? */
function isModelInstalled(installed: string[], wanted: string): boolean {
  const w = wanted.trim();
  if (!w) return false;
  return installed.some((name) => {
    if (name === w) return true;
    if (!w.includes(":") && name.startsWith(`${w}:`)) return true;
    if (w.endsWith(":latest") && name === w.slice(0, -":latest".length)) return true;
    if (name.endsWith(":latest") && name.slice(0, -":latest".length) === w) return true;
    return false;
  });
}

function ollamaModelSize(model: string): string | undefined {
  return OLLAMA_MODEL_SIZES[model] ?? OLLAMA_MODEL_SIZES[model.split(":")[0]];
}

/** Per-model pull UI state. */
interface PullEntry {
  running: boolean;
  progress?: OllamaPullProgress;
  done?: boolean;
  error?: string;
}

function pullPercent(p: OllamaPullProgress | undefined): number | null {
  if (!p || typeof p.total !== "number" || p.total <= 0) return null;
  const completed = typeof p.completed === "number" ? p.completed : 0;
  return Math.min(100, Math.round((completed / p.total) * 100));
}

// ───────────────────────── Profile presets ─────────────────────────

type RoutingMap = LlmRoutingConfig["roles"];

function profilePrivacyMax(): RoutingMap {
  const ollama = (model: string) => ({ provider: "ollama", model });
  return {
    embedding: ollama("nomic-embed-text"),
    rerank: { provider: "local-bge", model: LOCAL_BGE_RERANK },
    "topic-synthesis": ollama("llama3.1:8b"),
    "query-rewrite": ollama("llama3.1:8b"),
    hyde: ollama("llama3.1:8b"),
    "self-rag": ollama("llama3.1:8b"),
    lint: ollama("llama3.1:8b"),
    ner: ollama("llama3.1:8b"),
    "mem0-classifier": ollama("llama3.1:8b"),
    "intent-classifier": ollama("llama3.1:8b"),
  };
}

function profileBalanced(): RoutingMap {
  const ollama = (model: string) => ({ provider: "ollama", model });
  const anthropic = (model: string) => ({ provider: "anthropic", model });
  return {
    embedding: ollama("nomic-embed-text"),
    rerank: { provider: "local-bge", model: LOCAL_BGE_RERANK },
    "topic-synthesis": anthropic("claude-haiku-4-5"),
    "query-rewrite": ollama("llama3.1:8b"),
    hyde: ollama("llama3.1:8b"),
    "self-rag": ollama("llama3.1:8b"),
    lint: ollama("llama3.1:8b"),
    ner: ollama("llama3.1:8b"),
    "mem0-classifier": anthropic("claude-haiku-4-5"),
    "intent-classifier": ollama("llama3.1:8b"),
  };
}

function profileQualityMax(): RoutingMap {
  const sonnet = { provider: "anthropic", model: "claude-sonnet-4-6" };
  return {
    embedding: { provider: "voyage", model: "voyage-3" },
    rerank: { provider: "cohere", model: "rerank-3" },
    "topic-synthesis": sonnet,
    "query-rewrite": sonnet,
    hyde: sonnet,
    "self-rag": sonnet,
    lint: sonnet,
    ner: sonnet,
    "mem0-classifier": sonnet,
    "intent-classifier": sonnet,
  };
}

const PROFILES: { id: "privacy" | "balanced" | "quality"; label: string; build: () => RoutingMap; desc: string }[] = [
  { id: "privacy", label: "Privacy-Max", build: profilePrivacyMax, desc: "Alle 10 Rollen lokal (Ollama + bge-rerank). Keine Cloud-Calls." },
  { id: "balanced", label: "Balanced", build: profileBalanced, desc: "Lokal wo möglich, Claude Haiku für Synthesis/Mem0." },
  { id: "quality", label: "Quality-Max", build: profileQualityMax, desc: "Claude Sonnet überall, Voyage embed, Cohere rerank." },
];

// ───────────────────────── Helpers ─────────────────────────

function findOrCreateProvider(
  providers: ProviderConfig[],
  name: string,
  preset?: string,
): ProviderConfig {
  const match = providers.find(
    (p) => p.name === name && (preset === undefined || p.preset === preset),
  );
  if (match) return match;
  return { name, preset, enabled: false };
}

function upsertProvider(
  providers: ProviderConfig[],
  next: ProviderConfig,
): ProviderConfig[] {
  const idx = providers.findIndex(
    (p) => p.name === next.name && p.preset === next.preset,
  );
  if (idx === -1) return [...providers, next];
  const copy = providers.slice();
  copy[idx] = next;
  return copy;
}

function isMaskedKey(value: string | undefined): boolean {
  if (!value) return false;
  return value.includes("•") || value.startsWith("***");
}

function progressColor(pct: number): string {
  if (pct >= 90) return C.err;
  if (pct >= 70) return C.gold;
  return C.ok;
}

// ───────────────────────── Component ─────────────────────────

/**
 * Props:
 *   runtimeOllamaHost — actual `OLLAMA_HOST` value from the backend env.
 *     Used to display the real host (e.g. `http://ollama-<uuid>:11434`)
 *     instead of the static `http://localhost:11434` placeholder. May be
 *     undefined when the backend isn't reachable; in that case we fall
 *     back to the static placeholder.
 */
export function AiProviderSettings({
  runtimeOllamaHost,
}: { runtimeOllamaHost?: string } = {}) {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [routing, setRouting] = useState<LlmRoutingConfig>({
    roles: {},
    privacyTier: "local_for_personal_folders",
    privacyTierFolders: ["40_customers/", "70_pai/"],
  });
  const [usage, setUsage] = useState<UsageStats[]>([]);
  const [presets, setPresets] = useState<OpenAICompatPreset[]>([]);

  const [loadError, setLoadError] = useState<string>();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "ok" | "fail">("idle");
  const [saveError, setSaveError] = useState<string>();
  const [showOpenAICompat, setShowOpenAICompat] = useState(false);

  /** Tracks which fields the user actively typed in — only those get sent. */
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  /** Test results, keyed by provider-config-name (or "name|preset"). */
  const [testResults, setTestResults] = useState<
    Record<string, { state: "idle" | "running"; result?: TestConnectionResult }>
  >({});

  const [confirmProfile, setConfirmProfile] = useState<typeof PROFILES[number] | null>(null);
  const [folderInput, setFolderInput] = useState("");

  /** Embedding-migration UI state (Phase-0 Wave D / Agent 1). */
  const [migConfirm, setMigConfirm] = useState<{
    toProvider: string;
    toModel?: string;
  } | null>(null);
  const [migration, setMigration] = useState<MigrationProgress | null>(null);
  const [migError, setMigError] = useState<string | undefined>();
  const [migAbort, setMigAbort] = useState<(() => void) | null>(null);

  /** Ollama local-model presence + pull state (issue #46). */
  const [modelStatus, setModelStatus] = useState<OllamaModelStatus | null>(null);
  const [pullState, setPullState] = useState<Record<string, PullEntry>>({});
  /** Live abort handles for in-flight pulls — cleaned up on unmount. */
  const pullAborts = useRef<Record<string, () => void>>({});

  // ── Initial load ──
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [cfg, p] = await Promise.all([
          api.getLlmConfig(),
          api.getOpenAICompatPresets().catch(() => [] as OpenAICompatPreset[]),
        ]);
        if (cancelled) return;
        setProviders(cfg.providers);
        setRouting(cfg.routing);
        setUsage(cfg.usage);
        setPresets(p);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error
            ? err.message
            : "LLM-Konfiguration konnte nicht geladen werden",
        );
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Ollama model presence: load the live installed-list on mount ──
  // `installed` + `ollamaReachable` are authoritative (a real /api/tags hit);
  // the per-model presence we render is computed against the CURRENT in-memory
  // routing so an unsaved profile switch reflects immediately.
  const reloadModelStatus = useCallback(async () => {
    try {
      setModelStatus(await api.getOllamaModelStatus());
    } catch {
      setModelStatus(null);
    }
  }, []);

  useEffect(() => {
    void reloadModelStatus();
  }, [reloadModelStatus]);

  // Abort any in-flight pulls when the panel unmounts.
  useEffect(() => {
    const aborts = pullAborts.current;
    return () => {
      for (const abort of Object.values(aborts)) abort();
    };
  }, []);

  function installModel(model: string) {
    if (pullAborts.current[model]) return; // already pulling
    setPullState((s) => ({ ...s, [model]: { running: true } }));
    const abort = api.streamOllamaPull(
      model,
      (progress) =>
        setPullState((s) => ({
          ...s,
          [model]: { ...s[model], running: true, progress },
        })),
      (result) => {
        delete pullAborts.current[model];
        setPullState((s) => ({
          ...s,
          [model]: {
            running: false,
            progress: s[model]?.progress,
            done: result.ok,
            error: result.ok ? undefined : (result.error ?? "Pull fehlgeschlagen"),
          },
        }));
        if (result.ok) void reloadModelStatus();
      },
    );
    pullAborts.current[model] = abort;
  }

  // ── Derived: which providers are usable (enabled & key set) ──
  const enabledProviderNames = useMemo(() => {
    const out: { name: string; preset?: string; label: string; isLocal: boolean }[] = [];
    for (const p of providers) {
      if (!p.enabled) continue;
      // Cloud providers need either a stored key (masked or fresh).
      const core = CORE_PROVIDERS.find((c) => c.name === p.name);
      if (core) {
        if (core.isLocal) {
          out.push({ name: p.name, label: core.label, isLocal: true });
        } else if (p.apiKey) {
          out.push({ name: p.name, label: core.label, isLocal: false });
        }
        continue;
      }
      // OpenAI-Compat
      if (p.name === "openai-compat" && p.preset) {
        const meta = presets.find((x) => x.name === p.preset);
        const localPreset = meta?.isLocal ?? false;
        if (localPreset || p.apiKey) {
          out.push({
            name: p.name,
            preset: p.preset,
            label: `OAI-compat: ${meta?.label ?? p.preset}`,
            isLocal: localPreset,
          });
        }
      }
    }
    // Always allow "local-bge" as a synthetic local rerank choice.
    if (!out.some((o) => o.name === "local-bge")) {
      out.push({ name: "local-bge", label: "local bge-reranker (bundled)", isLocal: true });
    }
    return out;
  }, [providers, presets]);

  // ── Field handlers ──

  function updateProviderField(
    name: string,
    preset: string | undefined,
    patch: Partial<ProviderConfig>,
  ) {
    setProviders((prev) => {
      const existing = findOrCreateProvider(prev, name, preset);
      const next: ProviderConfig = { ...existing, ...patch };
      // Auto-enable when a key or baseUrl is being set.
      if (patch.apiKey !== undefined || patch.baseUrl !== undefined) {
        next.enabled = true;
      }
      return upsertProvider(prev, next);
    });
  }

  function markDirty(key: string) {
    setDirtyKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  function clearProviderKey(name: string, preset?: string) {
    updateProviderField(name, preset, { apiKey: "", enabled: false });
    markDirty(`${name}|${preset ?? ""}`);
  }

  async function runTest(name: string, preset?: string) {
    const key = `${name}|${preset ?? ""}`;
    setTestResults((prev) => ({ ...prev, [key]: { state: "running" } }));
    try {
      const result = await api.testLlmConnection(preset ? `${name}:${preset}` : name);
      // For Ollama, reachability alone isn't enough (issue #46): verify the
      // CONFIGURED models are actually present, not just that /api/tags answered.
      let finalResult = result;
      if (name === "ollama" && result.ok) {
        const configured = configuredOllamaModels(routing);
        const available = result.modelsAvailable ?? [];
        const missing = configured
          .map((m) => m.model)
          .filter((m) => !isModelInstalled(available, m));
        if (configured.length > 0 && missing.length > 0) {
          finalResult = {
            ok: false,
            latencyMs: result.latencyMs,
            error: `Modell fehlt: ${missing.join(", ")}`,
          };
        }
      }
      setTestResults((prev) => ({ ...prev, [key]: { state: "idle", result: finalResult } }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [key]: {
          state: "idle",
          result: {
            ok: false,
            error: err instanceof Error ? err.message : "test failed",
          },
        },
      }));
    }
  }

  function applyProfile(profile: typeof PROFILES[number]) {
    setRouting((prev) => ({ ...prev, roles: profile.build() }));
    setConfirmProfile(null);
  }

  // ── Embedding migration handlers ──
  async function startMigrationRun(toProvider: string, toModel?: string) {
    setMigError(undefined);
    try {
      const { migrationId } = await api.startEmbeddingMigration(toProvider, toModel);
      // initial poll for the freshly-created row, then attach SSE
      const initial = await api.getMigrationStatus(migrationId);
      setMigration(initial);
      const abort = api.streamMigration(
        migrationId,
        (p) => setMigration(p),
        () => setMigAbort(null),
      );
      setMigAbort(() => abort);
    } catch (err) {
      setMigError(err instanceof Error ? err.message : "Migration konnte nicht gestartet werden");
    }
    setMigConfirm(null);
  }

  async function cancelMigrationRun() {
    if (!migration) return;
    try {
      await api.cancelMigration(migration.migrationId);
    } catch (err) {
      setMigError(err instanceof Error ? err.message : "Cancel fehlgeschlagen");
    }
  }

  function migrationButtonLabel(): string {
    const assignment = routing.roles.embedding;
    if (!assignment) return "Migrate Embeddings…";
    const model = assignment.model ?? "(default model)";
    return `Migrate Embeddings → ${assignment.provider} / ${model}`;
  }

  function migrationButtonDisabled(): boolean {
    if (migration && (migration.status === "pending" || migration.status === "running")) {
      return true;
    }
    return !routing.roles.embedding;
  }

  // ── Save ──
  async function save() {
    setSaveState("saving");
    setSaveError(undefined);
    try {
      // Strip masked keys that the user did NOT touch — server would
      // otherwise interpret the mask as the real key.
      const sanitized = providers.map((p) => {
        const key = `${p.name}|${p.preset ?? ""}`;
        const wasTouched = dirtyKeys.has(key);
        if (!wasTouched && isMaskedKey(p.apiKey)) {
          const { apiKey: _drop, ...rest } = p;
          return rest;
        }
        return p;
      });
      const updated = await api.setLlmConfig({ providers: sanitized, routing });
      // Defensive: the save already succeeded server-side. Never let a
      // malformed/partial response throw during the post-save state update —
      // that would unmount the tree (black screen). Only adopt fields that
      // are actually present and well-shaped; fall back to current state.
      if (Array.isArray(updated?.providers)) {
        setProviders(updated.providers);
      }
      if (updated?.routing && typeof updated.routing === "object") {
        setRouting(updated.routing);
      }
      if (Array.isArray(updated?.usage)) {
        setUsage(updated.usage);
      }
      setDirtyKeys(new Set());
      setSaveState("ok");
    } catch (err) {
      setSaveState("fail");
      setSaveError(err instanceof Error ? err.message : "Speichern fehlgeschlagen");
    }
  }

  // ───────────────────────── Render ─────────────────────────

  return (
    <section
      style={{
        marginBottom: 32,
        padding: 20,
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
      }}
    >
      <h2 style={{ fontFamily: FONT.serif, fontSize: 18, margin: "0 0 6px 0" }}>
        AI Provider
      </h2>
      <p style={{ color: C.textDim, fontSize: 12, margin: "0 0 18px 0" }}>
        Anthropic, OpenAI, Google, Cohere, Voyage, Ollama und 8 OpenAI-Compat-Endpoints.
        Wähle ein Profil oder route jede Rolle einzeln.
      </p>

      {loadError && (
        <div
          style={{
            padding: 10,
            background: C.elevated,
            border: `1px solid ${C.err}`,
            borderRadius: 6,
            color: C.err,
            fontSize: 12,
            marginBottom: 16,
          }}
        >
          <strong>Backend nicht erreichbar:</strong> {loadError}
          <br />
          UI bleibt bedienbar — Save wird beim ersten Erfolg erneut versucht.
        </div>
      )}

      {/* ───── Profile-Buttons ───── */}
      <div style={subhead}>Profil</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        {PROFILES.map((p) => (
          <button
            key={p.id}
            onClick={() => setConfirmProfile(p)}
            style={profileBtn}
            title={p.desc}
          >
            {p.label}
          </button>
        ))}
      </div>

      {confirmProfile && (
        <div
          style={{
            padding: 12,
            background: C.elevated,
            border: `1px solid ${C.accent}`,
            borderRadius: 6,
            marginBottom: 18,
          }}
        >
          <div style={{ fontSize: 13, color: C.text, marginBottom: 6 }}>
            <strong style={{ color: C.accent }}>{confirmProfile.label}</strong>{" "}
            anwenden? Das überschreibt das aktuelle Routing aller 10 Rollen.
          </div>
          <div style={{ fontSize: 11, color: C.textDim, marginBottom: 10 }}>
            {confirmProfile.desc}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => applyProfile(confirmProfile)} style={btnPrimary}>
              Anwenden
            </button>
            <button onClick={() => setConfirmProfile(null)} style={btn}>
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* ───── Provider Credentials ───── */}
      <div style={subhead}>Provider Credentials</div>

      {CORE_PROVIDERS.map((meta) => {
        const cfg = findOrCreateProvider(providers, meta.name);
        const key = `${meta.name}|`;
        const isDirty = dirtyKeys.has(key);
        const testKey = key;
        const test = testResults[testKey];
        // For the Ollama row we want the real backend host (from runtime),
        // not the static `http://localhost:11434` placeholder. Falls back to
        // the static placeholder when runtime info is unavailable.
        const effectivePlaceholder =
          meta.name === "ollama" && runtimeOllamaHost
            ? runtimeOllamaHost
            : meta.placeholder;
        const value =
          meta.field === "apiKey"
            ? (cfg.apiKey ?? "")
            : (cfg.baseUrl ?? effectivePlaceholder);
        const hasStored = meta.field === "apiKey" && isMaskedKey(cfg.apiKey);

        return (
          <div key={meta.name} style={credRow}>
            <div style={credLabel}>
              <span>{meta.label}</span>
              {meta.isLocal ? (
                <span style={{ color: C.ok, fontSize: 10, fontFamily: FONT.mono }}>● local</span>
              ) : hasStored ? (
                <span style={{ color: C.ok, fontSize: 10, fontFamily: FONT.mono }}>● set</span>
              ) : (
                <span style={{ color: C.textFaint, fontSize: 10, fontFamily: FONT.mono }}>○ empty</span>
              )}
            </div>
            <input
              type={meta.field === "apiKey" ? "password" : "text"}
              value={value}
              placeholder={effectivePlaceholder}
              onChange={(e) => {
                if (meta.field === "apiKey") {
                  updateProviderField(meta.name, undefined, { apiKey: e.target.value });
                } else {
                  updateProviderField(meta.name, undefined, { baseUrl: e.target.value });
                }
                markDirty(key);
              }}
              onFocus={() => {
                // On first focus into a masked field, clear it so the user
                // can type a fresh key (matches existing Supadata UX).
                if (!isDirty && hasStored) {
                  updateProviderField(meta.name, undefined, { apiKey: "" });
                  markDirty(key);
                }
              }}
              style={inputStyle}
            />
            <button
              onClick={() => void runTest(meta.name)}
              disabled={test?.state === "running"}
              style={smallBtn}
            >
              {test?.state === "running" ? <Loader2 size={11} className="sw-spin" /> : null}
              Test
            </button>
            {meta.field === "apiKey" && hasStored && (
              <button
                onClick={() => clearProviderKey(meta.name)}
                style={{ ...smallBtn, color: C.err }}
              >
                Clear
              </button>
            )}
            <TestBadge result={test?.result} />
          </div>
        );
      })}

      {/* ───── OpenAI-Compat (collapsible) ───── */}
      <button
        onClick={() => setShowOpenAICompat((v) => !v)}
        style={collapseHeader}
      >
        {showOpenAICompat ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        OpenAI-Compat ({presets.length} Presets)
      </button>

      {showOpenAICompat && (
        <div style={{ marginBottom: 18 }}>
          {presets.length === 0 && (
            <div style={{ color: C.textFaint, fontSize: 11, padding: 8 }}>
              Presets werden geladen oder Backend ist offline.
            </div>
          )}
          {presets.map((preset) => {
            const cfg = findOrCreateProvider(providers, "openai-compat", preset.name);
            const key = `openai-compat|${preset.name}`;
            const isDirty = dirtyKeys.has(key);
            const test = testResults[key];
            const hasStored = isMaskedKey(cfg.apiKey);
            const showKeyField = preset.apiKeyRequired;

            return (
              <div key={preset.name} style={compatRow}>
                <label style={compatCheck}>
                  <input
                    type="checkbox"
                    checked={cfg.enabled}
                    onChange={(e) =>
                      updateProviderField("openai-compat", preset.name, {
                        enabled: e.target.checked,
                        baseUrl: cfg.baseUrl ?? preset.baseUrl,
                      })
                    }
                  />
                  <strong style={{ color: cfg.enabled ? C.text : C.textDim }}>
                    {preset.label}
                  </strong>
                  {preset.isLocal && (
                    <span style={{ color: C.ok, fontSize: 10, fontFamily: FONT.mono }}>local</span>
                  )}
                </label>
                {cfg.enabled && (
                  <>
                    {showKeyField && (
                      <input
                        type="password"
                        value={cfg.apiKey ?? ""}
                        placeholder="API Key"
                        onChange={(e) => {
                          updateProviderField("openai-compat", preset.name, {
                            apiKey: e.target.value,
                          });
                          markDirty(key);
                        }}
                        onFocus={() => {
                          if (!isDirty && hasStored) {
                            updateProviderField("openai-compat", preset.name, { apiKey: "" });
                            markDirty(key);
                          }
                        }}
                        style={{ ...inputStyle, flex: 1 }}
                      />
                    )}
                    <input
                      type="text"
                      value={cfg.baseUrl ?? preset.baseUrl}
                      placeholder={preset.baseUrl || "https://…/v1"}
                      onChange={(e) =>
                        updateProviderField("openai-compat", preset.name, {
                          baseUrl: e.target.value,
                        })
                      }
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    {preset.name === "custom" && (
                      <input
                        type="text"
                        value={cfg.defaultModel ?? ""}
                        placeholder="default model (e.g. llama3.1:8b)"
                        onChange={(e) =>
                          updateProviderField("openai-compat", preset.name, {
                            defaultModel: e.target.value,
                          })
                        }
                        style={{ ...inputStyle, flex: 1 }}
                      />
                    )}
                    <button
                      onClick={() => void runTest("openai-compat", preset.name)}
                      disabled={test?.state === "running"}
                      style={smallBtn}
                    >
                      {test?.state === "running" ? (
                        <Loader2 size={11} className="sw-spin" />
                      ) : null}
                      Test
                    </button>
                    <TestBadge result={test?.result} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ───── Task-Routing ───── */}
      <div style={subhead}>Task-Routing</div>
      <div style={{ marginBottom: 18 }}>
        {ROLES.map(({ role, label, hint }) => {
          const assignment = routing.roles[role];
          return (
            <div key={role} style={routingRow}>
              <div style={routingLabel}>
                <strong style={{ fontSize: 13 }}>{label}</strong>
                {hint && (
                  <span style={{ fontSize: 10, color: C.textFaint, fontFamily: FONT.mono }}>
                    {hint}
                  </span>
                )}
              </div>
              <select
                value={
                  assignment
                    ? assignment.provider +
                      (assignment.provider === "openai-compat" ? "" : "")
                    : ""
                }
                onChange={(e) => {
                  const provider = e.target.value;
                  setRouting((prev) => ({
                    ...prev,
                    roles: {
                      ...prev.roles,
                      [role]: provider ? { provider, model: undefined } : undefined,
                    },
                  }));
                }}
                style={selectStyle}
              >
                <option value="">— unassigned —</option>
                {enabledProviderNames.map((p) => (
                  <option key={`${p.name}|${p.preset ?? ""}`} value={p.name}>
                    {p.label}
                  </option>
                ))}
              </select>
              <ModelDropdown
                providerName={assignment?.provider}
                value={assignment?.model ?? ""}
                onChange={(model) => {
                  setRouting((prev) => ({
                    ...prev,
                    roles: {
                      ...prev.roles,
                      [role]: {
                        provider: prev.roles[role]?.provider ?? "",
                        model: model || undefined,
                      },
                    },
                  }));
                }}
              />
            </div>
          );
        })}
      </div>

      {/* ───── Lokale Modelle (Ollama) ───── */}
      {(() => {
        const ollamaModels = configuredOllamaModels(routing);
        if (ollamaModels.length === 0) return null;
        const installed = modelStatus?.installed ?? [];
        const reachable = modelStatus?.ollamaReachable ?? false;
        const present = (model: string) => reachable && isModelInstalled(installed, model);
        const missingChat = ollamaModels.filter(
          (m) => m.kind === "chat" && !present(m.model),
        );

        return (
          <>
            <div style={subhead}>Lokale Modelle (Ollama)</div>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8 }}>
                Lokal geroutete Rollen brauchen das jeweilige Modell in Ollama
                {modelStatus?.host ? ` (@ ${modelStatus.host})` : ""}. Das Chat-Modell
                wird NICHT automatisch geladen — hier siehst du, was fehlt, und
                installierst es mit einem Klick.
              </div>

              {modelStatus && !reachable && (
                <div
                  style={{
                    padding: 10,
                    background: C.elevated,
                    border: `1px solid ${C.err}`,
                    borderRadius: 6,
                    color: C.err,
                    fontSize: 12,
                    marginBottom: 10,
                  }}
                >
                  Ollama nicht erreichbar{modelStatus.host ? ` @ ${modelStatus.host}` : ""}
                  {modelStatus.error ? ` — ${modelStatus.error}` : ""}. Modell-Präsenz nicht
                  prüfbar.
                </div>
              )}

              {reachable && missingChat.length > 0 && (
                <div
                  style={{
                    padding: 10,
                    background: C.elevated,
                    border: `1px solid ${C.gold}`,
                    borderRadius: 6,
                    color: C.text,
                    fontSize: 12,
                    marginBottom: 10,
                  }}
                >
                  <strong style={{ color: C.gold }}>Lokales Chat-Modell fehlt.</strong>{" "}
                  Privacy-Max / lokales Routing läuft sonst still ins Leere — die
                  Tasks werden nicht ausgeführt. Fehlend:{" "}
                  {missingChat.map((m) => m.model).join(", ")}. Unten installieren.
                </div>
              )}

              {ollamaModels.map((m) => {
                const isPresent = present(m.model);
                const pull = pullState[m.model];
                const pct = pullPercent(pull?.progress);
                const size = ollamaModelSize(m.model);
                return (
                  <div key={m.model} style={modelRow}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <span style={{ fontFamily: FONT.mono, fontSize: 12, color: C.text }}>
                        {m.model}
                      </span>
                      <span style={{ fontSize: 10, color: C.textFaint, fontFamily: FONT.mono }}>
                        {m.kind} · {m.roles.join(", ")}
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {isPresent ? (
                        <span style={{ color: C.ok, fontSize: 11, fontFamily: FONT.mono }}>
                          <Check size={12} /> installiert
                        </span>
                      ) : !reachable ? (
                        <span style={{ color: C.textFaint, fontSize: 11, fontFamily: FONT.mono }}>
                          Ollama offline
                        </span>
                      ) : pull?.running ? (
                        <span style={{ color: C.accent, fontSize: 11, fontFamily: FONT.mono }}>
                          <Loader2 size={11} className="sw-spin" />{" "}
                          {pull.progress?.status ?? "startet…"}
                          {pct !== null ? ` ${pct}%` : ""}
                        </span>
                      ) : pull?.done ? (
                        <span style={{ color: C.ok, fontSize: 11, fontFamily: FONT.mono }}>
                          <Check size={12} /> installiert
                        </span>
                      ) : (
                        <>
                          <span style={{ color: C.err, fontSize: 11, fontFamily: FONT.mono }}>
                            <X size={11} /> fehlt
                          </span>
                          <button onClick={() => installModel(m.model)} style={smallBtn}>
                            <Download size={11} /> Modell installieren
                            {size ? ` (${size})` : ""}
                          </button>
                        </>
                      )}
                    </div>

                    {pull?.running && pct !== null && (
                      <div style={{ ...progressBar, gridColumn: "1 / -1" }}>
                        <div
                          style={{
                            width: `${pct}%`,
                            height: "100%",
                            background: C.accent,
                            transition: "width 200ms ease",
                          }}
                        />
                      </div>
                    )}
                    {pull?.error && (
                      <div
                        style={{
                          gridColumn: "1 / -1",
                          color: C.err,
                          fontSize: 11,
                          marginTop: 2,
                        }}
                      >
                        Installation fehlgeschlagen: {pull.error}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

      {/* ───── Embedding Migration ───── */}
      <div style={subhead}>Embedding-Migration</div>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, color: C.textDim, marginBottom: 8 }}>
          Wechselt der Embedding-Provider/Modell, müssen ALLE Notes neu
          embedded werden — der Vektorraum unterscheidet sich pro Modell.
          Die alte Generation bleibt aktiv, bis die neue vollständig
          aufgebaut ist (atomic swap).
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => {
              const assignment = routing.roles.embedding;
              if (!assignment) return;
              setMigConfirm({
                toProvider: assignment.provider,
                toModel: assignment.model,
              });
            }}
            disabled={migrationButtonDisabled()}
            style={{
              ...btnPrimary,
              opacity: migrationButtonDisabled() ? 0.5 : 1,
              cursor: migrationButtonDisabled() ? "not-allowed" : "pointer",
            }}
          >
            {migrationButtonLabel()}
          </button>
          {!routing.roles.embedding && (
            <span style={{ color: C.textFaint, fontSize: 11 }}>
              Erst eine Embedding-Rolle im Task-Routing zuweisen.
            </span>
          )}
        </div>

        {migConfirm && (
          <div
            style={{
              marginTop: 10,
              padding: 12,
              background: C.elevated,
              border: `1px solid ${C.accent}`,
              borderRadius: 6,
            }}
          >
            <div style={{ fontSize: 13, color: C.text, marginBottom: 6 }}>
              Migration zu{" "}
              <strong style={{ color: C.accent }}>
                {migConfirm.toProvider}
                {migConfirm.toModel ? ` / ${migConfirm.toModel}` : ""}
              </strong>{" "}
              starten?
            </div>
            <div style={{ fontSize: 11, color: C.textDim, marginBottom: 10 }}>
              Alle Notes im Vault werden neu embedded. Der Vorgang läuft im
              Hintergrund und kann jederzeit abgebrochen werden. Die alte
              Generation bleibt aktiv bis zum erfolgreichen Abschluss.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => void startMigrationRun(migConfirm.toProvider, migConfirm.toModel)}
                style={btnPrimary}
              >
                Migration starten
              </button>
              <button onClick={() => setMigConfirm(null)} style={btn}>
                Abbrechen
              </button>
            </div>
          </div>
        )}

        {migration && (
          <div
            style={{
              marginTop: 10,
              padding: 12,
              background: C.elevated,
              border: `1px solid ${
                migration.status === "failed"
                  ? C.err
                  : migration.status === "completed"
                  ? C.ok
                  : C.border
              }`,
              borderRadius: 6,
            }}
          >
            <div style={{ fontSize: 12, color: C.text, marginBottom: 6 }}>
              {migration.status === "running" || migration.status === "pending" ? (
                <>
                  Re-Embedding {migration.processedNotes} von {migration.totalNotes} Notes…{" "}
                  {migration.totalNotes > 0
                    ? Math.round((migration.processedNotes / migration.totalNotes) * 100)
                    : 0}
                  %
                </>
              ) : migration.status === "completed" ? (
                <>
                  <Check size={12} /> Migration abgeschlossen (
                  {Math.round(migration.elapsedMs / 1000)}s, {migration.errorCount} Fehler)
                </>
              ) : migration.status === "cancelled" ? (
                <>Migration abgebrochen ({migration.processedNotes} von {migration.totalNotes})</>
              ) : (
                <>
                  <X size={12} /> Migration fehlgeschlagen
                  {migration.errorMessage ? `: ${migration.errorMessage}` : ""}. Alte
                  Embeddings bleiben aktiv.
                </>
              )}
            </div>
            <div style={progressBar}>
              <div
                style={{
                  width: `${
                    migration.totalNotes > 0
                      ? Math.min(
                          100,
                          (migration.processedNotes / migration.totalNotes) * 100,
                        )
                      : 0
                  }%`,
                  height: "100%",
                  background:
                    migration.status === "failed"
                      ? C.err
                      : migration.status === "completed"
                      ? C.ok
                      : C.accent,
                  transition: "width 200ms ease",
                }}
              />
            </div>
            <div
              style={{
                fontSize: 10,
                color: C.textFaint,
                fontFamily: FONT.mono,
                marginTop: 6,
              }}
            >
              {migration.fromProvider}/{migration.fromModel} → {migration.toProvider}/
              {migration.toModel}
            </div>
            {(migration.status === "pending" || migration.status === "running") && (
              <div style={{ marginTop: 8 }}>
                <button onClick={() => void cancelMigrationRun()} style={smallBtn}>
                  Cancel
                </button>
              </div>
            )}
            {(migration.status === "completed" ||
              migration.status === "failed" ||
              migration.status === "cancelled") && (
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() => {
                    if (migAbort) migAbort();
                    setMigration(null);
                    setMigError(undefined);
                  }}
                  style={smallBtn}
                >
                  Schließen
                </button>
              </div>
            )}
          </div>
        )}

        {migError && (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              background: C.elevated,
              border: `1px solid ${C.err}`,
              borderRadius: 6,
              color: C.err,
              fontSize: 12,
            }}
          >
            {migError}
          </div>
        )}
      </div>

      {/* ───── Privacy ───── */}
      <div style={subhead}>Privacy</div>
      <div style={{ marginBottom: 18 }}>
        {(
          [
            { id: "always_local", label: "Always Local", desc: "Niemals Cloud-Provider — alle Rollen müssen lokal sein." },
            { id: "local_for_personal_folders", label: "Local for Personal Folders", desc: "Cloud OK, außer für Notes in den unten gelisteten Foldern." },
            { id: "cloud_ok", label: "Cloud OK", desc: "Keine Einschränkung. Routing entscheidet allein." },
          ] as { id: PrivacyTier; label: string; desc: string }[]
        ).map((tier) => (
          <label
            key={tier.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "6px 0",
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="privacy-tier"
              checked={routing.privacyTier === tier.id}
              onChange={() =>
                setRouting((prev) => ({ ...prev, privacyTier: tier.id }))
              }
              style={{ marginTop: 4 }}
            />
            <div>
              <div style={{ fontSize: 13 }}>{tier.label}</div>
              <div style={{ fontSize: 11, color: C.textDim }}>{tier.desc}</div>
            </div>
          </label>
        ))}

        {routing.privacyTier === "local_for_personal_folders" && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: C.textDim, marginBottom: 6, fontFamily: FONT.mono }}>
              Personal Folders (vault-relativ)
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {(routing.privacyTierFolders ?? []).map((f) => (
                <span key={f} style={chip}>
                  {f}
                  <button
                    onClick={() =>
                      setRouting((prev) => ({
                        ...prev,
                        privacyTierFolders: (prev.privacyTierFolders ?? []).filter(
                          (x) => x !== f,
                        ),
                      }))
                    }
                    style={chipX}
                    aria-label={`Remove ${f}`}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                value={folderInput}
                onChange={(e) => setFolderInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && folderInput.trim()) {
                    e.preventDefault();
                    const next = folderInput.trim();
                    setRouting((prev) => ({
                      ...prev,
                      privacyTierFolders: Array.from(
                        new Set([...(prev.privacyTierFolders ?? []), next]),
                      ),
                    }));
                    setFolderInput("");
                  }
                }}
                placeholder="z.B. 40_customers/"
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                onClick={() => {
                  if (!folderInput.trim()) return;
                  const next = folderInput.trim();
                  setRouting((prev) => ({
                    ...prev,
                    privacyTierFolders: Array.from(
                      new Set([...(prev.privacyTierFolders ?? []), next]),
                    ),
                  }));
                  setFolderInput("");
                }}
                style={smallBtn}
              >
                Add
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ───── Budget ───── */}
      <div style={subhead}>Budget</div>
      <div style={{ marginBottom: 18 }}>
        {usage.length === 0 && (
          <div style={{ color: C.textFaint, fontSize: 12 }}>
            Noch keine Usage erfasst.
          </div>
        )}
        {usage.map((u) => {
          const totalTokens = u.monthInputTokens + u.monthOutputTokens;
          const pct = u.budgetPercent ?? 0;
          return (
            <div key={u.provider} style={budgetRow}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <strong>{u.provider}</strong>
                <span style={{ color: C.textDim, fontFamily: FONT.mono }}>
                  {totalTokens.toLocaleString()} tokens · ${u.monthCostUsd.toFixed(2)} / month
                  {u.budgetUsd !== undefined
                    ? ` (cap: $${u.budgetUsd.toFixed(2)})`
                    : " (cap: not set)"}
                </span>
              </div>
              <div style={progressBar}>
                <div
                  style={{
                    width: `${Math.min(100, pct)}%`,
                    height: "100%",
                    background: progressColor(pct),
                    transition: "width 200ms ease",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* ───── Save ───── */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
        <button
          onClick={() => void save()}
          disabled={saveState === "saving"}
          style={btnPrimary}
        >
          {saveState === "saving" && <Loader2 size={14} className="sw-spin" />}
          Settings speichern
        </button>
        {saveState === "ok" && (
          <span style={{ color: C.ok, fontSize: 13 }}>
            <Check size={14} /> gespeichert
          </span>
        )}
        {saveState === "fail" && (
          <span style={{ color: C.err, fontSize: 13 }}>
            <X size={14} /> {saveError}
          </span>
        )}
      </div>
    </section>
  );
}

// ───────────────────────── Sub-components ─────────────────────────

function ModelDropdown({
  providerName,
  value,
  onChange,
}: {
  providerName: string | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  if (!providerName) {
    return (
      <input
        value=""
        placeholder="model"
        disabled
        style={{ ...inputStyle, opacity: 0.4, flex: 1 }}
      />
    );
  }
  const known = KNOWN_MODELS[providerName];
  // openai-compat / custom / unknown → free text input
  if (!known) {
    return (
      <input
        type="text"
        value={value}
        placeholder="model"
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, flex: 1 }}
      />
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...selectStyle, flex: 1 }}
    >
      <option value="">— model —</option>
      {known.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

function TestBadge({ result }: { result?: TestConnectionResult }) {
  if (!result) return <span style={{ width: 90 }} />;
  if (result.ok) {
    return (
      <span style={{ color: C.ok, fontSize: 11, fontFamily: FONT.mono, minWidth: 90 }}>
        <Check size={11} /> OK
        {result.latencyMs !== undefined ? ` (${result.latencyMs}ms)` : ""}
      </span>
    );
  }
  return (
    <span
      style={{ color: C.err, fontSize: 11, fontFamily: FONT.mono, minWidth: 90 }}
      title={result.error}
    >
      <X size={11} /> {result.error?.slice(0, 24) ?? "fail"}
    </span>
  );
}

// ───────────────────────── Styles ─────────────────────────

const subhead: React.CSSProperties = {
  fontSize: 11,
  color: C.textDim,
  fontFamily: FONT.mono,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 8,
  marginTop: 6,
  paddingTop: 8,
  borderTop: `1px solid ${C.borderSoft}`,
};

const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  background: C.elevated,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  color: C.text,
  fontFamily: FONT.mono,
  fontSize: 12,
  outline: "none",
  minWidth: 0,
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

const btn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  background: C.elevated,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  color: C.text,
  fontFamily: FONT.ui,
  fontSize: 12,
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  ...btn,
  background: C.accent,
  borderColor: C.accent,
  color: "#FFFFFF",
  fontWeight: 500,
};

const smallBtn: React.CSSProperties = {
  ...btn,
  padding: "4px 8px",
  fontSize: 11,
};

const profileBtn: React.CSSProperties = {
  ...btn,
  borderColor: C.accent,
  color: C.accent,
  fontWeight: 500,
};

const credRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "140px 1fr auto auto 100px",
  gap: 8,
  alignItems: "center",
  marginBottom: 6,
};

const credLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 13,
};

const collapseHeader: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  marginBottom: 8,
  marginTop: 4,
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  color: C.text,
  fontFamily: FONT.ui,
  fontSize: 12,
  cursor: "pointer",
};

const compatRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 6,
  flexWrap: "wrap",
  padding: 6,
  background: C.elevated,
  borderRadius: 4,
};

const compatCheck: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minWidth: 180,
  fontSize: 12,
  cursor: "pointer",
};

const routingRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "180px 200px 1fr",
  gap: 8,
  alignItems: "center",
  marginBottom: 6,
};

const routingLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 8px",
  background: C.elevated,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  fontSize: 11,
  fontFamily: FONT.mono,
  color: C.text,
};

const chipX: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: C.textDim,
  cursor: "pointer",
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
};

const budgetRow: React.CSSProperties = {
  marginBottom: 10,
};

const modelRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: 8,
  alignItems: "center",
  padding: "8px 10px",
  marginBottom: 6,
  background: C.elevated,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
};

const progressBar: React.CSSProperties = {
  width: "100%",
  height: 6,
  background: C.elevated,
  borderRadius: 3,
  overflow: "hidden",
  marginTop: 4,
};
