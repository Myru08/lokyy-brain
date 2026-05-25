import { ulid } from "ulid";
import { eq } from "drizzle-orm";

import { database } from "../../db/index.js";
import {
  mem0ReviewQueue,
  isMem0Operation,
} from "../../db/schema/mem0ReviewQueue.js";
import { listNotes, getNote } from "../../notes/notesService.js";
import { parseFrontmatter } from "../../frontmatter/index.js";
import { Tier2Provider } from "../../memory/Tier2Provider.js";
import { LlmRouter, routeContextFromNote } from "../../llm/router.js";
import { getLlmRouting } from "../../llm/configStore.js";
import { LlmUnavailable } from "../../llm/errors.js";
import type { ChatMessage, ToolDef } from "../../llm/types.js";
import type { SleepPass, SleepPassResult } from "../types.js";

/**
 * Phase C Wave C1 / Story 1 — Mem0 ADD/UPDATE/DELETE/NOOP classifier.
 *
 * REM-sleep pass that walks recent capture notes, runs a kNN-10 lookup
 * against Tier-2 semantic memory, and asks the configured `mem0-classifier`
 * provider to decide one of four operations per candidate. The decision is
 * NEVER auto-applied — it is queued in `mem0_review_queue` with
 * `status = 'pending'` and waits for explicit human acceptance (see
 * `server/src/routes/mem0-review.ts`).
 *
 * Bounds & guards:
 *   - Capture-detection: prefers folder-prefix `30_captures/` (vault SPEC
 *     convention, CLAUDE.md) and confirms via frontmatter `type === "capture"`
 *     so non-capture notes parked in that folder are skipped.
 *   - Recency: only notes touched in the last 24h are considered (cron is
 *     idempotent — already-classified notes are skipped via a row-lookup).
 *   - Hard cap: 50 candidates per run to bound LLM cost.
 *   - Privacy: each candidate routes through `routeContextFromNote`, so a
 *     `privacy: local-only` note never touches a cloud provider — the
 *     router-chain throws `LlmUnavailable` and we record an error instead.
 *
 * Edge cases:
 *   - Empty body → skip (no signal to classify).
 *   - Tier-2 returns zero hits (cold-start vault) → still classify; the
 *     LLM will default to ADD with a higher confidence.
 *   - kNN hit whose noteId no longer resolves → drop that neighbor only.
 *   - Tool-call missing / wrong shape → count as error, do NOT insert a
 *     row (better to re-classify next run than store garbage).
 */

const CLASSIFY_TOOL: ToolDef = {
  name: "classify_memory",
  description:
    "Decide what to do with this candidate memory given the existing related memories.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["ADD", "UPDATE", "DELETE", "NOOP"],
        description: "The operation to perform.",
      },
      targetNoteId: {
        type: "string",
        description:
          "For UPDATE or DELETE, the note id to act on. Omit otherwise.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Classifier confidence, 0..1.",
      },
      reasoning: {
        type: "string",
        description: "One-sentence rationale for the decision.",
      },
      proposedBody: {
        type: "string",
        description:
          "For UPDATE, the proposed new body. For ADD, the refined body. Omit otherwise.",
      },
    },
    required: ["operation", "confidence", "reasoning"],
  },
};

const SYSTEM_PROMPT = `You are a memory consolidation agent. For a new candidate memory (a freshly captured note), decide the right operation against the existing related memories:

- ADD: candidate is genuinely new — no significant overlap.
- UPDATE: candidate refines or extends an existing memory — propose updated body.
- DELETE: candidate makes an existing memory obsolete or outright contradicts it — propose deletion.
- NOOP: candidate is redundant noise — skip.

Be conservative. Default to ADD if uncertain. Only UPDATE if overlap is clear and merge is unambiguous. Only DELETE if contradiction is unambiguous (rare). Always provide reasoning.`;

const CAPTURES_FOLDER_PREFIX = "30_captures/";
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_CAP = 50;
const KNN_TOP_K = 10;
const NEIGHBOR_BODY_PREVIEW_CHARS = 400;
const CANDIDATE_BODY_PREVIEW_CHARS = 2000;
const DEFAULT_VAULT_ID = process.env.LOKYY_DEFAULT_VAULT ?? "default";

interface ClassifyToolInput {
  operation: string;
  targetNoteId?: string;
  confidence: number;
  reasoning: string;
  proposedBody?: string;
}

/** Narrow `unknown` (drizzle JSON output) to the classifier tool input. */
function parseClassifyInput(raw: Record<string, unknown>): ClassifyToolInput | null {
  const operation = raw.operation;
  const confidence = raw.confidence;
  const reasoning = raw.reasoning;
  if (typeof operation !== "string" || !isMem0Operation(operation)) return null;
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return null;
  if (typeof reasoning !== "string" || reasoning.length === 0) return null;
  const targetNoteId =
    typeof raw.targetNoteId === "string" && raw.targetNoteId.length > 0
      ? raw.targetNoteId
      : undefined;
  const proposedBody =
    typeof raw.proposedBody === "string" && raw.proposedBody.length > 0
      ? raw.proposedBody
      : undefined;
  return {
    operation,
    confidence: Math.max(0, Math.min(1, confidence)),
    reasoning,
    targetNoteId,
    proposedBody,
  };
}

