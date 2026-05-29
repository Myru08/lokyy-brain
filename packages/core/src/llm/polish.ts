import { llmRegistry } from "./registry.js";
import { budgetTracker } from "./budget.js";
import { LlmError } from "./errors.js";
import { DOC_TYPES, type DocType } from "../frontmatter/types.js";
import type { ChatMessage, LlmProvider } from "./types.js";

/**
 * AI-Polish — clean up a raw note (typically a Whisper voice transcript)
 * into a well-structured Markdown note with a meaningful title, tags,
 * type, and one-sentence summary. NEVER invents facts; only restructures
 * and de-filler-words the existing text.
 *
 * Provider routing
 * ----------------
 * The polish endpoint is a one-off chat call rather than a router-role
 * mapping — we deliberately reuse the existing `llmRegistry()` (populated
 * from `getLlmProviders()` at boot) rather than introduce a new
 * `polish`-role in `LlmRoutingConfig`. Rationale:
 *
 *   - Polish is a user-triggered ad-hoc operation, not a stage in the
 *     retrieval pipeline. Forcing it through `LlmRouter.getProvider` would
 *     pull it into the privacy-tier logic without a clear meaning (the
 *     note's `privacy:` field is irrelevant here; the polished text is
 *     written back to the same note, so any privacy decision is "what
 *     provider did the user already trust for this note's content").
 *   - The caller can still override per-call (`provider`, `model`).
 *
 * Default chain (when caller doesn't override):
 *   1. OpenAI  — gpt-4o-mini  (fast + cheap, sufficient quality for cleanup)
 *   2. Anthropic — claude-haiku-4-5 (cheapest Claude, comparable quality)
 *   3. Cohere   — intentionally NOT chat-capable in this codebase; skipped
 *      automatically by the capability check, even when configured. The
 *      caller-facing contract still mentions cohere so the route remains
 *      forward-compatible with a future Cohere-Command provider.
 *
 * Any provider with `chat` capability that the user has enabled is
 * acceptable; we just walk the chain in order. If none of the chain
 * candidates are registered/chat-capable, the function throws
 * `PolishKeyMissingError`.
 */

const POLISH_TIMEOUT_MS = 60_000;
const DEFAULT_PROVIDER_CHAIN = ["openai", "anthropic", "cohere"] as const;

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  cohere: "command-r-plus", // forward-compat; cohere has no chat in current provider impl
};

const SYSTEM_PROMPT =
  `Du bist ein Assistent der rohe Notizen aufbereitet. Du bekommst eine Notiz, oft ein Voice-Transkript. ` +
  `Strukturiere sie zu einer klaren Markdown-Notiz mit passendem Frontmatter. WICHTIG:\n` +
  `- Keine Fakten erfinden oder ändern. Nur Format und Klarheit verbessern.\n` +
  `- Füllwörter, Versprecher, Wiederholungen raus.\n` +
  `- Markdown-Struktur: Überschriften (#, ##), Listen (-), Hervorhebungen (**...**) wo sinnvoll.\n` +
  `- Sprache des Originals beibehalten (deutsch bleibt deutsch).\n` +
  `- Antworte AUSSCHLIESSLICH als gültiges JSON, kein zusätzlicher Text.\n` +
  `\n` +
  `Antwortformat:\n` +
  `{\n` +
  `  "title": "Prägnanter Titel, max 80 Zeichen",\n` +
  `  "tags": ["max", "5", "thematische", "tags"],\n` +
  `  "type": "note" | "capture" | "decision" | "meeting" | "task",\n` +
  `  "summary": "Ein Satz, max 200 Zeichen",\n` +
  `  "body": "Markdown-formatierter, aufbereiteter Text"\n` +
  `}`;

const RETRY_PROMPT =
  `Du hast invalid JSON geantwortet, antworte erneut als reines JSON.`;

/** Allowed `type` values the polished result may map back to. */
const POLISH_ALLOWED_TYPES = new Set<DocType>([
  "note",
  "capture",
  "decision",
  "meeting",
  "task",
]);

export type PolishProviderName = "openai" | "anthropic" | "cohere";

export interface PolishOptions {
  /** Override the default provider chain — caller picks a single provider. */
  provider?: PolishProviderName;
  /** Override the model on the chosen provider. */
  model?: string;
}

export interface PolishResult {
  title: string;
  tags: string[];
  type: DocType;
  summary: string;
  body: string;
  /** Provider name actually used (e.g. "openai"). */
  providerUsed: string;
  /** Model name actually used (e.g. "gpt-4o-mini"). */
  modelUsed: string;
}

/** No provider chain candidate is registered AND chat-capable. */
export class PolishKeyMissingError extends Error {
  readonly code = "llm-key-missing";
  constructor(message: string) {
    super(message);
    this.name = "PolishKeyMissingError";
  }
}

