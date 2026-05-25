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

const NER_PROMPT = `Extract named entities from the following text. For each entity, output:
- displayName (as it appears in text, but cleaned)
- type: one of [person, organization, location, concept, date, event]
- confidence: 0..1
- contextSnippet: ~100 chars around the mention

Output ONLY valid JSON array. No preamble. Schema:
[{"displayName": "...", "type": "...", "confidence": 0.x, "contextSnippet": "..."}]

Text:
{{TEXT}}`;

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

    try {
      const routing = await getLlmRouting();
      const router = new LlmRouter(routing);

      // Pre-flight: any ner provider configured? If not, bail without
      // touching the candidate-selection cost (listNotes pulls + walks).
      try {
        const probe = router.getProviderChain("ner");
        if (probe.length === 0 || !probe[0].chat) {
          return { processed: 0, errors: 1, notes: "no ner provider configured" };
        }
      } catch (err) {
        return {
          processed: 0,
          errors: 1,
          notes: `ner unavailable: ${err instanceof Error ? err.message : String(err)}`,
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
            if (!(err instanceof LlmUnavailable)) {
              errors++;
            }
            // local-only note with no local ner provider → skip cleanly.
            continue;
          }
          if (!provider?.chat) {
            errors++;
            continue;
          }

          const text = bodyText.slice(0, MAX_TEXT_PER_NOTE);
          const prompt = NER_PROMPT.replace("{{TEXT}}", text);
          const messages: ChatMessage[] = [{ role: "user", content: prompt }];

          const result = await provider.chat(messages, {
            maxTokens: 1000,
            temperature: 0.1,
          });

          const rawArray = tryParseJsonArray(result.text);
          if (rawArray === null) {
            // LLM produced no parseable JSON array — count it once and
            // move on. Note remains unprocessed; next run retries.
            errors++;
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
            try {
              await upsertEntity(ex, candidate.id, observedAt);
              entitiesCreated++;
            } catch {
              errors++;
            }
          }
          processed++;
        } catch {
          errors++;
        }
      }

      return {
        processed,
        errors,
        notes: `extracted from ${processed} notes, ${entitiesCreated} entity-mentions`,
      };
    } catch (e) {
      return {
        processed,
        errors: errors + 1,
        notes: `pass-error: ${String(e).slice(0, 200)}`,
      };
    }
  },
};