export const mem0ClassifierPass: SleepPass = {
  name: "mem0-classifier",
  phases: ["rem"],

  async run(): Promise<SleepPassResult> {
    let processed = 0;
    let errors = 0;

    try {
      const routing = await getLlmRouting();
      const router = new LlmRouter(routing);

      // Quick precheck: is *any* mem0-classifier provider configured at all?
      // (privacy-tier may still strip cloud providers per-candidate below.)
      try {
        const probe = router.getProviderChain("mem0-classifier");
        if (probe.length === 0 || !probe[0].chat) {
          return { processed: 0, errors: 1, notes: "no mem0-classifier provider configured" };
        }
      } catch (err) {
        return {
          processed: 0,
          errors: 1,
          notes: `mem0-classifier unavailable: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const allNotes = await listNotes();
      const since = Date.now() - RECENT_WINDOW_MS;
      // Cheap pre-filter on the summary (no body parse): folder + recency.
      // Final type-check happens after the body fetch below.
      const rawCandidates = allNotes
        .filter((n) => n.id.startsWith(CAPTURES_FOLDER_PREFIX))
        .filter((n) => {
          const parsed = new Date(n.updatedAt);
          return !Number.isNaN(parsed.getTime()) && parsed.getTime() > since;
        });

      if (rawCandidates.length === 0) {
        return { processed: 0, errors: 0, notes: "no fresh captures" };
      }

      const tier2 = new Tier2Provider({ vaultId: DEFAULT_VAULT_ID });
      const db = database();

      // Sort newest-first then cap; classifying the most recent captures
      // first keeps the user-visible queue feel responsive.
      const sorted = rawCandidates.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );

      for (const candidate of sorted) {
        if (processed + errors >= CANDIDATE_CAP) break;

        try {
          // Skip if we already produced a decision for this capture.
          const existing = await db
            .select({ id: mem0ReviewQueue.id })
            .from(mem0ReviewQueue)
            .where(eq(mem0ReviewQueue.noteId, candidate.id))
            .limit(1);
          if (existing.length > 0) continue;

          const note = await getNote(candidate.id);
          if (!note || !note.body || note.body.trim().length === 0) continue;

          const { data: frontmatter, body: bodyText } = parseFrontmatter(
            note.body,
          );

          // Final type-check — only true `type: capture` notes get processed.
          // Notes parked in 30_captures/ for organizational reasons (e.g.
          // type: note) are skipped.
          if (frontmatter.type !== "capture") continue;

          // Privacy-tier-aware provider chain (per-note, NOT global).
          const ctx = routeContextFromNote(candidate.id, frontmatter);
          let chatProvider;
          try {
            const chain = router.getProviderChain("mem0-classifier", ctx);
            chatProvider = chain.find((p) => p.chat) ?? null;
          } catch (err) {
            // LlmUnavailable → privacy-tier stripped all providers. Not an
            // error condition we want to spam logs about; just skip.
            if (err instanceof LlmUnavailable) continue;
            throw err;
          }
          if (!chatProvider || !chatProvider.chat) {
            errors++;
            continue;
          }

          // kNN-10 against existing notes via Tier-2 semantic search.
          // search() returns [] gracefully if Ollama is down, so we never
          // throw out of here on embedding failure.
          const neighborsRaw = await tier2.search(bodyText, { limit: KNN_TOP_K });
          // Drop the candidate itself if it happens to be in the index
          // already (rare but possible if a previous run indexed but didn't
          // classify).
          const neighbors = neighborsRaw.filter((h) => h.noteId !== candidate.id);

          const neighborSummaries: string[] = [];
          for (const hit of neighbors.slice(0, KNN_TOP_K)) {
            const nn = await getNote(hit.noteId).catch(() => null);
            if (!nn) continue; // stale index row, skip silently
            const preview = nn.body.slice(0, NEIGHBOR_BODY_PREVIEW_CHARS);
            neighborSummaries.push(
              `[${hit.noteId}] ${nn.title}\nscore=${hit.score.toFixed(3)}\n${preview}`,
            );
          }

          const neighborsBlock =
            neighborSummaries.length > 0
              ? neighborSummaries.join("\n\n---\n\n")
              : "(none — vault has no semantically related memories yet)";

          const userMessage = `## Candidate Memory
[${candidate.id}] ${candidate.title}

${bodyText.slice(0, CANDIDATE_BODY_PREVIEW_CHARS)}

## Existing Related Memories (kNN, top-${KNN_TOP_K})
${neighborsBlock}

Decide the operation.`;

          const messages: ChatMessage[] = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ];

          const result = await chatProvider.chat(messages, {
            tools: [CLASSIFY_TOOL],
            maxTokens: 600,
            temperature: 0.1,
          });

          const toolCall = result.toolCalls?.find(
            (c) => c.name === CLASSIFY_TOOL.name,
          ) ?? result.toolCalls?.[0];
          if (!toolCall) {
            errors++;
            continue;
          }

          const parsed = parseClassifyInput(toolCall.input);
          if (!parsed) {
            errors++;
            continue;
          }

          // UPDATE / DELETE without a target is invalid — skip rather than
          // store an unresolvable row.
          if (
            (parsed.operation === "UPDATE" || parsed.operation === "DELETE") &&
            !parsed.targetNoteId
          ) {
            errors++;
            continue;
          }

          await db.insert(mem0ReviewQueue).values({
            id: ulid(),
            noteId: candidate.id,
            operation: parsed.operation,
            targetNoteId: parsed.targetNoteId ?? null,
            confidence: parsed.confidence.toFixed(4),
            reasoning: parsed.reasoning,
            payload: parsed.proposedBody
              ? { proposedBody: parsed.proposedBody }
              : null,
            status: "pending",
          });

          processed++;
        } catch (err) {
          errors++;
          console.warn(
            `[mem0-classifier] candidate ${candidate.id} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return {
        processed,
        errors,
        notes: `queued ${processed} review-entries (${errors} errors)`,
      };
    } catch (err) {
      return {
        processed,
        errors: errors + 1,
        notes: `pass-level-error: ${
          err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
        }`,
      };
    }
  },
};
