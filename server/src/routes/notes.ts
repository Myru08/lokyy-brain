import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  createManaged,
  findByUlid,
  FrontmatterValidationError,
  getMemoryProvider,
  GitBackendError,
  getNote,
  HookExecutionError,
  isSyncPending,
  isUlid,
  listNotes,
  logRetrieval,
  MergeConflictError,
  parseFrontmatter,
  polishNote,
  PolishKeyMissingError,
  PolishLlmError,
  PreCommitHookError,
  queryNotes,
  saveNote,
  serializeFrontmatter,
  type FrontmatterMap,
  type NoteCreateIntent,
  type PolishProviderName,
  indexVaultId,
} from "@lokyy/core";

/** Single-active-vault id (mirrors searchRoutes / notesService). */

/**
 * Maps a save-pipeline error to a Hono JSON response (Story 10.6 AC#4).
 *
 * - Pre-commit hook / frontmatter validation → 422 with validation detail.
 * - Real merge/rebase conflict             → 409 (client resolves).
 * - Git backend (net/auth) failure         → 503; transient sets `retryable`.
 * - Anything else                          → 409 (legacy fallback).
 *
 * Returns `null` when `err` isn't a recognized save error, so callers can
 * apply their own handler-specific fallback shape.
 */
type SaveErrorResponse = {
  status: 422 | 409 | 503;
  body: Record<string, unknown>;
};

function mapSaveError(err: unknown): SaveErrorResponse | null {
  // Muss VOR PreCommitHookError stehen — ein unausführbarer Hook ist ein
  // Infrastruktur-Defekt (jeder Commit stirbt, egal was der User schreibt),
  // kein Frontmatter-Problem. 503 statt 422, weil es am Inhalt nichts zu
  // reparieren gibt; die Meldung nennt die Reparatur (Neustart).
  if (err instanceof HookExecutionError) {
    return {
      status: 503,
      body: {
        error: "vault-hook-broken",
        message: err.message,
        detail: err.stderr || undefined,
        retryable: false,
      },
    };
  }
  if (err instanceof PreCommitHookError) {
    return {
      status: 422,
      body: {
        error: "frontmatter-invalid",
        message: err.message,
        detail: err.stderr || undefined,
      },
    };
  }
  if (err instanceof FrontmatterValidationError) {
    return {
      status: 422,
      body: {
        error: "frontmatter-invalid",
        message: err.message,
        errors: err.errors,
      },
    };
  }
  if (err instanceof MergeConflictError) {
    return {
      status: 409,
      body: { error: "merge-conflict", message: err.message },
    };
  }
  if (err instanceof GitBackendError) {
    return {
      status: 503,
      body: {
        error: "git-backend-unavailable",
        message: err.message,
        retryable: err.transient,
        retryAfter: err.transient ? 5 : undefined,
      },
    };
  }
  return null;
}

/** /api/notes — Liste, Einzelnotiz, Speichern. */
export const notesRoutes = new Hono();

// GET /api/notes -> NoteSummary[]
//
// ADR-004 `notes.list_by_type`: an optional `?type=` query filters by doc type.
// Without it, the full unfiltered summary list is returned (existing behavior,
// unchanged). The `type` filter delegates to the SAME core `queryNotes` the
// /api/dataview route uses (frontmatter-level filter) — no parallel listing
// logic. Projection is mapped to a NoteSummary-shaped row { id, path, title,
// type }; `limit` is honored via the query engine's own clamp.
notesRoutes.get("/", async (c) => {
  const type = c.req.query("type");
  if (!type) {
    return c.json(await listNotes());
  }
  const limit = Number(c.req.query("limit") ?? "50");
  const rows = await queryNotes({
    where: { type },
    select: ["id", "title", "type"],
    ...(Number.isFinite(limit) ? { limit } : {}),
  });
  // queryNotes rows carry the projected frontmatter; surface id/title/type as a
  // summary. The dataview engine always includes the note id in its rows.
  const items = rows.map((r) => ({
    id: String(r.id ?? ""),
    path: `${String(r.id ?? "")}.md`,
    title: r.title != null ? String(r.title) : String(r.id ?? ""),
    type: r.type != null ? String(r.type) : type,
  }));
  return c.json(items);
});

