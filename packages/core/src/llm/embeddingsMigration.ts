import { eq, inArray, sql } from "drizzle-orm";
import { ulid as ulidFn } from "ulid";

import { database } from "../db/index.js";
import {
  ACTIVE_EMBEDDINGS_GENERATION_KEY,
  DEFAULT_EMBEDDINGS_GENERATION,
  embeddingMigrations,
  type EmbeddingMigration,
} from "../db/schema/embeddingsMigration.js";
import { systemConfig } from "../db/schema/systemConfig.js";
import { listNotes, getNote } from "../notes/notesService.js";
import { llmRegistry } from "./registry.js";
import { getLlmRouting } from "./configStore.js";
import type { LlmProvider } from "./types.js";

/**
 * Embedding-Migration Workflow (Phase-0 Wave D / Agent 1).
 *
 * Re-embeds the entire vault under a new provider/model and atomically
 * swaps the active generation. Old embeddings remain queryable until the
 * swap completes; on failure they stay active.
 *
 * Atomic-swap design:
 *   1. `startMigration` validates target provider, inserts migration row,
 *      kicks off async worker.
 *   2. Worker iterates `listNotes()` and INSERTs new vectors with
 *      `generation = <migrationId>`.
 *   3. On full success, flip `system_config[active_embeddings_generation]`
 *      to `<migrationId>`. Tier 2 read paths consult this flag.
 *   4. On failure / cancel, leave the flag alone — old generation wins.
 *
 * Resume-on-startup:
 *   `resumePendingMigration()` finds any row in status="running"/"pending"
 *   and re-spawns the worker, skipping noteIds already marked "done".
 *
 * Variable dimensions:
 *   The current `note_embeddings.embedding` column is locked at
 *   `vector(768)`. Cross-dimension migrations are validated and rejected
 *   in `startMigration`. Lifting that requires either a per-generation
 *   typed column or a parallel table — deferred to Phase A.
 */

// ─── Public types ────────────────────────────────────────────────────────

export interface MigrationConfig {
  /** provider name in the registry (e.g. "openai", "ollama", "voyage"). */
  toProvider: string;
  /** Optional explicit model. If omitted, provider's default embed model is used. */
  toModel?: string;
  /**
   * Optional vault id to scope the migration. Defaults to the env-derived
   * `LOKYY_DEFAULT_VAULT` (matches the single-active-vault dev mode used by
   * server routes today).
   */
  vaultId?: string;
}

export interface MigrationProgress {
  migrationId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  totalNotes: number;
  processedNotes: number;
  currentNote?: string;
  errorCount: number;
  elapsedMs: number;
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  errorMessage?: string;
}

export interface StartMigrationResult {
  migrationId: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────

export class EmbeddingMigrationError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "EmbeddingMigrationError";
  }
}

// ─── Internals ───────────────────────────────────────────────────────────

const DEFAULT_VAULT = process.env.LOKYY_DEFAULT_VAULT ?? "default";
/** vector(768) — current schema-imposed dimension limit. */
const EMBEDDING_COLUMN_DIM = 768;

/** Workers currently running this process. Used by cancel + resume guard. */
const RUNNING_WORKERS = new Map<string, { cancelled: boolean }>();

interface ProbeResult {
  dimensions: number;
  model: string;
}

/** Probe a provider for its embedding shape (model + dimensions). */
async function probeEmbedding(
  provider: LlmProvider,
  model: string | undefined,
): Promise<ProbeResult> {
  if (!provider.embeddings) {
    throw new EmbeddingMigrationError(
      `provider ${provider.info.name} has no embeddings capability`,
      "NO_EMBED_CAPABILITY",
    );
  }
  const res = await provider.embeddings(["probe"], model ? { model } : {});
  return { dimensions: res.dimensions, model: res.model };
}

