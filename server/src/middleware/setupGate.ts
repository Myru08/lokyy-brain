import type { MiddlewareHandler } from "hono";
import { isSetupComplete } from "@lokyy/core";

/**
 * In setup mode, all data routes return 503 with {error: "setup-required"}.
 * Setup-API routes (/api/setup/*) and /health are not affected.
 */
export const setupGate: MiddlewareHandler = async (c, next) => {
  if (await isSetupComplete()) return next();
  return c.json(
    { error: "setup-required", message: "Initial setup not complete. Visit /setup." },
    503,
  );
};
