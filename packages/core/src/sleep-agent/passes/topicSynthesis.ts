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
import { getNote, createNote, listNotes } from "../../notes/notesService.js";
import { parseFrontmatter } from "../../frontmatter/index.js";
import { isHandsOffZone } from "../rawGuard.js";
import { LlmRouter } from "../../llm/router.js";
import { getLlmRouting } from "../../llm/configStore.js";
import { createPassErrorLog } from "../errorSamples.js";
import type { SleepPass, SleepRun, SleepPassResult } from "../types.js";

const MIN_CLUSTER_SIZE = 3;
const MAX_CLUSTERS_PER_RUN = 10;
const MAX_MEMBERS_PER_PROMPT = 15;
const MAX_BODY_CHARS = 500;

/**
 * Where `/api/agent-review/topic-note/:id/accept` files an accepted summary
 * (mirrors `TOPIC_ACCEPT_TARGET_DIR` in `server/src/routes/agent-review.ts`).
 *
 * The pass has to know this folder for two reasons, both discovered in
 * production on a vault that had run the pass for two nights in a row:
 *
 *   1. **Re-generation.** A cluster does not stop being a cluster because the
 *      user accepted its summary — the next run wrote `auto-{slug}.md` again,
 *      and accepting THAT collided with the already-accepted file (`git mv`
 *      refuses to overwrite), stranding the note in a state neither accept nor
 *      reject would touch.
 *   2. **Self-echo.** The accepted note carries wikilinks to every source, so
 *      it joins the very community it summarizes. The following run fed the
 *      summary back into the prompt and summarized the summary — each night a
 *      little further from the notes it is supposed to describe, and the
 *      output even wikilinked itself.
 *
 * Both are fixed by knowing which topics have already been curated.
 */
const ACCEPTED_TOPIC_DIR = "20_notes/topics";

/** Frontmatter marker every note this pass writes carries. */
const TOPIC_NOTE_KIND = "topic_note";

interface AcceptedTopicIndex {
  /** `community_id` values that already produced a curated topic note. */
  communityIds: Set<string>;
  /** Slugs (filename stems) present in {@link ACCEPTED_TOPIC_DIR}. */
  slugs: Set<string>;
}

/**
 * Index the already-accepted topic notes. Cheap: the folder holds one note per
 * curated topic, and only those get their body read.
 *
 * A read failure degrades to an empty index rather than aborting the pass —
 * losing the skip means a redundant summary, losing the pass means no
 * summaries at all.
 */
async function loadAcceptedTopicIndex(): Promise<AcceptedTopicIndex> {
  const communityIds = new Set<string>();
  const slugs = new Set<string>();
  try {
    const all = await listNotes();
    const accepted = all.filter((n) => n.id.startsWith(`${ACCEPTED_TOPIC_DIR}/`));
    for (const summary of accepted) {
      slugs.add(summary.id.slice(ACCEPTED_TOPIC_DIR.length + 1));
      const note = await getNote(summary.id).catch(() => null);
      if (!note) continue;
      const communityId = parseFrontmatter(note.body).data.community_id;
      if (typeof communityId === "string" && communityId.length > 0) {
        communityIds.add(communityId);
      }
    }
  } catch {
    // fall through with whatever was collected
  }
  return { communityIds, slugs };
}

/**
 * True for notes this pass produced — the pending `auto-*` ones and the
 * accepted copies alike. They are excluded from synthesis input so a summary
 * never becomes the source of the next summary.
 */
function isOwnTopicNote(body: string): boolean {
  const { data } = parseFrontmatter(body);
  return data.intervention_kind === TOPIC_NOTE_KIND;
}

const SYNTH_PROMPT = `You are creating a topic-summary note for a personal knowledge vault.
Given these N related notes, write a concise (200-400 word) Markdown summary that:
1. Names the topic in the title (H1)
2. Identifies the central concepts shared across the notes
3. Highlights any contradictions or open questions
4. Lists each source note with a Wikilink-reference. Each note below starts
   with its identifier in square brackets — use EXACTLY that string:
   a note shown as "[20_notes/my-note] My Note" is linked as [[20_notes/my-note]].
   Never invent an identifier and never use one taken from the note text.
5. Is written in the SAME LANGUAGE as the source notes (German notes produce a German summary). Never translate.

DO NOT invent facts. DO NOT add speculation. Stay grounded in the provided notes.`;

