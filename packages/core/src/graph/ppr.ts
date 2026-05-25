import { buildGraph } from "./graphService.js";
import type { GraphData, GraphEdge } from "@lokyy/shared";

/**
 * Personalized PageRank über den Wikilink-Graph
 * (HippoRAG, Stanford NeurIPS 2024 — spreading activation über KG).
 *
 * Statt eines separaten Open-IE-Bootstraps nutzen wir das vorhandene
 * Wikilink-Edge-Set aus {@link buildGraph} als KG. Seeds kommen typischerweise
 * von der RRF-Top-N des Hybrid-Retrievers (BM25 + Dense), siehe
 * {@link seedsFromRrfHits}.
 *
 * Algorithmus:
 *   1. Seeds normalisieren -> Personalisierungsvektor p (Σp = 1).
 *   2. Adjazenz aus graphService bauen, Edge-Gewichte nach Kind setzen.
 *   3. Iteriere r_{t+1} = α · M · r_t + (1-α) · p, dabei propagiert M
 *      jeden Knoten anteilig nach Edge-Gewicht. Dangling Nodes (keine
 *      ausgehenden Edges) entladen ihre Masse zurück auf p, sonst würde
 *      Wahrscheinlichkeitsmasse verloren gehen ("rank sink").
 *   4. Early-Stop wenn L1-Δ < 1e-6.
 *   5. Top-K nach Rank, mit `isSeed`-Flag fürs Logging.
 *
 * Reine Funktion — keine DB-Writes. Importance-Boost bleibt dem Caller
 * überlassen (multipliziere `pprHit.score` mit `getScoring(id).importanceScore`).
 */

/** Wikilink-Edge ist Default; weitere Kinds kommen mit Wave B1 Stories 2-4. */
export type EdgeKind = "wikilink" | "mdlink" | "alias" | "tag_cooccur" | "semantic";

export interface PPRSeeds {
  /**
   * Map note_id → Roh-Gewicht. Werden intern normalisiert (Σ = 1). Eine
   * leere Map fällt auf den uniformen PageRank zurück.
   */
  seeds: Map<string, number>;
}

export interface PPROptions {
  /** Damping α (HippoRAG-validiert: 0.5). Default 0.5. */
  damping?: number;
  /** Maximale Iterationen vor Hard-Stop. Default 50. */
  iterations?: number;
  /** Anzahl Top-Hits im Output. Default 50. */
  topK?: number;
  /**
   * Edge-Gewichte je Kind. Default: wikilink=1.0, mdlink=0.9, alias=1.0,
   * tag_cooccur=0.4, semantic=0.3. Override mergt mit Defaults.
   */
  edgeWeights?: Partial<Record<EdgeKind, number>>;
  /**
   * Wenn true, soll der Caller den finalen Score per
   * `note_scoring.importance_score` multiplizieren. Hier ein No-op-Hint,
   * damit die DB-freie Pure-Function nicht implizit Drizzle pullt.
   */
  applyImportanceBoost?: boolean;
}

export interface PPRHit {
  noteId: string;
  score: number;
  pprRank: number;
  isSeed: boolean;
}

const DEFAULT_EDGE_WEIGHTS: Record<EdgeKind, number> = {
  wikilink: 1.0,
  mdlink: 0.9,
  alias: 1.0,
  tag_cooccur: 0.4,
  semantic: 0.3,
};

/**
 * Erzeugt einen Seed-Vektor aus einer geordneten RRF-Hitliste. Top-Rank
 * bekommt Gewicht N, der nächste N-1, ... linearer Decay. Die finale
 * Normalisierung erledigt {@link personalizedPageRank} selbst.
 */
export function seedsFromRrfHits(
  hits: Array<{ noteId: string; score: number }>,
): PPRSeeds {
  if (hits.length === 0) return { seeds: new Map() };
  const N = hits.length;
  const seeds = new Map<string, number>();
  hits.forEach((h, i) => {
    // Duplikate (gleiche noteId) → höchstes Gewicht behalten.
    const w = N - i;
    const existing = seeds.get(h.noteId);
    if (existing === undefined || w > existing) seeds.set(h.noteId, w);
  });
  return { seeds };
}

/**
 * Personalized PageRank — siehe Modul-Header.
 *
 * Performance: O(iterations · |E|). Bei ~10k Knoten, ~50k Kanten, 50 Iter
 * sind das ~2.5M Multiplikationen in JS-Map-Land — Schätzung 100–300 ms
 * abhängig von der Lookup-Cost. `buildGraph()` selbst liest den ganzen
 * Vault — bei großen Vaults dominiert der Disk-I/O, nicht die Iteration.
 */
export async function personalizedPageRank(
  seedsObj: PPRSeeds,
  opts: PPROptions = {},
): Promise<PPRHit[]> {
  const graph = await buildGraph();
  return pageRankOnGraph(graph, seedsObj, opts);
}

/**
 * Pure variant — operiert auf einem schon geladenen Graphen. Wird vom Test
 * direkt aufgerufen (kein Vault-I/O nötig) und intern von
 * {@link personalizedPageRank} verwendet.
 */
