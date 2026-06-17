import { listNotes, getNote, saveNote } from "../../notes/notesService.js";
import {
  parseFrontmatter,
  serializeFrontmatter,
  generateUlid,
  type DocType,
  type FrontmatterMap,
} from "../../frontmatter/index.js";
import { DOC_TYPES } from "../../frontmatter/types.js";
import type { SleepPass, SleepRun, SleepPassResult } from "../types.js";

/**
 * Phase D Wave D1 / Story 1 — ULID-Backfill NREM-sleep pass.
 *
 * Many legacy notes pre-date the SPEC contract introduced in Story 1.5/1.6
 * (frontmatter `id` ULID + `type` + `created` + `updated`). They were
 * either created before that landed OR written via a raw pipe-handler that
 * skipped `notesService.createNote`. Effect on the rest of the system:
 *
 *   - NoteHeader shows "(no ULID)" and the AI-Prompt-Button is hidden.
 *   - MCP `resolve_by_id` can't find them.
 *   - Several REM passes (importance-recompute, entity-extraction) skip them.
 *
 * This pass walks the vault, picks up to NOTES_PER_RUN ULID-less notes per
 * run, and writes back via `saveNote` — which means:
 *
 *   1. Proper git commit ("notiz: …") goes through `gitService` (Forgejo
 *      is still the source of truth; the pre-commit hook validates the
 *      new frontmatter shape before the commit lands).
 *   2. BM25 search-index + bi-temporal-edges sync trigger downstream as
 *      a side-effect — no extra plumbing needed.
 *   3. ULID cache (`findByUlid`) gets invalidated automatically.
 *
 * Idempotency: notes that already carry an `id` field are skipped. Running
 * the pass twice in a row produces zero additional commits the second time.
 *
 * Body invariant: the markdown body BELOW the frontmatter block is
 * untouched. We only rewrite the frontmatter YAML, preserving every
 * existing key (including doc-type extras like `status`, `due`, `source`,
 * `encoded`, `tags`, `aliases`).
 *
 * Work cap: NOTES_PER_RUN = 50 — bounds git-commit churn per sleep run.
 * Subsequent runs continue until the vault is fully backfilled. With
 * idle-scheduler (30 min) + nightly (03:00), a 1000-note legacy vault is
 * fully backfilled inside ~10 idle runs / ~5 hours of normal operation.
 */

const NOTES_PER_RUN = 50;

const DOC_TYPE_SET = new Set<string>(DOC_TYPES);

/**
 * Best-effort path-prefix → doc-type mapping for legacy notes that lack
 * an explicit `type:` field. The defaults mirror the convention used by
 * the lokyy-vault folder schema; an unknown prefix falls back to `"note"`
 * (the safe default — passes every schema's base validation).
 *
 * Story S3 — PARA-SCOPED ON PURPOSE. This pass is the legacy-PARA ULID
 * backfill; its prefixes (`30_captures/`, `10_projects/`, …) are PARA folders,
 * and its return type is the PARA `DocType`. A karpathy vault has NO legacy
 * untyped notes (it is SPEC-born with explicit `type:`), so this pass never
 * runs against RAW/Wiki/Outputs and would never reach the fallback in a
 * meaningful way. The karpathy fallback (`raw-source`/`wiki-article`/
 * `frage-report`) is therefore intentionally NOT added here — adding it would
 * be dead code. No karpathy mis-routing results because the karpathy create
 * path (`createManaged`/`createNote` with `profile: "karpathy"`) always writes
 * an explicit `type:`, so the `existingType ?? inferTypeFromPath(...)` branch
 * keeps the explicit type and never falls through. Residual drift: none for
 * karpathy; if a profile-aware backfill is ever needed it is a follow-up
 * (sleep-agent profile threading is out of S3 scope).
 */
function inferTypeFromPath(noteId: string): DocType {
  if (noteId.startsWith("30_captures/")) return "capture";
  if (noteId.startsWith("40_daily/")) return "note";
  if (noteId.startsWith("60_meetings/")) return "meeting";
  if (noteId.startsWith("40_customers/")) return "customer";
  if (noteId.startsWith("50_decisions/")) return "decision";
  if (noteId.startsWith("10_projects/")) return "project";
  if (noteId.startsWith("40_tasks/")) return "task";
  if (noteId.startsWith("70_pai/")) return "note";
  if (noteId.startsWith("peers/")) return "peer";
  return "note";
}

