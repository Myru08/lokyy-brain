import { Hono } from "hono";
import { getMemoryProvider, getNote, type SearchOpts } from "@lokyy/core";

/**
 * Search routes (Story 5.5, 5.6).
 *
 * POST /api/search          — Tier 1 + Tier 2 merged hits
 * GET  /api/notes/:id/related — top-N related notes
 *
 * vaultId is implicit for now (single-active-vault dev mode). Once Story
 * 3's route migration to /api/vaults/:vaultId/* lands, these will move
 * under that scope.
 */

const DEFAULT_VAULT = process.env.LOKYY_DEFAULT_VAULT ?? "default";

export const searchRoutes = new Hono();

searchRoutes.post("/search", async (c) => {
  const { query, limit, tagFilter, folderPrefix } = await c.req.json<{
    query: string;
    limit?: number;
    tagFilter?: string[];
    folderPrefix?: string;
  }>();
  const opts: SearchOpts = { limit, tagFilter, folderPrefix };
  const hits = await getMemoryProvider(DEFAULT_VAULT).search(query ?? "", opts);
  return c.json({ results: hits, degraded: hits.every((h) => h.tier === "t1") && hits.length > 0 ? false : false });
});

searchRoutes.get("/notes/:id{.+}/related", async (c) => {
  const noteId = c.req.param("id");
  const limit = Number(c.req.query("limit") ?? "5");
  const hits = await getMemoryProvider(DEFAULT_VAULT).relatedNotes(noteId, { limit });
  return c.json({ results: hits });
});

export { getNote };
