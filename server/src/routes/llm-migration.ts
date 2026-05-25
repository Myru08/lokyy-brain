import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  cancelMigration,
  EmbeddingMigrationError,
  getMigrationStatus,
  startMigration,
  type MigrationProgress,
} from "@lokyy/core";

/**
 * Embedding-Migration HTTP routes (Phase-0 Wave D / Agent 1).
 *
 * Mounted by `server/src/index.ts` under `/api/llm`:
 *
 *   POST   /api/llm/migration/start         → { migrationId }
 *   GET    /api/llm/migration/:id/status    → MigrationProgress (snapshot)
 *   GET    /api/llm/migration/:id/stream    → SSE; yields MigrationProgress
 *                                              every second until terminal
 *   POST   /api/llm/migration/:id/cancel    → 204
 */
export const llmMigrationRoutes = new Hono();

interface StartBody {
  toProvider?: string;
  toModel?: string;
}

llmMigrationRoutes.post("/start", async (c) => {
  let body: StartBody;
  try {
    body = (await c.req.json()) as StartBody;
  } catch {
    return c.json({ error: "invalid-json" }, 400);
  }
  if (!body || typeof body.toProvider !== "string" || body.toProvider.length === 0) {
    return c.json({ error: "toProvider-required" }, 400);
  }
  try {
    const result = await startMigration({
      toProvider: body.toProvider,
      toModel: typeof body.toModel === "string" ? body.toModel : undefined,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof EmbeddingMigrationError) {
      const status = err.code === "PROVIDER_NOT_FOUND" ? 404 : 400;
      return c.json({ error: err.code, message: err.message }, status);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "start-failed", message: msg }, 500);
  }
});

llmMigrationRoutes.get("/:id/status", async (c) => {
  const id = c.req.param("id");
  try {
    const progress = await getMigrationStatus(id);
    return c.json(progress);
  } catch (err) {
    if (err instanceof EmbeddingMigrationError && err.code === "NOT_FOUND") {
      return c.json({ error: "not-found" }, 404);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "status-failed", message: msg }, 500);
  }
});

llmMigrationRoutes.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  try {
    await cancelMigration(id);
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof EmbeddingMigrationError && err.code === "NOT_FOUND") {
      return c.json({ error: "not-found" }, 404);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "cancel-failed", message: msg }, 500);
  }
});

const TERMINAL: ReadonlySet<MigrationProgress["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * SSE stream — yields a progress event every ~1s. Closes the stream as soon
 * as the migration reaches a terminal state. Sends a single `error` event
 * if the id does not exist, then closes.
 */
llmMigrationRoutes.get("/:id/stream", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    while (true) {
      let progress: MigrationProgress;
      try {
        progress = await getMigrationStatus(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "not-found", message: msg }),
        });
        return;
      }
      await stream.writeSSE({
        event: "progress",
        data: JSON.stringify(progress),
      });
      if (TERMINAL.has(progress.status)) {
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ migrationId: id, status: progress.status }),
        });
        return;
      }
      await stream.sleep(1000);
    }
  });
});
