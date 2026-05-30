import { Hono } from "hono";
import {
  readMenuConfig,
  writeMenuConfig,
  type MenuItem,
} from "@lokyy/core";

/**
 * /api/workspace — Lokyy-Workspace configuration (Epic 11 / Story 11.1).
 *
 * Flat, single-vault route (no `:vaultId`), camelCase JSON — house convention.
 * Mounted as `app.route("/api/workspace", workspaceRoutes)` by the wireup step
 * in `server/src/index.ts` (NOT edited here).
 *
 *   GET  /api/workspace/menu  → { version, items }   (System + Custom merged)
 *   PUT  /api/workspace/menu  ← { items }            (System-Items rejected
 *                                                     server-side; only custom
 *                                                     items are persisted)
 *
 * All persistence happens in `@lokyy/core` menuConfig via gitService (Forgejo
 * first; no direct fs-write). System-Items are code constants merged in front
 * and are NEVER written to the vault.
 */
export const workspaceRoutes = new Hono();

workspaceRoutes.get("/menu", async (c) => {
  try {
    const config = await readMenuConfig();
    return c.json(config);
  } catch (err) {
    // readMenuConfig() degrades to System-Defaults internally and should not
    // throw, but we surface any unexpected failure as a 500 rather than crash.
    return c.json(
      { error: err instanceof Error ? err.message : "failed to read menu" },
      500,
    );
  }
});

workspaceRoutes.put("/menu", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { items?: unknown }).items)
  ) {
    return c.json({ error: "body must be { items: MenuItem[] }" }, 400);
  }

  const incoming = (body as { items: MenuItem[] }).items;

  // Server-side protection invariant (architecture addendum §3): drop every
  // incoming `kind:"system"` item BEFORE persistence. The client can never
  // overwrite/delete/persist-reorder System-Items. Core re-filters defensively,
  // but we enforce it here too so the contract is explicit at the boundary.
  const custom = incoming.filter((it) => it && it.kind !== "system");

  try {
    const config = await writeMenuConfig(custom);
    return c.json(config);
  } catch (err) {
    // writeMenuConfig throws on schema-invalid items → 400 (client error).
    return c.json(
      { error: err instanceof Error ? err.message : "failed to write menu" },
      400,
    );
  }
});
