import { eq, sql } from "drizzle-orm";

import { database } from "../../db/index.js";
import { entityMentions } from "../../db/schema/entities.js";
import { listNotes, getNote } from "../../notes/notesService.js";
import {
  upsertEntity,
  isEntityType,
  type ExtractedEntity,
  type EntityType,
} from "../../entities/index.js";
import { LlmRouter, routeContextFromNote } from "../../llm/router.js";
import { getLlmRouting } from "../../llm/configStore.js";
import { LlmUnavailable } from "../../llm/errors.js";
import { parseFrontmatter } from "../../frontmatter/index.js";
import { isHandsOffZone } from "../rawGuard.js";
import type { ChatMessage } from "../../llm/types.js";
import type { SleepPass, SleepRun, SleepPassResult } from "../types.js";

/**
 * Phase C Wave C2 / Story 2 — Entity-Extraction REM-sleep pass.
 *
 * Walks recent / unprocessed notes and asks the configured `ner`-role LLM
 * (lokal-bevorzugt via Ollama Llama 3.1 8B) to extract named entities.
 * Each extraction goes through `upsertEntity`, which:
 *
 *   - normalizes the displayName to canonical-form (umlaut-aware),
 *   - dedups against `(canonical, type)` — re-runs do NOT duplicate rows,
 *   - inserts a per-(entity, note) edge in `entity_mentions` idempotently.
 *
 * Cost bounds (intentional, see constants):
 *   - `NOTES_PER_RUN = 20`            — at most one nightly LLM-call burst.
 *   - `MAX_TEXT_PER_NOTE = 4000` chars — long notes are truncated head-only;
 *      good enough for the surface entity-set, the full-body pass lives in
 *      Phase D when spaCy/GLiNER take over.
 *   - `nerTokenBudget()`               — per-note output ceiling, see below.
 *
 * Issue #53 — the pass used to fail SILENTLY on every longer note: a fixed
 * `maxTokens: 1000` cut the model off mid-object (`done_reason: "length"`),
 * the closing `]` never arrived, `tryParseJsonArray` returned null, and the
 * caller did `errors++; continue;` without a single log line. Three changes
 * keep that from recurring, each effective on its own:
 *   1. the token budget scales with the note length (`nerTokenBudget`),
 *   2. the prompt no longer asks for `contextSnippet` — by far the largest
 *      per-entity cost — the snippet is derived locally from the note text,
 *   3. `ChatResult.finishReason` is evaluated: a `length` abort is logged and
 *      counted separately from "model produced garbage", so the two failure
 *      modes are distinguishable in `SleepPassResult.notes` without a
 *      log dive.
 *
 * Privacy: per-note `routeContextFromNote` — `privacy: local-only` notes
 * never hit a cloud provider; if the local NER chain is empty, the note is
 * counted as an error and skipped.
 *
 * Candidate selection: a note enters the run if EITHER (a) it has no
 * entries in `entity_mentions` yet (cold-start) OR (b) its `updatedAt` is
 * within the trailing 7-day window (re-extract recently-edited notes).
 * The candidate scan stops at `NOTES_PER_RUN` accepted notes so a 10000-
 * note vault doesn't tail the loop.
 */

const NOTES_PER_RUN = 20;
const MAX_TEXT_PER_NOTE = 4000;
const RECENT_WINDOW_MS = 7 * 86_400_000;
const VALID_TYPE_SET = new Set<string>([
  "person",
  "organization",
  "location",
  "concept",
  "date",
  "event",
]);

/**
 * NOTE: no `contextSnippet` field. It used to ask the model for ~100 chars of
 * surrounding text per entity — the single largest contributor to the output
 * length (a 100-char German snippet costs ~35 tokens, more than the rest of
 * the object combined) and the reason the 1000-token budget blew up. The
 * snippet is now derived from the note text in `deriveSnippet()`: cheaper,
 * and accurate instead of paraphrased-by-the-model.
 */
const NER_PROMPT = `Extract named entities from the following text. For each entity, output:
- displayName (as it appears in text, but cleaned)
- type: one of [person, organization, location, concept, date, event]
- confidence: 0..1

Output ONLY valid JSON array. No preamble. Schema:
[{"displayName": "...", "type": "...", "confidence": 0.x}]

Text:
{{TEXT}}`;

/**
 * Per-note output-token budget.
 *
 * Fixed budgets are the bug (#53): a note that yields more entities than the
 * budget allows is cut off mid-JSON and silently lost. The budget therefore
 * scales with the amount of text the model actually sees.
 *
 * Calibration (snippet-free schema, measured against the Ollama NER chain):
 *   - one entity object serializes to ~25-30 tokens; `TOKENS_PER_ENTITY = 45`
 *     leaves headroom for long German compounds and umlaut-heavy names,
 *     which tokenize worse than the English average.
 *   - `CHARS_PER_ENTITY = 120` is deliberately pessimistic — normal prose sits
 *     nearer one entity per 200 chars; 120 covers list-shaped notes (meeting
 *     attendees, tool lists) that are almost pure entities.
 *   - `OVERHEAD = 64` pays for the array brackets and any short preamble the
 *     model insists on emitting.
 *
 * The ceiling stays: the budget is what the run may spend WORST case, and on
 * a CPU-only Ollama install every extra 1000 tokens is roughly half a minute
 * per note (× `NOTES_PER_RUN`). At `NER_MAX_TOKENS = 2000` a fully degenerate
 * run stays inside ~20 minutes. The formula itself tops out at ~1560 tokens
 * for a `MAX_TEXT_PER_NOTE`-length note, so the cap only catches the pathological
 * case — it is a guard, not the normal operating point.
 */