interface BackfillCandidate {
  noteId: string;
  existing: FrontmatterMap;
  body: string;
}

export const ulidBackfillPass: SleepPass = {
  name: "ulid-backfill",
  phases: ["nrem"],

  async run(_run: SleepRun): Promise<SleepPassResult> {
    let processed = 0;
    let errors = 0;
    let backfilled = 0;

    try {
      const allNotes = await listNotes();

      // Pass 1: find candidates. Stop early when we hit the per-run cap so
      // we don't pay the read-cost for the whole vault on every sleep run.
      const candidates: BackfillCandidate[] = [];
      for (const summary of allNotes) {
        if (candidates.length >= NOTES_PER_RUN) break;
        const full = await getNote(summary.id).catch(() => null);
        if (!full?.body) continue;
        const parsed = parseFrontmatter(full.body);
        const fmId = parsed.data.id;
        if (typeof fmId === "string" && fmId.length > 0) continue; // already has ULID
        candidates.push({
          noteId: summary.id,
          existing: parsed.data,
          body: parsed.body,
        });
      }

      if (candidates.length === 0) {
        return { processed: 0, errors: 0, notes: "all notes have ULIDs" };
      }

      // Pass 2: backfill. saveNote does its own validation; per-note errors
      // increment `errors` but do not abort the loop. The next candidate is
      // independent — git commits are serialized by gitService's lock, so a
      // failure inside saveNote (validation, hook reject, network) doesn't
      // leave the working copy in a half-written state.
      for (const c of candidates) {
        try {
          const now = new Date().toISOString();
          const existingType =
            typeof c.existing.type === "string" &&
            DOC_TYPE_SET.has(c.existing.type)
              ? (c.existing.type as DocType)
              : null;
          const inferredType: DocType = existingType ?? inferTypeFromPath(c.noteId);

          const existingTitle =
            typeof c.existing.title === "string" && c.existing.title.length > 0
              ? c.existing.title
              : (c.noteId.split("/").pop() ?? c.noteId);

          const existingCreated =
            typeof c.existing.created === "string" && c.existing.created.length > 0
              ? c.existing.created
              : now;

          // Required SPEC fields first (deterministic key order in the
          // serialized YAML), then preserve every other existing field via
          // a spread on the remainder. The required-field keys win when
          // there's a conflict — but by construction `existing.id` was
          // already empty (else this note isn't a candidate), and the
          // others are sourced from `existing` already.
          const { id: _id, type: _type, title: _title, created: _created, updated: _updated, ...rest } = c.existing;
          // Mark intentionally-unused destructured keys.
          void _id;
          void _type;
          void _title;
          void _created;
          void _updated;

          const merged: FrontmatterMap = {
            id: generateUlid(),
            type: inferredType,
            title: existingTitle,
            created: existingCreated,
            updated: now,
            ...rest,
          };

          // Rebuild via serializeFrontmatter so the YAML emit is
          // deterministic (gray-matter uses js-yaml internally) and never
          // mangles complex types like nested objects (`encoded`, `source`).
          const newBody = serializeFrontmatter(merged, c.body);

          // saveNote validates against the per-type schema BEFORE the git
          // commit and runs the full downstream sync (BM25, temporal-edges,
          // ULID cache invalidation). Throws FrontmatterValidationError on
          // schema failure — caught here and counted in `errors`.
          await saveNote(c.noteId, newBody);
          backfilled++;
          processed++;
        } catch (err) {
          errors++;
          console.warn(
            `[sleep-agent] ulid-backfill failed for "${c.noteId}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return {
        processed,
        errors,
        notes: `backfilled ${backfilled} legacy notes with ULID + type + updated`,
      };
    } catch (err) {
      return {
        processed,
        errors: errors + 1,
        notes: `pass-error: ${String(err).slice(0, 200)}`,
      };
    }
  },
};