/** Resolve current (= active-generation) provider/model + dimensions. */
async function resolveActiveEmbedding(): Promise<{
  provider: string;
  model: string;
  dimensions: number;
}> {
  const routing = await getLlmRouting();
  const mapping = routing.roles.embedding;
  const provName = mapping?.provider ?? "ollama";
  const model = mapping?.model;
  const provider = llmRegistry().get(provName);
  // If the active provider isn't reachable (e.g. Ollama down), fall back
  // to a best-guess shape: nomic-embed-text @ 768. The worker validates
  // dimensions on the TO provider anyway, so this only affects display.
  if (!provider || !provider.embeddings) {
    return {
      provider: provName,
      model: model ?? "nomic-embed-text",
      dimensions: EMBEDDING_COLUMN_DIM,
    };
  }
  try {
    const probe = await probeEmbedding(provider, model);
    return { provider: provName, model: probe.model, dimensions: probe.dimensions };
  } catch {
    return {
      provider: provName,
      model: model ?? "unknown",
      dimensions: EMBEDDING_COLUMN_DIM,
    };
  }
}

function toPgVector(arr: number[]): string {
  return `[${arr.join(",")}]`;
}

async function readActiveGenerationRaw(): Promise<string> {
  const rows = await database()
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, ACTIVE_EMBEDDINGS_GENERATION_KEY))
    .limit(1);
  const v = rows[0]?.valueText;
  if (typeof v === "string" && v.length > 0) return v;
  return DEFAULT_EMBEDDINGS_GENERATION;
}

async function writeActiveGeneration(generation: string): Promise<void> {
  const db = database();
  const existing = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, ACTIVE_EMBEDDINGS_GENERATION_KEY))
    .limit(1);
  if (existing[0]) {
    await db
      .update(systemConfig)
      .set({ valueText: generation, updatedAt: new Date() })
      .where(eq(systemConfig.key, ACTIVE_EMBEDDINGS_GENERATION_KEY));
  } else {
    await db.insert(systemConfig).values({
      key: ACTIVE_EMBEDDINGS_GENERATION_KEY,
      valueText: generation,
    });
  }
}