const NER_TOKENS_PER_ENTITY = 45;
const NER_CHARS_PER_ENTITY = 120;
const NER_TOKENS_OVERHEAD = 64;
const NER_MIN_TOKENS = 600;
const NER_MAX_TOKENS = 2000;

export function nerTokenBudget(textLength: number): number {
  const expectedEntities = Math.ceil(Math.max(0, textLength) / NER_CHARS_PER_ENTITY);
  const budget = NER_TOKENS_OVERHEAD + expectedEntities * NER_TOKENS_PER_ENTITY;
  return Math.max(NER_MIN_TOKENS, Math.min(NER_MAX_TOKENS, budget));
}

/** Chars of surrounding text kept on each side of a mention. */
const SNIPPET_RADIUS = 60;

/**
 * Locate `displayName` in the note text and cut a short window around it.
 * Case-insensitive, first occurrence wins. Returns "" when the name doesn't
 * literally appear (the model cleaned it, or hallucinated it) — `context` is
 * a nullable display-only column, so an empty snippet is harmless.
 */
export function deriveSnippet(text: string, displayName: string): string {
  const needle = displayName.trim();
  if (needle.length === 0) return "";
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return "";
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Loose JSON-array extractor — tolerates LLM preamble / trailing text. */
function tryParseJsonArray(text: string): unknown[] | null {
  // Greedy match — captures the largest [...] block in the output.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Coerce an `unknown` candidate into an ExtractedEntity, or null on shape mismatch. */
function coerceExtracted(raw: unknown): ExtractedEntity | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const displayName = r.displayName;
  const type = r.type;
  const confidence = r.confidence;
  const contextSnippet = r.contextSnippet;

  if (typeof displayName !== "string" || displayName.trim().length === 0) return null;
  if (typeof type !== "string") return null;
  if (!VALID_TYPE_SET.has(type)) return null;
  if (!isEntityType(type)) return null;

  const conf =
    typeof confidence === "number" && Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 0.5;
  const snippet =
    typeof contextSnippet === "string" ? contextSnippet.slice(0, 200) : "";

  return {
    displayName: displayName.trim(),
    type: type as EntityType,
    confidence: conf,
    contextSnippet: snippet,
  };
}

export const entityExtractionPass: SleepPass = {
  name: "entity-extraction",
  phases: ["rem"],

  async run(_run: SleepRun): Promise<SleepPassResult> {
    let processed = 0;
    let errors = 0;
    let entitiesCreated = 0;
    /** Model hit the output ceiling — entities were provably lost (#53). */
    let truncated = 0;
    /** Model finished normally but produced no parseable JSON array. */
    let parseFailures = 0;
    /** `upsertEntity` threw for a single extracted entity. */
    let upsertFailures = 0;
    /** Note skipped: local-only note, no local `ner` provider available. */
    let providerSkips = 0;

    try {
      const routing = await getLlmRouting();
      const router = new LlmRouter(routing);

      // Pre-flight: any ner provider configured? If not, bail without
      // touching the candidate-selection cost (listNotes pulls + walks).
      try {
        const probe = router.getProviderChain("ner");
        if (probe.length === 0 || !probe[0].chat) {
          console.warn(
            "[sleep-agent] entity-extraction aborted: no ner provider configured (or the configured one has no chat capability)",
          );
          return { processed: 0, errors: 1, notes: "no ner provider configured" };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[sleep-agent] entity-extraction aborted: ner unavailable: ${message}`);
        return {
          processed: 0,
          errors: 1,
          notes: `ner unavailable: ${message}`,
        };
      }

      const allNotes = await listNotes();
      const since = Date.now() - RECENT_WINDOW_MS;

      // Sort by updatedAt desc — newest first, so a small NOTES_PER_RUN
      // cap still surfaces freshly-touched notes preferentially.
      const sorted = [...allNotes].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );

      const candidates: typeof sorted = [];
      for (const n of sorted) {
        // Story S4 — the `RAW/_…` Hände-weg-Zone is NEVER cross-linked
        // (entity extraction = Vernetzung). Skip it before any DB probe or
        // LLM call (AC#1 Bullet 3). Regular RAW notes remain readable here.
        if (isHandsOffZone(n.id)) continue;
        const updated = new Date(n.updatedAt).getTime();
        const isRecent = Number.isFinite(updated) && updated > since;

        // Cheap row-count probe — `entity_mentions.note_id` is indexed.
        const existing = await database()
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(entityMentions)
          .where(eq(entityMentions.noteId, n.id));
        const hasMentions = (existing[0]?.count ?? 0) > 0;

        if (!hasMentions || isRecent) {
          candidates.push(n);
        }
        if (candidates.length >= NOTES_PER_RUN) break;
      }

      if (candidates.length === 0) {
        return { processed: 0, errors: 0, notes: "no candidates" };
      }

      for (const candidate of candidates) {
        try {
          const note = await getNote(candidate.id);
          if (!note?.body) continue;

          const { data: frontmatter, body: bodyText } = parseFrontmatter(note.body);
          if (bodyText.trim().length === 0) continue;

          // Privacy-tier-aware provider chain — per-note, not global.
          const ctx = routeContextFromNote(candidate.id, frontmatter);
          let provider;
          try {
            const chain = router.getProviderChain("ner", ctx);
            provider = chain.find((p) => p.chat) ?? null;
          } catch (err) {
            if (err instanceof LlmUnavailable) {
              // local-only note with no local ner provider → skip cleanly.
              // Counted (and surfaced in `notes`) but not logged per note:
              // on a fully local-only vault this would spam one line per note.
              providerSkips++;
            } else {
              errors++;
              console.warn(
                `[sleep-agent] entity-extraction note "${candidate.id}" provider routing failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
            continue;
          }
          if (!provider?.chat) {
            errors++;
            console.warn(
              `[sleep-agent] entity-extraction note "${candidate.id}" skipped: ner chain has no chat-capable provider`,
            );
            continue;
          }

          const text = bodyText.slice(0, MAX_TEXT_PER_NOTE);
          const prompt = NER_PROMPT.replace("{{TEXT}}", text);
          const messages: ChatMessage[] = [{ role: "user", content: prompt }];

          const maxTokens = nerTokenBudget(text.length);
          const result = await provider.chat(messages, {
            maxTokens,
            temperature: 0.1,
          });

          const hitTokenCeiling = result.finishReason === "length";
          if (hitTokenCeiling) {
            // Provably lost entities: the model was still writing when the
            // budget ran out. Counted even if the salvageable prefix parses.
            truncated++;
            console.warn(
              `[sleep-agent] entity-extraction note "${candidate.id}" hit the token ceiling ` +
                `(finishReason=length, maxTokens=${maxTokens}, outputTokens=${result.usage.outputTokens}, ` +
                `textChars=${text.length}) — entities were cut off`,
            );
          }

          const rawArray = tryParseJsonArray(result.text);
          if (rawArray === null) {
            // No parseable JSON array. Two very different causes, kept
            // apart on purpose: a `length` abort is a budget problem, a
            // `stop` with garbage is a model/prompt problem.
            errors++;
            if (!hitTokenCeiling) {
              parseFailures++;
              console.warn(
                `[sleep-agent] entity-extraction note "${candidate.id}" produced no parseable JSON array ` +
                  `(finishReason=${result.finishReason}, ${result.text.length} chars)`,
              );
            }
            // Note remains unprocessed; the next run retries it.
            continue;
          }

          // Use the note's frontmatter `updated` for the observation timestamp
          // when available — keeps the entity-timeline consistent with the
          // vault truth (a re-imported old note shouldn't pretend to be new).
          const observedAt = (() => {
            const fmUpdated = frontmatter.updated;
            if (typeof fmUpdated === "string") {
              const d = new Date(fmUpdated);
              if (!Number.isNaN(d.getTime())) return d;
            }
            return new Date();
          })();

          for (const raw of rawArray) {
            const ex = coerceExtracted(raw);
            if (!ex) continue;
            // The snippet is ours now, not the model's — see NER_PROMPT.
            // A model that still emits one keeps it as fallback.
            const snippet = deriveSnippet(bodyText, ex.displayName);
            if (snippet.length > 0) ex.contextSnippet = snippet;
            try {
              await upsertEntity(ex, candidate.id, observedAt);
              entitiesCreated++;
            } catch (err) {
              errors++;
              upsertFailures++;
              console.warn(
                `[sleep-agent] entity-extraction upsert failed for "${ex.displayName}" (${ex.type}) ` +
                  `in note "${candidate.id}": ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          processed++;
        } catch (err) {
          errors++;
          console.warn(
            `[sleep-agent] entity-extraction note "${candidate.id}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Failure modes stay distinguishable in `sleep_agent_runs.passStats`
      // — the whole point of #53 was that `errors: 6` told nobody anything.
      const detail: string[] = [];
      if (truncated > 0) detail.push(`${truncated} truncated (token ceiling)`);
      if (parseFailures > 0) detail.push(`${parseFailures} unparseable`);
      if (upsertFailures > 0) detail.push(`${upsertFailures} upsert-failed`);
      if (providerSkips > 0) detail.push(`${providerSkips} skipped (no local ner)`);

      return {
        processed,
        errors,
        notes:
          `extracted from ${processed} notes, ${entitiesCreated} entity-mentions` +
          (detail.length > 0 ? `; ${detail.join(", ")}` : ""),
      };
    } catch (e) {
      console.error(`[sleep-agent] entity-extraction pass failed: ${String(e).slice(0, 500)}`);
      return {
        processed,
        errors: errors + 1,
        notes: `pass-error: ${String(e).slice(0, 200)}`,
      };
    }
  },
};
