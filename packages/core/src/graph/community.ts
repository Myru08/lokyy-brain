/**
 * Phase C Wave C1 / Story 2 — Community detection on the Wikilink graph.
 *
 * GraphRAG (Microsoft 2024) describes Leiden community detection followed by
 * an LLM-synthesised summary per cluster. Leiden is a fairly complex modular
 * refinement of Louvain — for a personal vault with O(10^3) notes that's
 * overkill. We use **Label Propagation** (Raghavan, Albert, Kumara 2007),
 * the simpler-and-still-bewährt algorithm Louvain succeeded:
 *
 *   1. Every node starts in its own community.
 *   2. Iterate: each node adopts the most-frequent label among its neighbours.
 *      Ties broken alphabetically for determinism. Process nodes in sorted
 *      id-order — the original LPA uses random order, but determinism here
 *      matters more than a small modularity gain (sleep-agent must produce
 *      the same clusters on the same vault between runs).
 *   3. Stop when no node changes label OR `maxIterations` is reached.
 *
 * Final modularity is computed via the standard Newman-Girvan formula
 *   Q = (1/2m) Σ_ij [A_ij − k_i·k_j/(2m)] · δ(c_i, c_j)
 * over the undirected projection of the graph. Modularity > 0.3 is usually
 * regarded as a meaningful community structure; in personal vaults dominated
 * by chain-of-thought links we typically see 0.3 – 0.6.
 *
 * For vaults > ~50k nodes we'd swap this for proper Louvain via
 * `graphology-communities-louvain`. Until then, no new dependency.
 *
 * Disconnected components: each component is independently resolved into one
 * or more communities (degree-0 isolates form singleton communities labelled
 * with their own node id). The MIN_CLUSTER_SIZE filter downstream drops
 * those before LLM-synthesis so isolates never trigger spurious topic notes.
 */
import type { GraphData } from "@lokyy/shared";

export interface CommunityDetectionOpts {
  /** Hard cap on label-propagation sweeps. Default 50 — converges much sooner. */
  maxIterations?: number;
}

export interface CommunityResult {
  /** Map node-id → community-id (the propagated label, itself a node id). */
  assignment: Map<string, string>;
  /** Communities: community-id → member node-ids. */
  communities: Map<string, string[]>;
  /** Newman-Girvan modularity over the final partition (range ≈ −0.5 … 1.0). */
  modularity: number;
}

/**
 * Run label-propagation on `graph` and return the partition + modularity.
 *
 * Treats the graph as **undirected** for community-detection (a Wikilink
 * implies topical co-membership regardless of direction). Multi-edges are
 * collapsed by the adjacency map (the underlying graph already deduplicates
 * via `seen` in graphService).
 */
export function detectCommunities(
  graph: GraphData,
  opts: CommunityDetectionOpts = {},
): CommunityResult {
  const maxIter = opts.maxIterations ?? 50;

  // Each node starts in its own community.
  const labels = new Map<string, string>();
  for (const n of graph.nodes) labels.set(n.id, n.id);

  // Adjacency — undirected for community-detection. Nodes with no edges
  // (degree 0) stay as singleton communities; we still seed an empty list
  // for them so `adj.get(id)` is always defined.
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
  }

  // Deterministic iteration order — sort node-ids once outside the loop.
  const sortedNodes = [...graph.nodes].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (const node of sortedNodes) {
      const neighbors = adj.get(node.id) ?? [];
      if (neighbors.length === 0) continue;

      const labelCounts = new Map<string, number>();
      for (const nbr of neighbors) {
        const lbl = labels.get(nbr) ?? nbr;
        labelCounts.set(lbl, (labelCounts.get(lbl) ?? 0) + 1);
      }

      // Pick highest count; on tie pick the lexicographically smallest label
      // for determinism. Iterating Map preserves insertion order, but we
      // compare explicitly so the tie-break is independent of insertion.
      let best: string | null = null;
      let bestCount = -1;
      for (const [label, count] of labelCounts) {
        if (
          count > bestCount ||
          (count === bestCount && best !== null && label < best)
        ) {
          best = label;
          bestCount = count;
        }
      }

      if (best !== null && best !== labels.get(node.id)) {
        labels.set(node.id, best);
        changed++;
      }
    }
    if (changed === 0) break;
  }

  // Group by label.
  const communities = new Map<string, string[]>();
  for (const [nodeId, label] of labels) {
    const arr = communities.get(label);
    if (arr) arr.push(nodeId);
    else communities.set(label, [nodeId]);
  }

  return {
    assignment: labels,
    communities,
    modularity: computeModularity(graph, labels),
  };
}

/**
 * Newman-Girvan modularity of a labelling over the undirected projection of
 * `graph`. Returns 0 for an edgeless graph.
 *
 *   Q = (1/2m) · Σ_(i,j) [A_ij − k_i·k_j/(2m)] · δ(c_i, c_j)
 *
 * We iterate edges once (each contributing the `A_ij` term to its endpoints'
 * shared community) and subtract the expected null-model contribution for
 * the full pair sum in closed form per community.
 */
function computeModularity(
  graph: GraphData,
  labels: Map<string, string>,
): number {
  const m = graph.edges.length;
  if (m === 0) return 0;

  // Degree in the undirected projection: each edge increments source AND target.
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  // Σ A_ij·δ over all ordered pairs = 2 · (intra-community edges)
  // because the undirected projection double-counts each edge.
  let sumA = 0;
  for (const e of graph.edges) {
    if (labels.get(e.source) === labels.get(e.target)) {
      sumA += 2; // (i,j) and (j,i)
    }
  }

  // Σ (k_i·k_j)/(2m) · δ summed per community as (Σ k_in_c)^2 / (2m).
  const degBySum = new Map<string, number>();
  for (const [nodeId, label] of labels) {
    degBySum.set(label, (degBySum.get(label) ?? 0) + (degree.get(nodeId) ?? 0));
  }
  let expected = 0;
  for (const ds of degBySum.values()) {
    expected += (ds * ds) / (2 * m);
  }

  // Q = (sumA − expected) / (2m).
  return (sumA - expected) / (2 * m);
}
