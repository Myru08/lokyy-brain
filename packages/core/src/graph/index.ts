/**
 * Graph-Layer barrel.
 *
 * graphService exposes the Wikilink-Graph derived from .md files
 * (no separate index); ppr layers Personalized-PageRank spreading
 * activation on top (Phase B Wave B1 / Story 1, HippoRAG-style).
 */
export {
  buildGraph,
  backlinks,
  listTags,
  parseAliases,
  parseLinks,
  parseTags,
  parseTitle,
  type Backlink,
  type TagSummary,
} from "./graphService.js";

export {
  personalizedPageRank,
  pageRankOnGraph,
  seedsFromRrfHits,
  type EdgeKind,
  type PPRSeeds,
  type PPROptions,
  type PPRHit,
} from "./ppr.js";

export {
  detectCommunities,
  type CommunityDetectionOpts,
  type CommunityResult,
} from "./community.js";