/** Provider chain ran but every attempt failed (network/parse/auth/rate). */
export class PolishLlmError extends Error {
  readonly code = "llm-error";
  constructor(
    message: string,
    readonly attempts: Array<{ provider: string; error: string }>,
  ) {
    super(message);
    this.name = "PolishLlmError";
  }
}

/**
 * Strict JSON-shape narrower for the parsed LLM response. Returns a
 * normalised result on success or `null` on any structural mismatch.
 * Tolerates a few common LLM quirks (string-with-comma-tags, missing
 * tags array → empty, unknown `type` → "note").
 */
function parsePolishJson(text: string): {
  title: string;
  tags: string[];
  type: DocType;
  summary: string;
  body: string;
} | null {
  // Strip leading/trailing markdown fences a chatty model might add.
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    cleaned = cleaned.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const body = typeof obj.body === "string" ? obj.body : "";

  if (!title || !body) return null;

  // tags: array of strings, OR comma-string fallback, OR missing → []
  let tags: string[] = [];
  if (Array.isArray(obj.tags)) {
    tags = obj.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 5);
  } else if (typeof obj.tags === "string") {
    tags = obj.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 5);
  }

  // type: enum-check against the polish-allowed subset; default "note".
  let type: DocType = "note";
  if (typeof obj.type === "string") {
    const candidate = obj.type.trim().toLowerCase();
    if (
      (DOC_TYPES as readonly string[]).includes(candidate) &&
      POLISH_ALLOWED_TYPES.has(candidate as DocType)
    ) {
      type = candidate as DocType;
    }
  }

  return {
    title: title.slice(0, 80),
    tags,
    type,
    summary: summary.slice(0, 200),
    body,
  };
}

/**
 * Resolve the chat provider chain for this polish call.
 *
 * - Caller-supplied `provider` ⇒ single-element chain (no fallback).
 * - Otherwise ⇒ walk `DEFAULT_PROVIDER_CHAIN`, keeping only registered
 *   AND chat-capable providers.
 *
 * Returns `[]` when nothing usable exists — caller must surface
 * `PolishKeyMissingError`.
 */
function resolveProviderChain(opts: PolishOptions): LlmProvider[] {
  const registry = llmRegistry();
  const candidates = opts.provider
    ? [opts.provider]
    : [...DEFAULT_PROVIDER_CHAIN];
  const out: LlmProvider[] = [];
  for (const name of candidates) {
    const p = registry.get(name);
    if (!p) continue;
    if (!p.info.capabilities.chat || typeof p.chat !== "function") continue;
    out.push(p);
  }
  return out;
}

/**
 * Polish a raw note body into structured Markdown + frontmatter fields.
 *
 * The function ONLY talks to the LLM — it does NOT load or save the note.
 * The caller (the `/api/notes/:id/ai-polish` route) is responsible for
 * reading the note, merging the result into frontmatter, and saving via
 * `notesService.saveNote`.
 *
 * Wrapping rules:
 *   - One retry on JSON-parse failure with an explicit "respond as pure
 *     JSON" follow-up. After the second failure → `PolishLlmError`.
 *   - 60s `AbortSignal.timeout(60_000)` per attempt (LLM cleanup is
 *     materially slower than transcription).
 *   - Budget tracking via `budgetTracker()` mirrors the rest of the LLM
 *     pipeline — every successful call records a `UsageEvent` under
 *     role=`lint` (no dedicated `polish` role; lint is the closest
 *     "cleanup" semantic in `LlmRole`).
 *
 * Provider-chain fail-over: only structural failures (no candidates
 * registered) raise `PolishKeyMissingError`. Network / auth / parse
 * failures bubble up as `PolishLlmError` after all chain members are
 * exhausted.
 */