async function loadRow(id: string): Promise<EmbeddingMigration | null> {
  const rows = await database()
    .select()
    .from(embeddingMigrations)
    .where(eq(embeddingMigrations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function updateRow(
  id: string,
  patch: Partial<EmbeddingMigration>,
): Promise<void> {
  await database()
    .update(embeddingMigrations)
    .set(patch)
    .where(eq(embeddingMigrations.id, id));
}

function countErrors(noteStatus: Record<string, string>): number {
  let n = 0;
  for (const v of Object.values(noteStatus)) {
    if (v !== "done") n += 1;
  }
  return n;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Read the currently-active embeddings generation tag. All Tier 2 read
 * queries should filter `WHERE generation = <this>`.
 */
export async function getActiveGeneration(): Promise<string> {
  return readActiveGenerationRaw();
}

/**
 * Kick off a new migration. Returns immediately with the new migrationId;
 * the worker runs detached. Throws `EmbeddingMigrationError` if validation
 * fails BEFORE any DB write.
 */
export async function startMigration(
  cfg: MigrationConfig,
): Promise<StartMigrationResult> {
  // 1. Validate target provider exists and supports embeddings.
  const target = llmRegistry().get(cfg.toProvider);
  if (!target) {
    throw new EmbeddingMigrationError(
      `provider not registered: ${cfg.toProvider}`,
      "PROVIDER_NOT_FOUND",
    );
  }
  if (!target.info.capabilities.embed || !target.embeddings) {
    throw new EmbeddingMigrationError(
      `provider ${cfg.toProvider} does not support embeddings`,
      "NO_EMBED_CAPABILITY",
    );
  }

  // 2. Probe shape of TO + read shape of FROM.
  const toProbe = await probeEmbedding(target, cfg.toModel);
  const from = await resolveActiveEmbedding();

  if (from.provider === cfg.toProvider && from.model === toProbe.model) {
    throw new EmbeddingMigrationError(
      "target provider/model matches current active embedding — nothing to do",
      "SAME_AS_CURRENT",
    );
  }

  // 3. Variable-dim is not supported by current column type. Reject if the
  //    new shape doesn't fit the existing vector(768) column.
  if (toProbe.dimensions !== EMBEDDING_COLUMN_DIM) {
    throw new EmbeddingMigrationError(
      `target dimensions ${toProbe.dimensions} != column dimensions ${EMBEDDING_COLUMN_DIM}. ` +
        "Cross-dimension migrations require per-generation typed columns (deferred to Phase A).",
      "DIMENSION_MISMATCH",
    );
  }

  // 4. Count notes for progress baseline.
  const notes = await listNotes();
  const total = notes.length;

  const migrationId = ulidFn();
  const vaultId = cfg.vaultId ?? DEFAULT_VAULT;

  await database()
    .insert(embeddingMigrations)
    .values({
      id: migrationId,
      fromProvider: from.provider,
      fromModel: from.model,
      fromDimensions: from.dimensions,
      toProvider: cfg.toProvider,
      toModel: toProbe.model,
      toDimensions: toProbe.dimensions,
      status: "pending",
      totalNotes: total,
      processedNotes: 0,
      noteStatus: {},
    });

  // Detach the worker — must not block the request thread.
  const handle = { cancelled: false };
  RUNNING_WORKERS.set(migrationId, handle);
  setImmediate(() => {
    void runWorker(migrationId, vaultId, cfg.toProvider, toProbe.model, handle).catch(
      (err) => {
        console.error(`[embeddings-migration ${migrationId}] worker crashed:`, err);
      },
    );
  });

  return { migrationId };
}

/** Read snapshot of a migration's progress. */
export async function getMigrationStatus(
  migrationId: string,
): Promise<MigrationProgress> {
  const row = await loadRow(migrationId);
  if (!row) {
    throw new EmbeddingMigrationError(
      `migration not found: ${migrationId}`,
      "NOT_FOUND",
    );
  }
  return rowToProgress(row);
}

/** Best-effort cancel. Sets cancelled flag; worker checks between notes. */
export async function cancelMigration(migrationId: string): Promise<void> {
  const row = await loadRow(migrationId);
  if (!row) {
    throw new EmbeddingMigrationError(
      `migration not found: ${migrationId}`,
      "NOT_FOUND",
    );
  }
  if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
    return; // already terminal — no-op
  }
  const handle = RUNNING_WORKERS.get(migrationId);
  if (handle) handle.cancelled = true;
  await updateRow(migrationId, {
    status: "cancelled",
    finishedAt: new Date(),
  });
  RUNNING_WORKERS.delete(migrationId);
}

/**
 * Server-startup recovery. Find any pending/running migration rows and
 * relaunch their workers (skipping noteIds already done). Idempotent.
 */
export async function resumePendingMigration(): Promise<void> {
  const rows = await database()
    .select()
    .from(embeddingMigrations)
    .where(inArray(embeddingMigrations.status, ["pending", "running"]));

  for (const row of rows) {
    if (RUNNING_WORKERS.has(row.id)) continue; // already running in this process
    const vaultId = DEFAULT_VAULT;
    const handle = { cancelled: false };
    RUNNING_WORKERS.set(row.id, handle);
    setImmediate(() => {
      void runWorker(row.id, vaultId, row.toProvider, row.toModel, handle).catch(
        (err) => {
          console.error(
            `[embeddings-migration ${row.id}] resumed worker crashed:`,
            err,
          );
        },
      );
    });
    console.log(
      `[embeddings-migration ${row.id}] resumed (processed=${row.processedNotes}/${row.totalNotes})`,
    );
  }
}

// ─── Worker ──────────────────────────────────────────────────────────────

async function runWorker(
  migrationId: string,
  vaultId: string,
  toProvider: string,
  toModel: string,
  handle: { cancelled: boolean },
): Promise<void> {
  // Mark running.
  await updateRow(migrationId, { status: "running" });

  const row = await loadRow(migrationId);
  if (!row) {
    RUNNING_WORKERS.delete(migrationId);
    return;
  }

  const provider = llmRegistry().get(toProvider);
  if (!provider || !provider.embeddings) {
    await updateRow(migrationId, {
      status: "failed",
      finishedAt: new Date(),
      errorMessage: `provider ${toProvider} not available at worker start`,
    });
    RUNNING_WORKERS.delete(migrationId);
    return;
  }

  // Fresh list — vault might have changed between start and resume.
  const notes = await listNotes();
  const noteStatus: Record<string, string> = { ...row.noteStatus };
  let processed = Object.keys(noteStatus).length;

  for (const note of notes) {
    if (handle.cancelled) {
      // cancel path: row.status already set by cancelMigration()
      RUNNING_WORKERS.delete(migrationId);
      return;
    }
    if (noteStatus[note.id]) continue; // resume: already processed

    try {
      const full = await getNote(note.id);
      if (!full) {
        noteStatus[note.id] = "error: not-found";
      } else {
        const text = `${full.title}\n\n${full.body}`;
        const res = await provider.embeddings([text], toModel ? { model: toModel } : {});
        const vec = res.vectors[0];
        if (!vec || vec.length !== EMBEDDING_COLUMN_DIM) {
          noteStatus[note.id] =
            `error: unexpected vector length ${vec ? vec.length : "null"}`;
        } else {
          const v = toPgVector(vec);
          await database().execute(sql`
            INSERT INTO note_embeddings (note_id, vault_id, generation, embedding, updated_at)
            VALUES (${note.id}, ${vaultId}, ${migrationId}, ${v}::vector, NOW())
            ON CONFLICT (note_id, vault_id, generation) DO UPDATE
              SET embedding = EXCLUDED.embedding, updated_at = NOW()
          `);
          noteStatus[note.id] = "done";
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      noteStatus[note.id] = `error: ${msg.slice(0, 200)}`;
    }

    processed += 1;
    // Persist every N notes to bound row updates; also persist on small N
    // so the SSE stream has data to show in tests.
    if (processed % 5 === 0 || processed === notes.length) {
      await updateRow(migrationId, {
        processedNotes: processed,
        noteStatus,
      });
    }
  }

  // Final flush.
  await updateRow(migrationId, {
    processedNotes: processed,
    noteStatus,
  });

  // Decide outcome: if every note is "done" → completed + swap. Else if
  // any note is "done" but some errored → still complete but log error
  // count; flip ONLY if at least one note made it (otherwise the new
  // generation is empty and unusable).
  const errors = countErrors(noteStatus);
  const doneCount = processed - errors;

  if (doneCount === 0) {
    await updateRow(migrationId, {
      status: "failed",
      finishedAt: new Date(),
      errorMessage: `all ${processed} notes failed to embed`,
    });
  } else {
    await writeActiveGeneration(migrationId);
    await updateRow(migrationId, {
      status: "completed",
      finishedAt: new Date(),
      errorMessage: errors > 0 ? `${errors} of ${processed} notes failed` : null,
    });
  }
  RUNNING_WORKERS.delete(migrationId);
}

function rowToProgress(row: EmbeddingMigration): MigrationProgress {
  const startedAtMs = row.startedAt.getTime();
  const endMs = row.finishedAt ? row.finishedAt.getTime() : Date.now();
  return {
    migrationId: row.id,
    status: row.status as MigrationProgress["status"],
    totalNotes: row.totalNotes,
    processedNotes: row.processedNotes,
    errorCount: countErrors(row.noteStatus),
    elapsedMs: Math.max(0, endMs - startedAtMs),
    fromProvider: row.fromProvider,
    fromModel: row.fromModel,
    toProvider: row.toProvider,
    toModel: row.toModel,
    errorMessage: row.errorMessage ?? undefined,
  };
}

// Re-export helpers consumers might need.
export {
  ACTIVE_EMBEDDINGS_GENERATION_KEY,
  DEFAULT_EMBEDDINGS_GENERATION,
} from "../db/schema/embeddingsMigration.js";