// GET /api/notes/search?q=...&limit=... -> scored hits
//
// ADR-004 `notes.search` HTTP pendant. Delegates to the SAME memory provider
// (Tier1 full-text + Tier2 semantic) the MCP `search_vault` tool and the
// POST /api/search route use — no parallel search logic. Registered BEFORE the
// wildcard `:id{.+}` so the literal `search` segment is not swallowed as a note
// path.
notesRoutes.get("/search", async (c) => {
  const q = c.req.query("q") ?? c.req.query("query") ?? "";
  if (!q.trim()) {
    return c.json({ results: [] });
  }
  const limit = Number(c.req.query("limit") ?? "10");
  const hits = await getMemoryProvider(indexVaultId()).search(q, {
    limit: Number.isFinite(limit) ? limit : 10,
  });
  return c.json({ results: hits });
});

// GET /api/notes/by-id/:ulid — resolve via stable frontmatter ULID.
//
// Registered BEFORE the wildcard `:id{.+}` so the literal `by-id` prefix
// is not swallowed as a note path. Hono dispatches in registration
// order, so this works without explicit priority config.
notesRoutes.get("/by-id/:ulid", async (c) => {
  const ulid = c.req.param("ulid");
  if (!isUlid(ulid)) {
    return c.json({ error: "invalid ULID format" }, 400);
  }
  const note = await findByUlid(ulid);
  if (!note) return c.json({ error: "not found" }, 404);
  // Mirror the path-based GET's fire-and-forget retrieval log so the
  // "AI prompt" → resolve round-trip is visible in /api/traces.
  const sessionId = getCookie(c, "lokyy_session");
  void logRetrieval({
    noteId: note.path,
    source: "api",
    sessionId: sessionId,
  });
  return c.json(note);
});

// POST /api/notes/create-managed — THE sanctioned write path for new notes
// (OS-contract, ADR-004 / ISC-59; the HTTP pendant of the MCP
// `notes.create_managed` tool). Takes a `NoteCreateIntent`
// ({ title, body?, type, tags?, folder_hint? }) and delegates to the SHARED
// core `createManaged`, which derives the path from `type` (the client never
// dictates a path or frontmatter), generates the ULID/created/updated, assembles
// SPEC-valid frontmatter, and writes via gitService.
//
// Registered BEFORE the wildcard `:id{.+}` so the literal `create-managed`
// segment is never swallowed as a note path (Hono dispatches in registration
// order). The wildcards are GET/PUT, so a POST here would not collide anyway —
// belt-and-suspenders for any future method overlap.
//
// Structured errors mirror the MCP tool + the existing save-error mapping:
//   - invalid-type        → 422 (unknown `type`, with the allowed list)
//   - missing-title       → 422 (title required)
//   - type-folder-mismatch→ 422 (derived/hinted path contradicts the type)
//   - frontmatter / merge / git-backend → 422 / 409 / 503 (via mapSaveError)
notesRoutes.post("/create-managed", async (c) => {
  let intent: Partial<NoteCreateIntent>;
  try {
    intent = await c.req.json<Partial<NoteCreateIntent>>();
  } catch {
    return c.json(
      { error: "invalid-body", message: "request body must be valid JSON" },
      400,
    );
  }
  if (!intent || typeof intent !== "object") {
    return c.json(
      { error: "invalid-body", message: "request body must be a JSON object" },
      400,
    );
  }

  try {
    const result = await createManaged(intent as NoteCreateIntent);
    if (result.ok) {
      return c.json(withSyncStatus(result.note), 201);
    }
    // Expected, structured validation failures → 422 (the caller's to fix).
    return c.json(result.error, 422);
  } catch (err) {
    // Unexpected git/frontmatter failure → reuse the shared save-error mapping
    // (422 frontmatter / 409 merge / 503 git-backend), consistent with PUT.
    const mapped = mapSaveError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    return c.json(
      { error: err instanceof Error ? err.message : "create-managed failed" },
      409,
    );
  }
});

