import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";

import { database } from "../../db/index.js";
import { lintFindings } from "../../db/schema/lintFindings.js";
import { buildGraph, parseLinks } from "../../graph/graphService.js";
import { listNotes, getNote } from "../../notes/notesService.js";
import { getScoring } from "../../scoring/store.js";
import { getMemoryProvider } from "../../memory/index.js";
import { parseFrontmatter, validateFrontmatter } from "../../frontmatter/index.js";
import { DOC_TYPES } from "../../frontmatter/types.js";
import { isHandsOffZone } from "../rawGuard.js";
import { createPassErrorLog } from "../errorSamples.js";
import type { DocType } from "../../frontmatter/index.js";
import { LlmRouter } from "../../llm/router.js";
import { getLlmRouting } from "../../llm/configStore.js";
import { LlmUnavailable } from "../../llm/errors.js";
import type { LlmProvider, ChatMessage } from "../../llm/types.js";
import type { SleepPass, SleepPassResult } from "../types.js";

/**
 * Phase C Wave C1 / Story 3 — Karpathy-Lint sleep-pass.
 *
 * Five heuristics run sequentially inside the `lint` sleep-phase. The
 * first four are pure code (zero LLM, zero embed-on-demand); only the
 * contradiction check requires the `lint`-role provider and can be skipped
 * entirely when none is configured — the other four MUST still run.
 *
 * Heuristics:
 *   1. Orphan          — no incoming wikilinks, no tags, untouched 30+ days
 *   2. Missing-Link    — `[[X]]` mentioned in MIN_CROSS_REF_COUNT+ notes
 *                        but no note matches X by id / title
 *   3. Schema-Drift    — frontmatter fails its type's JSON-schema (catches
 *                        notes pre-dating schema evolution)
 *   4. Duplicate       — Tier 2 `relatedNotes` neighbours with cosine
 *                        similarity above DUP_THRESHOLD
 *   5. Contradiction   — LLM judges two notes (overlapping tags) as
 *                        inconsistent. Capped at MAX_CONTRADICTIONS_PER_RUN
 *                        to bound LLM cost.
 *
 * Dedupe strategy: before writing a finding the pass queries lint_findings
 * for an existing `status='open'` row of the same kind covering the same
 * noteId set. This keeps daily runs idempotent — a still-unfixed orphan
 * doesn't fan out into 30 rows over a month.
 */

const DEFAULT_VAULT_ID = process.env.LOKYY_DEFAULT_VAULT ?? "default";

const ORPHAN_AGE_DAYS = 30;
const MIN_CROSS_REF_COUNT = 5;
const DUP_THRESHOLD = 0.92;
const MAX_CONTRADICTIONS_PER_RUN = 20;
/**
 * Performance cap for the duplicate check — on a 1000-note vault the
 * `relatedNotes` query already does 1 Ollama embed-lookup per source note,
 * which dominates wall-clock. 200 notes/run keeps a daily lint under ~3
 * minutes on a CPU-only Ollama setup; later runs cover the next 200 (the
 * `checkedPairs` dedupe via DB makes the rotation cheap).
 */
const MAX_DUP_CHECK_NOTES = 200;

const DOC_TYPE_SET = new Set<string>(DOC_TYPES);