export const topicSynthesisPass: SleepPass = {
  name: "topic-synthesis",
  phases: ["rem"],

  async run(_run: SleepRun): Promise<SleepPassResult> {
    let processed = 0;
    // Clusters whose summary the user already curated. Neither an error nor
    // work done — a third counter, surfaced in `notes` only.
    let skipped = 0;
    // #58 — the unit of work is a CLUSTER, not a note. Samples are keyed on
    // the cluster's first member (the note an operator can actually open) and
    // name the community id in the reason.
    const errors = createPassErrorLog();

    try {
      // 1. Build the wikilink graph + detect communities.
      const graph = await buildGraph();
      if (graph.nodes.length < MIN_CLUSTER_SIZE) {
        return errors.result(0, "vault too small");
      }
      const result = detectCommunities(graph);

      // 2. Filter to communities of at least MIN_CLUSTER_SIZE, then take the
      //    top MAX_CLUSTERS_PER_RUN by size. Largest first = highest signal.
      //    Communities the user already curated drop out BEFORE the slice, so
      //    they don't push fresh clusters out of the per-run budget, and
      //    before the LLM call, so a skip costs nothing.
      const acceptedTopics = await loadAcceptedTopicIndex();
      const allEligible = [...result.communities.entries()]
        .filter(([, members]) => members.length >= MIN_CLUSTER_SIZE)
        .sort((a, b) => b[1].length - a[1].length);
      const eligibleCommunities = allEligible
        .filter(([communityId]) => {
          if (!acceptedTopics.communityIds.has(communityId)) return true;
          skipped++;
          return false;
        })
        .slice(0, MAX_CLUSTERS_PER_RUN);

      if (eligibleCommunities.length === 0) {
        return errors.result(
          0,
          skipped > 0
            ? `no new clusters — ${skipped} already curated (modularity=${result.modularity.toFixed(3)})`
            : `no eligible clusters (modularity=${result.modularity.toFixed(3)})`,
        );
      }

      // 3. Resolve the LLM provider for `topic-synthesis`. Mirrors the
      //    pattern in `pipeline/search.ts` so role-routing stays consistent.
      const routing = await getLlmRouting();
      const router = new LlmRouter(routing);
      const provider = router.getProvider("topic-synthesis");
      if (!provider.chat) {
        const reason = "no topic-synthesis chat provider";
        console.warn(`[sleep-agent] topic-synthesis aborted: ${reason}`);
        errors.recordPassScoped(reason);
        return errors.result(0, reason);
      }

      const generatedAt = new Date().toISOString();

      for (const [communityId, members] of eligibleCommunities) {
        try {
          // Fetch each member's title + body preview. Failures (file gone
          // between buildGraph and getNote) drop silently — the cluster
          // still goes to the LLM with whatever remains.
          const memberContent = await Promise.all(
            members.slice(0, MAX_MEMBERS_PER_PROMPT).map(async (nid) => {
              // Story S4 — the `RAW/_…` Hände-weg-Zone is NEVER distilled,
              // not even read into a synthesis prompt (AC#1 Bullet 3). Regular
              // RAW notes stay readable here — distillation reads RAW legitimately.
              if (isHandsOffZone(nid)) return null;
              const n = await getNote(nid).catch(() => null);
              if (!n) return null;
              // A previous run's own output is not evidence about the topic —
              // it IS the topic's summary. Feeding it back produces a summary
              // of a summary (and a note that wikilinks itself).
              if (isOwnTopicNote(n.body ?? "")) return null;
              // Frontmatter gehört NICHT in den Prompt. Zwei Gründe:
              //   1. Es frisst das knappe MAX_BODY_CHARS-Budget — bei einer
              //      typischen Notiz sind die ersten ~250 Zeichen reines YAML,
              //      der eigentliche Inhalt wird abgeschnitten.
              //   2. Es enthält `id: <ULID>`. Nach einer "noteId" für die
              //      Quellen-Wikilinks gefragt, greift das Modell genau dieses
              //      Feld auf und schreibt `[[01KZ8X…]]` — eine Form, die der
              //      Graph-Resolver früher nicht auflöste. Ergebnis waren
              //      selbst erzeugte Links, die der Health-Check anschließend
              //      als „defekt" meldete.
              // Die kanonische ID steht ohnehin als `[${nid}]` vor dem Block.
              let content = n.body ?? "";
              try {
                content = parseFrontmatter(content).body;
              } catch {
                // Malformed YAML — lieber der Rohtext als gar kein Kontext.
              }
              return {
                id: nid,
                block: `[${nid}] ${n.title}\n${content.trimStart().slice(0, MAX_BODY_CHARS)}`,
              };
            }),
          );
          const usableMembers = memberContent.filter(
            (m): m is { id: string; block: string } => Boolean(m),
          );
          const contentBlock = usableMembers.map((m) => m.block).join("\n\n---\n\n");

          if (!contentBlock) {
            // Every member was hands-off or vanished between buildGraph and
            // getNote — nothing left to synthesize from.
            errors.record(
              members[0] ?? "",
              `cluster ${communityId}: no readable member notes (${members.length} members)`,
            );
            continue;
          }

          const messages = [
            { role: "system" as const, content: SYNTH_PROMPT },
            {
              role: "user" as const,
              content: `Notes (cluster of ${usableMembers.length}):\n\n${contentBlock}\n\nWrite the topic-summary now.`,
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
          const path = `70_pai/topics/auto-${slug}`;

          // Second guard, by filename. The community-id check above misses the
          // case where a cluster drifted (new id) but the LLM landed on the
          // same title — and that title is exactly what accept would `git mv`
          // onto the existing file.
          if (acceptedTopics.slugs.has(slug)) {
            skipped++;
            continue;
          }

          await createNote(path, synth.text, {
            type: "intervention",
            title,
            extra: {
              intervention_kind: TOPIC_NOTE_KIND,
              status: "pending",
              origin: "agent",
              confidence: 0.6,
              source_notes: usableMembers.map((m) => m.id),
              community_id: communityId,
              generated_at: generatedAt,
            },
          });

          processed++;
        } catch (err) {
          errors.record(
            members[0] ?? "",
            `cluster ${communityId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          console.warn(
            `[sleep-agent] topic-synthesis cluster "${communityId}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return errors.result(
        processed,
        `synthesized ${processed} topic notes from ${eligibleCommunities.length} clusters${
          skipped > 0 ? `, skipped ${skipped} already curated` : ""
        } (modularity=${result.modularity.toFixed(3)})`,
      );
    } catch (err) {
      errors.recordPassScoped(err);
      return errors.result(processed, `pass-error: ${String(err).slice(0, 200)}`);
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