// GET /api/notes/:id  (id darf "/" enthalten -> Wildcard)
notesRoutes.get("/:id{.+}", async (c) => {
  const id = c.req.param("id");
  const note = await getNote(id);
  if (!note) return c.json({ error: "Notiz nicht gefunden" }, 404);
  // Phase A Wave A1 / Story 3 — Retrieval-Trace-Log.
  // Fire-and-forget: logRetrieval swallows its own errors. The `void`
  // prefix makes it explicit that we are not awaiting the side-channel
  // write, so a slow DB cannot stall the user-facing GET.
  // We use the note's path-id (frontmatter ULID is not exposed on the
  // shared Note shape); migrating to ULIDs is the consolidation-agent's
  // job and out of scope here.
  const sessionId = getCookie(c, "lokyy_session");
  void logRetrieval({
    noteId: note.id,
    source: "api",
    sessionId: sessionId,
  });
  return c.json(note);
});

/**
 * Save-Antwort + Sync-Status (Story: offline-toleranter Save).
 *
 * `synced: false` heißt NICHT "nicht gespeichert" — der Commit liegt sicher in
 * git, nur Forgejo war beim Push nicht erreichbar. Der nächste Sync (Button
 * oder nächster erfolgreicher Save) holt ihn nach. Die PWA zeigt darauf einen
 * dezenten Hinweis statt eines Fehlers; ein 503 gibt es nur noch, wenn schon
 * der Commit scheitert oder der Backend-Fehler nicht transient ist.
 */
function withSyncStatus<T extends object>(payload: T): T & { synced: boolean } {
  return { ...payload, synced: !isSyncPending() };
}

// PUT /api/notes/:id  { body: string }  -> committet & pusht
notesRoutes.put("/:id{.+}", async (c) => {
  const id = c.req.param("id");
  const { body } = await c.req.json<{ body: string }>();
  if (typeof body !== "string") {
    return c.json({ error: "body (string) erforderlich" }, 400);
  }
  try {
    return c.json(withSyncStatus(await saveNote(id, body)));
  } catch (err) {
    // Typisierte Git-/Frontmatter-Fehler -> passender Status (422/409/503).
    const mapped = mapSaveError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    // Unbekannter Fehler -> 409 (Legacy-Fallback, PWA behandelt es als Konflikt).
    return c.json(
      { error: err instanceof Error ? err.message : "Speichern fehlgeschlagen" },
      409,
    );
  }
});

/**
 * POST /api/notes/:id/ai-polish
 *
 * One-shot AI cleanup of a raw note (typically a Whisper voice
 * transcript). Sends the current body to an LLM, parses a structured
 * JSON response, and re-saves the note with:
 *
 *   frontmatter.title              ← polished title
 *   frontmatter.tags               ← polished tags (max 5)
 *   frontmatter.type               ← polished type, intersected with the
 *                                    polish-allowed subset (note | capture
 *                                    | decision | meeting | task)
 *   frontmatter.summary            ← one-sentence summary
 *   frontmatter.ai_polished_at     ← ISO timestamp of THIS polish run
 *   frontmatter.ai_polished_model  ← "<provider>:<model>"
 *   frontmatter.raw_transcript     ← pre-polish body (when preserve_raw,
 *                                    default true)
 *   body                            ← polished Markdown
 *
 * Request body (all optional):
 *   { provider?: "openai"|"anthropic"|"cohere", model?: string, preserve_raw?: boolean }
 *
 * Error shape mirrors the spec: { ok: false, error: <code>, message: <human> }.
 */
type PolishRequestBody = {
  provider?: PolishProviderName;
  model?: string;
  preserve_raw?: boolean;
};

const POLISH_VALID_PROVIDERS: ReadonlySet<PolishProviderName> = new Set([
  "openai",
  "anthropic",
  "cohere",
]);