export const lintPass: SleepPass = {
  name: "karpathy-lint",
  phases: ["lint"],

  async run(): Promise<SleepPassResult> {
    let processed = 0;
    let findingsCreated = 0;
    /**
     * #58 — this pass had SEVEN bare `errors++` and not a single log line: a
     * lint run reporting `errors: 7` told an operator nothing about which of
     * the five heuristics broke. Every sample's reason therefore leads with
     * the heuristic name (`orphan-check`, `missing-link-check`, …), because
     * "which check" is the first question and the note id is the second.
     */
    const errors = createPassErrorLog();

    try {
      const graph = await buildGraph();
      // Story S4 — the `RAW/_…` Hände-weg-Zone is NEVER linted/geprüft
      // (AC#1 Bullet 3). Filter it out of the note set every heuristic walks,
      // so no finding is ever emitted ABOUT a hands-off note. Regular RAW notes
      // stay in scope — RAW is allowed to be read/checked, only the `_`-zone
      // is off-limits. Profile-independent pure-path filter (no-op under para).
      const allNotes = (await listNotes()).filter((n) => !isHandsOffZone(n.id));

      // ─── Check 1: Orphan Detection ─────────────────────────────────────
      const incomingLinks = new Map<string, number>();
      for (const e of graph.edges) {
        incomingLinks.set(e.target, (incomingLinks.get(e.target) ?? 0) + 1);
      }

      for (const note of allNotes) {
        try {
          if ((incomingLinks.get(note.id) ?? 0) > 0) continue;
          if ((note.tags?.length ?? 0) > 0) continue;
          const scoring = await getScoring(note.id);
          const lastAccess =
            scoring?.lastAccessed?.getTime() ??
            new Date(note.updatedAt).getTime();
          const ageDays = (Date.now() - lastAccess) / 86_400_000;
          if (ageDays < ORPHAN_AGE_DAYS) continue;

          if (await alreadyOpen("orphan", [note.id])) continue;

          await insertFinding({
            kind: "orphan",
            noteIds: [note.id],
            severity: "info",
            message: `Note "${note.title}" hat keine eingehenden Links, keine Tags, und wurde seit ${Math.round(ageDays)} Tagen nicht touched.`,
            evidence: { lastAccessDays: Math.round(ageDays) },
          });
          findingsCreated++;
        } catch (err) {
          errors.record(note.id, `orphan-check: ${reasonOf(err)}`);
        }
      }

      // ─── Check 2: Missing Cross-References ────────────────────────────
      const linkTargets = new Map<string, Set<string>>();
      const noteIdSet = new Set(allNotes.map((n) => n.id));
      const noteTitleSet = new Set(allNotes.map((n) => n.title.toLowerCase()));

      for (const note of allNotes) {
        try {
          const fullNote = await getNote(note.id);
          if (!fullNote?.body) continue;
          const { body: bodyOnly } = parseFrontmatter(fullNote.body);
          const links = parseLinks(bodyOnly);
          for (const link of links) {
            if (noteIdSet.has(link)) continue;
            if (noteTitleSet.has(link.toLowerCase())) continue;
            const set = linkTargets.get(link) ?? new Set<string>();
            set.add(note.id);
            linkTargets.set(link, set);
          }
        } catch (err) {
          errors.record(note.id, `missing-link-check (read): ${reasonOf(err)}`);
        }
      }

      for (const [target, sources] of linkTargets) {
        if (sources.size < MIN_CROSS_REF_COUNT) continue;
        const sortedSources = [...sources].sort();
        if (await alreadyOpen("missing_link", sortedSources)) continue;
        try {
          await insertFinding({
            kind: "missing_link",
            noteIds: sortedSources,
            severity: "warning",
            message: `[[${target}]] wird in ${sources.size} Notes referenziert, aber die Note existiert nicht.`,
            evidence: {
              missingTarget: target,
              referenceCount: sources.size,
            },
          });
          findingsCreated++;
        } catch (err) {
          // Keyed on the first referencing note — the finding spans several.
          errors.record(
            sortedSources[0] ?? "",
            `missing-link-check (write) for [[${target}]] in ${sortedSources.length} notes: ${reasonOf(err)}`,
          );
        }
      }

      // ─── Check 3: Schema-Drift ────────────────────────────────────────
      for (const note of allNotes) {
        try {
          const fullNote = await getNote(note.id);
          if (!fullNote?.body) continue;
          const { data } = parseFrontmatter(fullNote.body);
          if (Object.keys(data).length === 0) continue;
          const rawType = typeof data.type === "string" ? data.type : null;
          const type: DocType =
            rawType && DOC_TYPE_SET.has(rawType)
              ? (rawType as DocType)
              : "note";
          const result = validateFrontmatter(data, type);
          if (result.valid) continue;
          if (await alreadyOpen("schema_drift", [note.id])) continue;
          await insertFinding({
            kind: "schema_drift",
            noteIds: [note.id],
            severity: "warning",
            message: `Note hat invalide Frontmatter: ${result.errors[0]?.message ?? "unknown"}`,
            evidence: { errors: result.errors.slice(0, 5) },
          });
          findingsCreated++;
        } catch (err) {
          errors.record(note.id, `schema-drift-check: ${reasonOf(err)}`);
        }
      }

      // ─── Check 4: Duplicate-Detection (cosine sim > DUP_THRESHOLD) ────
      const memory = getMemoryProvider(DEFAULT_VAULT_ID);
      const checkedPairs = new Set<string>();
      for (const note of allNotes.slice(0, MAX_DUP_CHECK_NOTES)) {
        try {
          const neighbors = await memory.relatedNotes(note.id, { limit: 5 });
          for (const n of neighbors) {
            if (n.noteId === note.id) continue;
            // Only consider semantic (Tier-2) hits — Tier-1 fallback is a
            // structural score on a different scale.
            if (n.tier !== "t2") continue;
            const pair = [note.id, n.noteId].sort().join("|");
            if (checkedPairs.has(pair)) continue;
            checkedPairs.add(pair);
            if (n.score < DUP_THRESHOLD) continue;

            const pairNoteIds = [note.id, n.noteId].sort();
            if (await alreadyOpen("duplicate", pairNoteIds)) continue;
            await insertFinding({
              kind: "duplicate",
              noteIds: pairNoteIds,
              severity: "info",
              message: `Notes haben ${(n.score * 100).toFixed(1)}% Ähnlichkeit — möglicher Merge-Kandidat.`,
              evidence: { similarity: n.score },
            });
            findingsCreated++;
          }
          processed++;
        } catch (err) {
          // Tier-2 is the usual suspect here (Ollama down → relatedNotes
          // throws) — the reason distinguishes that from a write failure.
          errors.record(note.id, `duplicate-check: ${reasonOf(err)}`);
        }
      }

      // ─── Check 5: Contradiction-Detection (LLM, opt-in) ───────────────
      // Heuristic for candidate-pair selection: pairs of notes that share
      // 2+ inline-tags. This is a cheap, structural proxy for "overlapping
      // entity-set" until a real NER pass exists — tags are user-curated
      // entities by convention (people, projects, topics). The pair count
      // is capped at MAX_CONTRADICTIONS_PER_RUN before any LLM call.
      let lintProvider: LlmProvider | null = null;
      try {
        const routing = await getLlmRouting();
        const router = new LlmRouter(routing);
        lintProvider = router.getProvider("lint");
      } catch (err) {
        if (!(err instanceof LlmUnavailable)) {
          // Unexpected error — count it but don't abort the pass. Pass-wide:
          // no note caused it, the lint role simply couldn't be resolved.
          errors.recordPassScoped(
            `contradiction-check: lint provider unresolvable: ${reasonOf(err)}`,
          );
        }
        // LlmUnavailable for role=lint is expected — the four pure-code
        // checks above already ran. Skip the contradiction phase silently.
        lintProvider = null;
      }

      if (lintProvider?.chat) {
        const chat = lintProvider.chat.bind(lintProvider);
        const tagToNotes = new Map<string, string[]>();
        for (const n of allNotes) {
          for (const t of n.tags ?? []) {
            const arr = tagToNotes.get(t) ?? [];
            arr.push(n.id);
            tagToNotes.set(t, arr);
          }
        }
        // Build pair → shared-tag-count so we can require 2+ shared tags.
        const pairSharedTags = new Map<string, number>();
        for (const noteIds of tagToNotes.values()) {
          if (noteIds.length < 2) continue;
          const uniq = [...new Set(noteIds)];
          for (let i = 0; i < uniq.length; i++) {
            for (let j = i + 1; j < uniq.length; j++) {
              const key = [uniq[i], uniq[j]].sort().join("|");
              pairSharedTags.set(key, (pairSharedTags.get(key) ?? 0) + 1);
            }
          }
        }
        const candidatePairs = [...pairSharedTags.entries()]
          .filter(([, count]) => count >= 2)
          .map(([key]) => key)
          .slice(0, MAX_CONTRADICTIONS_PER_RUN);

        for (const pairStr of candidatePairs) {
          try {
            const [a, b] = pairStr.split("|");
            if (!a || !b) continue;
            const pairNoteIds = [a, b].sort();
            if (await alreadyOpen("contradiction", pairNoteIds)) continue;

            const na = await getNote(a);
            const nb = await getNote(b);
            if (!na?.body || !nb?.body) continue;

            const { body: bodyA } = parseFrontmatter(na.body);
            const { body: bodyB } = parseFrontmatter(nb.body);

            const messages: ChatMessage[] = [
              {
                role: "user",
                content: `Sind diese zwei Notes inhaltlich widersprüchlich? Antworte mit JSON: {"contradicts": <true|false>, "reasoning": "<one sentence>"}.\n\nNote A:\n${na.title}\n${bodyA.slice(0, 1500)}\n\nNote B:\n${nb.title}\n${bodyB.slice(0, 1500)}`,
              },
            ];
            const result = await chat(messages, {
              maxTokens: 100,
              temperature: 0.1,
            });
            const m = result.text.match(/\{[\s\S]*\}/);
            if (!m) continue;
            const parsed = JSON.parse(m[0]) as {
              contradicts: boolean;
              reasoning: string;
            };
            if (parsed.contradicts) {
              await insertFinding({
                kind: "contradiction",
                noteIds: pairNoteIds,
                severity: "warning",
                message: `Notes scheinen widersprüchlich: ${parsed.reasoning}`,
                evidence: { reasoning: parsed.reasoning },
              });
              findingsCreated++;
            }
          } catch (err) {
            const [a] = pairStr.split("|");
            errors.record(
              a ?? "",
              `contradiction-check on pair ${pairStr}: ${reasonOf(err)}`,
            );
          }
        }
      }

      return errors.result(
        processed,
        `${findingsCreated} findings (orphans + missing-links + schema + dupes + contradictions)`,
      );
    } catch (e) {
      errors.recordPassScoped(e);
      return errors.result(processed, `pass-error: ${String(e).slice(0, 200)}`);
    }
  },
};

