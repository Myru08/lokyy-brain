import { Hono } from "hono";
import { getTemplate, listTemplates } from "@lokyy/core";

/**
 * /api/templates — read-only listing + fetch of vault templates.
 *
 * Templates are plain .md files under `00_meta/templates/`. The PWA picker
 * lists them, then fetches one, fills variables, and pipes the result into
 * the existing createNote flow (which adds SPEC-valid frontmatter).
 *
 * Auth follows the same pattern as `/api/notes`: mounted behind the
 * `setupGate` middleware at the index level. No additional per-route auth
 * is layered here.
 */
export const templatesRoutes = new Hono();

// GET /api/templates -> { templates: TemplateRef[] }
templatesRoutes.get("/", async (c) => {
  const templates = await listTemplates();
  return c.json({ templates });
});

// GET /api/templates/:name -> { name, body }
templatesRoutes.get("/:name", async (c) => {
  const name = c.req.param("name");
  const tpl = await getTemplate(name);
  if (!tpl) return c.json({ error: "Template nicht gefunden" }, 404);
  return c.json(tpl);
});