export async function polishNote(
  rawBody: string,
  opts: PolishOptions = {},
): Promise<PolishResult> {
  const chain = resolveProviderChain(opts);
  if (chain.length === 0) {
    throw new PolishKeyMissingError(
      opts.provider
        ? `provider "${opts.provider}" is not registered or has no chat capability — configure it in Settings → AI Provider`
        : "no chat-capable LLM provider configured (tried: openai, anthropic, cohere) — add a key in Settings → AI Provider",
    );
  }

  const attempts: Array<{ provider: string; error: string }> = [];

  for (const provider of chain) {
    const providerName = provider.info.name;
    const model =
      opts.model ??
      provider.info.defaultModel ??
      DEFAULT_MODELS[providerName] ??
      "default";

    try {
      const result = await runOnce(provider, rawBody, model);
      return {
        ...result,
        providerUsed: providerName,
        modelUsed: model,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      attempts.push({ provider: providerName, error: errorMsg });
      // Continue to next provider in chain (only triggers if caller did
      // NOT pin a specific provider — single-element chain stops here).
    }
  }

  throw new PolishLlmError(
    `all polish providers failed (${attempts.length} attempt${attempts.length === 1 ? "" : "s"})`,
    attempts,
  );
}

// ── Title suggestion ───────────────────────────────────────────────────
//
// Lightweight sibling of `polishNote`: instead of restructuring the whole
// note, it asks the SAME configured provider chain for ONE concise title
// derived from a (typically Whisper) transcript. Deliberately reuses
// `resolveProviderChain` / `withTimeout` / `recordUsage` so the feature
// stays provider-agnostic — whatever chat-capable provider the user has
// configured for polish is used here too, with no new hardcoded OpenAI
// dependency.

/** Shorter deadline than polish — a single short title is fast. */
const SUGGEST_TITLE_TIMEOUT_MS = 20_000;

const SUGGEST_TITLE_SYSTEM_PROMPT =
  `Du erzeugst aus einem (oft gesprochenen) Transkript EINEN prägnanten Notiz-Titel. Regeln:\n` +
  `- Genau 3 bis 7 Wörter.\n` +
  `- In der Sprache des Transkripts (deutsch bleibt deutsch).\n` +
  `- KEINE Anführungszeichen, KEIN abschließendes Satzzeichen, KEIN Markdown.\n` +
  `- Antworte AUSSCHLIESSLICH mit dem Titel selbst — kein Vor- oder Nachtext.`;

/** Max chars of the title we accept back (defensive; matches polish title cap). */
const SUGGEST_TITLE_MAX_LEN = 80;

export interface SuggestTitleOptions extends PolishOptions {
  /**
   * Optional ISO 639-1 language hint. When provided it's appended to the
   * user message so the model doesn't have to infer the language from a
   * very short transcript. Falls through to "match the transcript" when
   * absent.
   */
  language?: string;
}

export interface SuggestTitleResult {
  title: string;
  providerUsed: string;
  modelUsed: string;
}

/**
 * Normalise a raw model response into a clean single-line title:
 *   - takes the first non-empty line,
 *   - strips wrapping single/double quotes and backticks,
 *   - strips a single trailing sentence punctuation char,
 *   - collapses whitespace, caps length.
 * Returns "" when nothing usable remains (caller falls back).
 */
function normalizeTitle(raw: string): string {
  const firstLine = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  let t = firstLine.replace(/\s+/g, " ").trim();
  // Strip matching surrounding quotes/backticks (possibly repeated).
  let prev = "";
  while (prev !== t) {
    prev = t;
    t = t.replace(/^["'`«»“”„]+/, "").replace(/["'`«»“”„]+$/, "").trim();
  }
  // Drop a single trailing sentence-ending punctuation mark.
  t = t.replace(/[.!?。！？]+$/, "").trim();
  return t.slice(0, SUGGEST_TITLE_MAX_LEN).trim();
}

/**
 * Ask the configured LLM for a concise 3–7 word title for `transcript`.
 *
 * Provider resolution + fail-over are identical to `polishNote`
 * (same `resolveProviderChain`, same default chain
 * openai → anthropic → cohere, same per-call override). Usage is recorded
 * under role=`lint` like polish.
 *
 * Throws `PolishKeyMissingError` when no chat-capable provider is
 * configured, and `PolishLlmError` when every chain member failed
 * (network/auth/empty). The ROUTE wraps this so the note-creation flow
 * never 500-crashes — a thrown error there maps to a graceful fallback.
 */
export async function suggestNoteTitle(
  transcript: string,
  opts: SuggestTitleOptions = {},
): Promise<SuggestTitleResult> {
  const chain = resolveProviderChain(opts);
  if (chain.length === 0) {
    throw new PolishKeyMissingError(
      opts.provider
        ? `provider "${opts.provider}" is not registered or has no chat capability — configure it in Settings → AI Provider`
        : "no chat-capable LLM provider configured (tried: openai, anthropic, cohere) — add a key in Settings → AI Provider",
    );
  }

  const userContent = opts.language
    ? `Sprache: ${opts.language}\n\nTranskript:\n${transcript}`
    : transcript;

  const attempts: Array<{ provider: string; error: string }> = [];

  for (const provider of chain) {
    const providerName = provider.info.name;
    const model =
      opts.model ??
      provider.info.defaultModel ??
      DEFAULT_MODELS[providerName] ??
      "default";

    if (!provider.chat) continue;

    try {
      const result = await withTimeout(
        provider.chat([{ role: "user", content: userContent }], {
          model,
          systemPrompt: SUGGEST_TITLE_SYSTEM_PROMPT,
          temperature: 0.4,
          maxTokens: 32,
        }),
        SUGGEST_TITLE_TIMEOUT_MS,
        `${providerName} suggest-title call timed out after ${SUGGEST_TITLE_TIMEOUT_MS}ms`,
      );
      await recordUsage(
        providerName,
        model,
        result.usage.inputTokens,
        result.usage.outputTokens,
      );
      const title = normalizeTitle(result.text);
      if (title) {
        return { title, providerUsed: providerName, modelUsed: model };
      }
      attempts.push({ provider: providerName, error: "empty-title" });
    } catch (err) {
      attempts.push({
        provider: providerName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new PolishLlmError(
    `all suggest-title providers failed (${attempts.length} attempt${attempts.length === 1 ? "" : "s"})`,
    attempts,
  );
}

/**
 * One end-to-end attempt against a single provider, including retry on
 * malformed JSON. Throws `LlmError` (provider-mapped) or `PolishLlmError`
 * (parse-twice failure).
 */
async function runOnce(
  provider: LlmProvider,
  rawBody: string,
  model: string,
): Promise<{
  title: string;
  tags: string[];
  type: DocType;
  summary: string;
  body: string;
}> {
  if (!provider.chat) {
    throw new LlmError(
      "CAPABILITY_MISSING",
      `${provider.info.name} has no chat capability`,
      provider.info.name,
    );
  }

  const baseMessages: ChatMessage[] = [
    { role: "user", content: rawBody },
  ];

  // ── Attempt 1 ───────────────────────────────────────────────────────
  // The provider implementations do NOT forward `ChatOpts.extra.signal` to
  // their SDK clients (verified against `providers/openai.ts` +
  // `providers/anthropic.ts`). To honor the hard-constraint 60s deadline
  // we wrap the call in `Promise.race` against `AbortSignal.timeout`.
  // Caveat: this only ABORTS our wait — the in-flight HTTP request
  // continues until the SDK's own keepalive timeout. The token-cost of
  // the orphaned response is still small relative to the polish budget,
  // and the user-facing latency stops here as required.
  const first = await withTimeout(
    provider.chat(baseMessages, {
      model,
      systemPrompt: SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 2048,
    }),
    POLISH_TIMEOUT_MS,
    `${provider.info.name} polish call timed out after ${POLISH_TIMEOUT_MS}ms`,
  );
  await recordUsage(provider.info.name, model, first.usage.inputTokens, first.usage.outputTokens);

  const firstParsed = parsePolishJson(first.text);
  if (firstParsed) return firstParsed;

  // ── Attempt 2 — explicit JSON-only retry ────────────────────────────
  const retryMessages: ChatMessage[] = [
    { role: "user", content: rawBody },
    { role: "assistant", content: first.text },
    { role: "user", content: RETRY_PROMPT },
  ];
  const second = await withTimeout(
    provider.chat(retryMessages, {
      model,
      systemPrompt: SYSTEM_PROMPT,
      temperature: 0.1,
      maxTokens: 2048,
    }),
    POLISH_TIMEOUT_MS,
    `${provider.info.name} polish retry call timed out after ${POLISH_TIMEOUT_MS}ms`,
  );
  await recordUsage(provider.info.name, model, second.usage.inputTokens, second.usage.outputTokens);

  const secondParsed = parsePolishJson(second.text);
  if (secondParsed) return secondParsed;

  throw new PolishLlmError(
    `${provider.info.name} returned malformed JSON twice`,
    [
      { provider: provider.info.name, error: `parse-failed-1: ${truncate(first.text)}` },
      { provider: provider.info.name, error: `parse-failed-2: ${truncate(second.text)}` },
    ],
  );
}

/**
 * Record a usage event under role=`lint` (closest "cleanup" semantic in
 * `LlmRole`). Fire-and-forget at the call-site — budget tracking must
 * never fail the polish request.
 */
async function recordUsage(
  providerName: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  try {
    const tracker = budgetTracker();
    const estimatedCostUsd = tracker.estimateCost(
      providerName,
      model,
      inputTokens,
      outputTokens,
    );
    await tracker.record({
      provider: providerName,
      role: "lint",
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      timestamp: new Date(),
    });
  } catch {
    // Budget tracker is best-effort; swallow.
  }
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * Race the promise against `AbortSignal.timeout(ms)`. Rejects with
 * `LlmError(UNAVAILABLE)` carrying the supplied message on deadline hit.
 * Used because the provider SDKs in this codebase do not currently
 * forward `ChatOpts.extra.signal` — a router-level timeout is the
 * portable enforcement point.
 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = AbortSignal.timeout(ms);
    signal.addEventListener(
      "abort",
      () => reject(new LlmError("UNAVAILABLE", message)),
      { once: true },
    );
    p.then(resolve, reject);
  });
}