/** Short reason text for an arbitrary throw value — see #58. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Has the lint pass already emitted a still-open finding for this exact
 * (kind, noteIds) pair? Uses a small-K filter over open rows of that kind
 * and compares arrays in TS so we don't depend on Postgres array-equality
 * semantics (which differ across operators). Cheap: open-per-kind is
 * typically small (review-queue-driven).
 */
async function alreadyOpen(kind: string, noteIds: string[]): Promise<boolean> {
  const sorted = [...noteIds].sort();
  const rows = await database()
    .select({ noteIds: lintFindings.noteIds })
    .from(lintFindings)
    .where(
      and(eq(lintFindings.kind, kind), eq(lintFindings.status, "open")),
    );
  for (const row of rows) {
    const existing = [...row.noteIds].sort();
    if (existing.length !== sorted.length) continue;
    let same = true;
    for (let i = 0; i < sorted.length; i++) {
      if (existing[i] !== sorted[i]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

async function insertFinding(input: {
  kind: string;
  noteIds: string[];
  severity: string;
  message: string;
  evidence?: unknown;
}): Promise<void> {
  await database().insert(lintFindings).values({
    id: ulid(),
    kind: input.kind,
    noteIds: input.noteIds,
    severity: input.severity,
    message: input.message,
    evidence:
      input.evidence === undefined
        ? null
        : (input.evidence as Record<string, unknown>),
    status: "open",
  });
}
