/**
 * Phase C Wave C1 / Story 2 — Topic-Synthesis sleep pass.
 *
 * Weekly REM-phase pass (frequency choice deferred to the SleepAgent
 * scheduler — see `phases: ["rem"]` below). The pass walks the Wikilink
 * graph, runs label-propagation community detection (see
 * `graph/community.ts`), and asks the `topic-synthesis` LLM-role to write a
 * short markdown summary per cluster ≥ MIN_CLUSTER_SIZE members. The
 * summaries land in `70_pai/topics/auto-{slug}.md` as `type: intervention`
 * notes with `origin: agent, confidence: 0.6` so downstream UIs can
 * distinguish them from human-authored topic-notes.
 *
 * Cost control:
 *   - MIN_CLUSTER_SIZE filters out singleton communities (the long tail in
 *     personal vaults — most notes link 0–2 others).
 *   - MAX_CLUSTERS_PER_RUN caps LLM calls per pass.
 *   - We send each member's title + the first 500 chars of body, capped at
 *     15 members per cluster, keeping prompt size bounded.
 *
 * Failure semantics mirror the other passes: catastrophic graph/LLM errors
 * are swallowed into the result's `errors` counter and a diagnostic `notes`
 * string. Per-cluster failures don't abort the pass — they just bump
 * `errors` and move on to the next cluster.
 */
import { buildGraph } from "../../graph/graphService.js";
import { detectCommunities } from "../../graph/community.js";
import { getNote, createNote } from "../../notes/notesService.js";
import { LlmRouter } from "../../llm/router.js";
import { getLlmRouting } from "../../llm/configStore.js";
import type { SleepPass, SleepRun, SleepPassResult } from "../types.js";

const MIN_CLUSTER_SIZE = 3;
const MAX_CLUSTERS_PER_RUN = 10;
const MAX_MEMBERS_PER_PROMPT = 15;
const MAX_BODY_CHARS = 500;

const SYNTH_PROMPT = `You are creating a topic-summary note for a personal knowledge vault.
Given these N related notes, write a concise (200-400 word) Markdown summary that:
1. Names the topic in the title (H1)
2. Identifies the central concepts shared across the notes
3. Highlights any contradictions or open questions
4. Lists each source note with a Wikilink-reference: [[noteId]]

DO NOT invent facts. DO NOT add speculation. Stay grounded in the provided notes.`;

export const topicSynthesisPass: SleepPass = {
  name: "topic-synthesis",
  phases: ["rem"],

  async run(_run: SleepRun): Promise<SleepPassResult> {
    let processed = 0;
    let errors = 0;

    try {
      // 1. Build the wikilink graph + detect communities.
      const graph = await buildGraph();
      if (graph.nodes.length < MIN_CLUSTER_SIZE) {
        return { processed: 0, errors: 0, notes: "vault too small" };
      }
      const result = detectCommunities(graph);

      // 2. Filter to communities of at least MIN_CLUSTER_SIZE, then take the
      //    top MAX_CLUSTERS_PER_RUN by size. Largest first = highest signal.
      const eligibleCommunities = [...result.communities.entries()]
        .filter(([, members]) => members.length >= MIN_CLUSTER_SIZE)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, MAX_CLUSTERS_PER_RUN);

      if (eligibleCommunities.length === 0) {
        return {
          processed: 0,
          errors: 0,
          notes: `no eligible clusters (modularity=${result.modularity.toFixed(3)})`,
        };
      }

      // 3. Resolve the LLM provider for `topic-synthesis`. Mirrors the
      //    pattern in `pipeline/search.ts` so role-routing stays consistent.
      const routing = await getLlmRouting();
      const router = new LlmRouter(routing);
      const provider = router.getProvider("topic-synthesis");
      if (!provider.chat) {
        return {
          processed: 0,
          errors: 1,
          notes: "no topic-synthesis chat provider",
        };
      }

      const generatedAt = new Date().toISOString();

      for (const [communityId, members] of eligibleCommunities) {
        try {
          // Fetch each member's title + body preview. Failures (file gone
          // between buildGraph and getNote) drop silently — the cluster
          // still goes to the LLM with whatever remains.
          const memberContent = await Promise.all(
            members.slice(0, MAX_MEMBERS_PER_PROMPT).map(async (nid) => {
              const n = await getNote(nid).catch(() => null);
              if (!n) return null;
              return `[${nid}] ${n.title}\n${(n.body ?? "").slice(0, MAX_BODY_CHARS)}`;
            }),
          );
          const contentBlock = memberContent.filter((s): s is string => Boolean(s))
            .join("\n\n---\n\n");

          if (!contentBlock) {
            errors++;
            continue;
          }

          const messages = [
            { role: "system" as const, content: SYNTH_PROMPT },
            {
              role: "user" as const,
              content: `Notes (cluster of ${members.length}):\n\n${contentBlock}\n\nWrite the topic-summary now.`,
            },
          ];

          const synth = await provider.chat(messages, {
            maxTokens: 800,
            temperature: 0.3,
          });

          // First H1 in the LLM output becomes the note title; fallback to a
          // truncated community-id so two runs against the same vault still
          // produce deterministic filenames if the LLM omits the H1.
          const titleMatch = synth.text.match(/^#\s+(.+)$/m);
          const title = titleMatch?.[1].trim() ?? `Topic Cluster ${communityId.slice(0, 8)}`;
          const slug = slugify(title);
          const path = `70_pai/topics/auto-${slug}.md`;

          await createNote(path, synth.text, {
            type: "intervention",
            title,
            extra: {
              intervention_kind: "topic_note",
              status: "pending",
              origin: "agent",
              confidence: 0.6,
              source_notes: members,
              community_id: communityId,
              generated_at: generatedAt,
            },
          });

          processed++;
        } catch (err) {
          errors++;
          console.warn(
            `[sleep-agent] topic-synthesis cluster "${communityId}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return {
        processed,
        errors,
        notes: `synthesized ${processed} topic notes from ${eligibleCommunities.length} clusters (modularity=${result.modularity.toFixed(3)})`,
      };
    } catch (err) {
      return {
        processed,
        errors: errors + 1,
        notes: `pass-error: ${String(err).slice(0, 200)}`,
      };
    }
  },
};

/**
 * Filesystem-safe slug from an arbitrary string.
 *
 * - German umlauts → ASCII digraphs (ä → ae, ö → oe, ü → ue, ß → ss) so
 *   "Lernen über KI" → "lernen-ueber-ki", not "lernen--ber-ki".
 * - Everything non-alphanumeric collapses to a single hyphen.
 * - Trim leading/trailing hyphens, cap at 60 chars to keep paths short.
 */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" }[c] ?? c))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
