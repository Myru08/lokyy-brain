import { Hono } from "hono";

import {
  listPeers,
  getPeer,
  recomputePeerProfile,
  suggestPeerCandidates,
  createPeerFromEntity,
  isPeerType,
  type Peer,
} from "@lokyy/core";

/**
 * Phase C Wave C2 / Story 3 — `/api/peers/*` HTTP surface.
 *
 *   GET  /api/peers                               list all peer profiles
 *   GET  /api/peers/suggestions?minMentions=5     person-entities w/o peer-note
 *   GET  /api/peers/:noteId{.+}                   one peer profile
 *   POST /api/peers/from-entity { entityId, peerType }
 *                                                 materialize peer-note from entity
 *   POST /api/peers/:noteId{.+}/recompute         re-derive sidecar from sources
 *
 * Note on route order: `/suggestions` and `/from-entity` are declared
 * BEFORE `/:noteId` so Hono doesn't capture the literal segments as a
 * wildcard. `:noteId{.+}` covers slashes inside peer-note paths
 * (`peers/anna-mueller`).
 */
export const peersRoutes = new Hono();

function peerToJson(p: Peer): Record<string, unknown> {
  return {
    noteId: p.noteId,
    peerType: p.peerType,
    linkedEntityId: p.linkedEntityId ?? null,
    relationshipStrength: p.relationshipStrength,
    interactionCount: p.interactionCount,
    lastInteraction: p.lastInteraction?.toISOString() ?? null,
    ongoingTopics: p.ongoingTopics,
    traits: p.traits,
    computedAt: p.computedAt.toISOString(),
  };
}

// ─── GET /api/peers ──────────────────────────────────────────────────────
peersRoutes.get("/", async (c) => {
  try {
    const peers = await listPeers();
    return c.json({ peers: peers.map(peerToJson) });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "listPeers failed" },
      500,
    );
  }
});

// ─── GET /api/peers/suggestions?minMentions=5 ────────────────────────────
peersRoutes.get("/suggestions", async (c) => {
  const minMentionsRaw = c.req.query("minMentions");
  const minMentions = (() => {
    const n = Number(minMentionsRaw ?? "5");
    if (!Number.isFinite(n) || n < 1) return 5;
    return Math.min(500, Math.floor(n));
  })();
  try {
    const candidates = await suggestPeerCandidates(minMentions);
    return c.json({
      suggestions: candidates.map((s) => ({
        entityId: s.entityId,
        displayName: s.displayName,
        mentionCount: s.mentionCount,
        existingPeerNoteId: s.existingPeerNoteId ?? null,
      })),
    });
  } catch (err) {
    return c.json(
      {
        error:
          err instanceof Error ? err.message : "suggestPeerCandidates failed",
      },
      500,
    );
  }
});

// ─── POST /api/peers/from-entity ─────────────────────────────────────────
peersRoutes.post("/from-entity", async (c) => {
  let body: { entityId?: unknown; peerType?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const entityId = body.entityId;
  const peerType = body.peerType;
  if (typeof entityId !== "string" || entityId.length === 0) {
    return c.json({ error: "entityId (string) required" }, 400);
  }
  if (typeof peerType !== "string" || !isPeerType(peerType)) {
    return c.json(
      {
        error:
          "peerType (string) required: person | customer | collaborator | family | agent | organization",
      },
      400,
    );
  }
  try {
    const result = await createPeerFromEntity(entityId, peerType);
    return c.json({ noteId: result.noteId }, 201);
  } catch (err) {
    return c.json(
      {
        error:
          err instanceof Error ? err.message : "createPeerFromEntity failed",
      },
      409,
    );
  }
});

// ─── POST /api/peers/:noteId/recompute ───────────────────────────────────
peersRoutes.post("/:noteId{.+}/recompute", async (c) => {
  const noteId = c.req.param("noteId");
  if (noteId.endsWith("/recompute")) {
    // Hono captured /recompute as part of the wildcard — strip it.
    // (Defensive — the explicit suffix in the pattern already separates.)
  }
  try {
    await recomputePeerProfile(noteId);
    const peer = await getPeer(noteId);
    if (!peer) {
      return c.json(
        { error: `no peer-profile for noteId "${noteId}"` },
        404,
      );
    }
    return c.json({ peer: peerToJson(peer) });
  } catch (err) {
    return c.json(
      {
        error:
          err instanceof Error ? err.message : "recomputePeerProfile failed",
      },
      500,
    );
  }
});

// ─── GET /api/peers/:noteId ──────────────────────────────────────────────
peersRoutes.get("/:noteId{.+}", async (c) => {
  const noteId = c.req.param("noteId");
  try {
    const peer = await getPeer(noteId);
    if (!peer) return c.json({ error: "peer not found" }, 404);
    return c.json({ peer: peerToJson(peer) });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "getPeer failed" },
      500,
    );
  }
});
