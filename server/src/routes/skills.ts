import { Hono } from "hono";
import {
  importSkill,
  FrontmatterValidationError,
  type ImportSkillFile,
  type ImportSkillResult,
} from "@lokyy/core";

/**
 * /api/skills — Story 12.3 (Epic 12) server-side import route.
 *
 * `POST /api/skills/import` accepts a FOLDER upload: a `multipart/form-data`
 * body carrying MULTIPLE files (the browser uses `<input webkitdirectory>`),
 * plus a `skillName` field. Each file must carry its path RELATIVE to the
 * skill root (e.g. `SKILL.md`, `references/layout.md`, `templates/x.jsx`).
 *
 * Why no ZIP-lib: the browser sends the files individually, each with its own
 * relative path — there is nothing to unzip. We reconstruct the tree from the
 * per-file relative paths and hand the list straight to core `importSkill`,
 * which is the shared logic also used by the MCP import tool.
 *
 * Relative-path resolution, in priority order:
 *   1. A `paths` form field — a JSON array of relative paths, positionally
 *      aligned with the appended files (most explicit; survives proxies that
 *      strip directory info from the filename).
 *   2. The per-file `webkitRelativePath`-style filename. When a browser uploads
 *      a directory, each `File.name` in the multipart part is the path relative
 *      to the chosen folder (e.g. `my-skill/references/a.md`). We strip the
 *      leading top-level folder segment so the skill root is the import root.
 *   3. The bare `file.name` as a last resort (single-file / flat upload).
 */
export const skillsRoutes = new Hono();

/** Max bytes we are willing to read for a single skill import (defensive). */
const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MiB across all files

/** Normalize a client-supplied relative path to a safe POSIX form. */
function sanitizeRelPath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const posix = raw.replace(/\\/g, "/").trim();
  const trimmed = posix.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return undefined;
  // Reject traversal and current-dir segments — these would let an import
  // escape `70_pai/skills/<slug>/`. Empty segments (`a//b`) are also rejected.
  const segments = trimmed.split("/");
  if (segments.some((seg) => seg === ".." || seg === "." || seg === "")) {
    return undefined;
  }
  return trimmed;
}

/**
 * Strip the single leading top-level directory segment that `webkitdirectory`
 * prepends (`my-skill/references/a.md` → `references/a.md`). Paths without a
 * directory component (`SKILL.md`) are returned unchanged.
 */
function stripTopFolder(relPath: string): string {
  const idx = relPath.indexOf("/");
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/** Parse the optional positional `paths` JSON field. */
function parsePathsField(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
      return parsed as string[];
    }
  } catch {
    // Fall through — caller treats undefined as "use per-file names".
  }
  return undefined;
}

skillsRoutes.post("/import", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json(
      { error: "multipart/form-data mit Datei-Upload erforderlich" },
      415,
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "multipart/form-data konnte nicht gelesen werden" }, 400);
  }

  const skillName = form.get("skillName");
  if (typeof skillName !== "string" || skillName.trim() === "") {
    return c.json({ error: "skillName erforderlich" }, 400);
  }

  // Collect uploaded files. `webkitdirectory` posts each file under the same
  // field name (`files`); we also accept `file` for single-file compatibility.
  const entries: File[] = [];
  for (const key of ["files", "file"]) {
    for (const value of form.getAll(key)) {
      if (value instanceof File) entries.push(value);
    }
  }
  if (entries.length === 0) {
    return c.json({ error: "Mindestens eine Datei erforderlich" }, 400);
  }

  const explicitPaths = parsePathsField(form.get("paths"));

  const files: ImportSkillFile[] = [];
  let totalBytes = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    // 1. explicit positional path → 2. filename (top folder stripped).
    const candidate =
      explicitPaths?.[i] ?? stripTopFolder(entry.name.replace(/\\/g, "/"));
    const relPath = sanitizeRelPath(candidate);
    if (!relPath) {
      return c.json(
        { error: `Ungültiger relativer Pfad für Datei #${i}: "${entry.name}"` },
        400,
      );
    }

    const buf = Buffer.from(await entry.arrayBuffer());
    totalBytes += buf.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return c.json({ error: "Upload zu groß (max. 25 MiB pro Skill)" }, 413);
    }
    files.push({ relPath, content: buf.toString("utf-8") });
  }

  // Hand off to the shared core logic. core enforces the SKILL.md-at-root
  // requirement and SPEC-valid frontmatter; we translate its error shapes
  // into structured HTTP responses.
  let result: ImportSkillResult;
  try {
    result = await importSkill({ skillName, files });
  } catch (err) {
    if (err instanceof FrontmatterValidationError) {
      return c.json(
        { error: "frontmatter_invalid", message: err.message },
        422,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    // The "no SKILL.md" / "no files" guards from core surface as plain Errors;
    // they are client mistakes → 400. Everything else is a 500.
    if (/SKILL\.md is required|no files supplied/i.test(message)) {
      return c.json({ error: "invalid_skill_upload", message }, 400);
    }
    return c.json({ error: "import_failed", message }, 500);
  }

  return c.json(
    {
      skillName: result.skillName,
      written: result.written,
      skipped: result.skipped,
    },
    201,
  );
});