export function pageRankOnGraph(
  graph: GraphData,
  seedsObj: PPRSeeds,
  opts: PPROptions = {},
): PPRHit[] {
  const damping = opts.damping ?? 0.5;
  const iterations = opts.iterations ?? 50;
  const topK = opts.topK ?? 50;
  const edgeWeights: Record<EdgeKind, number> = {
    ...DEFAULT_EDGE_WEIGHTS,
    ...(opts.edgeWeights ?? {}),
  };

  if (graph.nodes.length === 0) return [];

  // 2. Personalisierungsvektor: Seeds normalisieren. Fehlende oder nicht
  //    im Graph existierende Seeds fallen weg; sum=0 → uniform.
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  let seedSum = 0;
  const filteredSeeds = new Map<string, number>();
  for (const [id, w] of seedsObj.seeds) {
    if (nodeIds.has(id) && w > 0) {
      filteredSeeds.set(id, w);
      seedSum += w;
    }
  }
  const personalization = new Map<string, number>();
  if (seedSum > 0) {
    for (const [id, w] of filteredSeeds) personalization.set(id, w / seedSum);
  } else {
    const u = 1 / graph.nodes.length;
    for (const n of graph.nodes) personalization.set(n.id, u);
  }

  // 3. Adjazenz + ausgehende Gewichtssumme pro Knoten.
  const out = new Map<string, Array<{ target: string; weight: number }>>();
  const outWeight = new Map<string, number>();
  for (const node of graph.nodes) {
    out.set(node.id, []);
    outWeight.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    // GraphEdge hat (Stand Story 1) kein `kind`-Feld — Wikilinks sind die
    // einzige Quelle. Spätere Edge-Kinds (mdlink, alias, tag_cooccur,
    // semantic) liefert buildGraph() bereits über parseLinks/parseMdLinks
    // aber ohne Kind-Tag; bis das Shared-Type erweitert ist, behandeln wir
    // alle Kanten als wikilink. Wenn ein Caller später (Wave B1 Story 2+)
    // typed edges einspeist, greift der Override über (edge as { kind? }).
    const kind = ((edge as GraphEdge & { kind?: EdgeKind }).kind ?? "wikilink") as EdgeKind;
    const w = edgeWeights[kind] ?? 1.0;
    const list = out.get(edge.source);
    if (!list) continue; // Edge zu/von unbekanntem Knoten — skip.
    if (!nodeIds.has(edge.target)) continue;
    list.push({ target: edge.target, weight: w });
    outWeight.set(edge.source, (outWeight.get(edge.source) ?? 0) + w);
  }

  // 4. Warm-Start mit Personalisierungsvektor.
  let rank = new Map<string, number>();
  for (const node of graph.nodes) {
    rank.set(node.id, personalization.get(node.id) ?? 0);
  }

  // 5. Power-Iteration.
  const teleport = 1 - damping;
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    for (const node of graph.nodes) next.set(node.id, 0);

    for (const [src, neighbors] of out) {
      const r = rank.get(src) ?? 0;
      if (r === 0) continue;
      const totalW = outWeight.get(src) ?? 0;
      if (totalW === 0) {
        // Dangling node — Masse zurück auf p, sonst entweicht
        // Wahrscheinlichkeitsmasse über die Iteration (rank sink).
        for (const [id, p] of personalization) {
          next.set(id, (next.get(id) ?? 0) + r * p);
        }
        continue;
      }
      for (const { target, weight } of neighbors) {
        next.set(target, (next.get(target) ?? 0) + r * (weight / totalW));
      }
    }

    // Damping + Teleport zur Personalisierung.
    let delta = 0;
    for (const node of graph.nodes) {
      const propagated = damping * (next.get(node.id) ?? 0);
      const tele = teleport * (personalization.get(node.id) ?? 0);
      const updated = propagated + tele;
      next.set(node.id, updated);
      delta += Math.abs(updated - (rank.get(node.id) ?? 0));
    }
    rank = next;
    if (delta < 1e-6) break;
  }

  // 6. importance-boost: bewusst no-op hier — Tests fordern Pure-Function,
  //    DB-Pulls würden den Aufrufkontext (sleep-agent vs. HTTP) belasten.
  //    Caller multipliziert post-hoc, siehe seedsFromRrfHits-Doc.
  if (opts.applyImportanceBoost) {
    // Intentional fall-through. See JSDoc on PPROptions.applyImportanceBoost.
  }

  // 7. Sortieren + Top-K. isSeed referenziert nur die Original-Seeds,
  //    nicht die gefilterten — Telemetrie soll sehen, ob ein angefragter
  //    Seed überlebt hat.
  const seedSet = new Set(seedsObj.seeds.keys());
  const hits: PPRHit[] = [...rank.entries()]
    .map(([noteId, score]) => ({
      noteId,
      score,
      pprRank: 0,
      isSeed: seedSet.has(noteId),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  hits.forEach((h, i) => {
    h.pprRank = i + 1;
  });
  return hits;
}