notesRoutes.post("/:id{.+}/ai-polish", async (c) => {
  const id = c.req.param("id");

  // Parse optional body — empty body is allowed (all fields default).
  let opts: PolishRequestBody = {};
  try {
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      const parsed = JSON.parse(raw) as PolishRequestBody;
      if (parsed && typeof parsed === "object") opts = parsed;
    }
  } catch {
    return c.json(
      {
        ok: false,
        error: "invalid-body",
        message: "request body must be valid JSON or empty",
      },
      400,
    );
  }

  if (
    opts.provider !== undefined &&
    !POLISH_VALID_PROVIDERS.has(opts.provider)
  ) {
    return c.json(
      {
        ok: false,
        error: "invalid-body",
        message: `provider must be one of: ${Array.from(POLISH_VALID_PROVIDERS).join(", ")}`,
      },
      400,
    );
  }

  const preserveRaw = opts.preserve_raw !== false; // default true

  // 1. Load the note.
  const note = await getNote(id);
  if (!note) {
    return c.json(
      { ok: false, error: "note-not-found", message: `note "${id}" not found` },
      404,
    );
  }

  // 2. Split frontmatter ↔ body. `note.body` carries the entire raw .md
  //    including the YAML block, so we parse it back out here. The
  //    existing frontmatter is the merge base; the body-without-FM is
  //    what we hand to the LLM.
  const { data: existingFrontmatter, body: bodyWithoutFm } = parseFrontmatter(
    note.body,
  );
  const rawBodyForPolish = bodyWithoutFm.trim();

  if (rawBodyForPolish.length === 0) {
    return c.json(
      {
        ok: false,
        error: "empty-body",
        message: `note "${id}" has no body content to polish`,
      },
      400,
    );
  }

  // 3. Call the LLM.
  let polished;
  try {
    polished = await polishNote(rawBodyForPolish, {
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
  } catch (err) {
    if (err instanceof PolishKeyMissingError) {
      return c.json(
        { ok: false, error: "llm-key-missing", message: err.message },
        400,
      );
    }
    if (err instanceof PolishLlmError) {
      // Include the per-provider attempt list so the PWA can surface what
      // actually went wrong (rate-limit vs auth vs network).
      return c.json(
        {
          ok: false,
          error: "llm-error",
          message: err.message,
          attempts: err.attempts,
        },
        502,
      );
    }
    return c.json(
      {
        ok: false,
        error: "llm-error",
        message: err instanceof Error ? err.message : "unknown LLM error",
      },
      502,
    );
  }

  // 4. Merge result back into frontmatter. `notesService.saveNote` will
  //    overwrite `updated` and preserve `id` + `created` from disk, so we
  //    don't have to thread those through explicitly.
  const nowIso = new Date().toISOString();
  const mergedFrontmatter: FrontmatterMap = {
    ...existingFrontmatter,
    title: polished.title,
    tags: polished.tags,
    type: polished.type,
    summary: polished.summary,
    ai_polished_at: nowIso,
    ai_polished_model: `${polished.providerUsed}:${polished.modelUsed}`,
  };
  if (preserveRaw) {
    mergedFrontmatter.raw_transcript = bodyWithoutFm;
  }

  const newContent = serializeFrontmatter(mergedFrontmatter, polished.body);

  // 5. Save through the existing pipeline (git add → commit → pull --rebase
  //    → push, BM25-index refresh, temporal-edge sync). Any
  //    FrontmatterValidationError or merge-conflict surfaces as 409.
  try {
    const saved = await saveNote(id, newContent);
    const { data: savedFrontmatter, body: savedBody } = parseFrontmatter(
      saved.body,
    );
    return c.json(
      withSyncStatus({
        ok: true,
        noteId: id,
        polished: {
          frontmatter: savedFrontmatter,
          body: savedBody,
        },
        rawPreserved: preserveRaw,
      }),
    );
  } catch (err) {
    // Mirror the PUT handler's typed-error mapping (422/409/503), keeping the
    // polish endpoint's `ok:false` envelope shape.
    const mapped = mapSaveError(err);
    if (mapped) {
      return c.json({ ok: false, ...mapped.body }, mapped.status);
    }
    return c.json(
      {
        ok: false,
        error: "save-failed",
        message: err instanceof Error ? err.message : "save failed",
      },
      409,
    );
  }
});
