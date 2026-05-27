import { Hono } from "hono";
import {
  VoiceDefaultsValidationError,
  getVoiceDefaults,
  updateVoiceDefaults,
  validateVoiceDefaultsPatch,
} from "@lokyy/core";

/**
 * `/api/voice/settings` — persisted voice-capture defaults.
 *
 *   GET  → current merged VoiceDefaults (hardcoded defaults if no row).
 *   PUT  → merge body (partial) on top, persist, return updated value.
 *
 * Bewusst KEIN Auth-Gate: andere `/api/settings/*` Routen sind heute auch
 * setupGate-only. Wenn weitere Settings einen Auth-Gate brauchen, ziehen
 * wir sie gemeinsam nach (siehe routes/settings.ts).
 *
 * Backwards-compat: solange kein `voice_defaults`-Row in `system_config`
 * existiert, antwortet GET mit den hartcodierten Defaults und der voice
 * pipe handler verhält sich genau wie heute.
 */
export const voiceSettingsRoutes = new Hono();

voiceSettingsRoutes.get("/", async (c) => {
  const defaults = await getVoiceDefaults();
  return c.json(defaults);
});

voiceSettingsRoutes.put("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: "invalid-json",
        message: "Body must be valid JSON",
      },
      400,
    );
  }
  let patch;
  try {
    patch = validateVoiceDefaultsPatch(body);
  } catch (err) {
    if (err instanceof VoiceDefaultsValidationError) {
      return c.json(
        {
          error: "validation-failed",
          field: err.field,
          message: err.message,
        },
        400,
      );
    }
    return c.json(
      {
        error: "validation-failed",
        message: err instanceof Error ? err.message : "validation failed",
      },
      400,
    );
  }
  try {
    const merged = await updateVoiceDefaults(patch);
    return c.json(merged);
  } catch (err) {
    return c.json(
      {
        error: "persist-failed",
        message: err instanceof Error ? err.message : "persist failed",
      },
      500,
    );
  }
});
