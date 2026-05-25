/**
 * Memory layer entrypoint. Most callers go through the CombinedProvider;
 * Tier 1 / Tier 2 are exported for tests + the future MCP package that
 * may want to bypass the Tier 1 fallback for pure-semantic queries.
 */

export type {
  MemoryProvider,
  SearchHit,
  SearchOpts,
  RelatedOpts,
} from "./MemoryProvider.js";
export { NullMemoryProvider } from "./MemoryProvider.js";
export { Tier1Provider } from "./Tier1Provider.js";
export { Tier2Provider, EmbeddingUnavailableError, type Tier2Config } from "./Tier2Provider.js";
export { CombinedProvider } from "./CombinedProvider.js";
export { Tier1BM25, type BM25Hit } from "./Tier1BM25.js";
export {
  hybridSearch,
  resetHybridAvailabilityCache,
  type HybridOpts,
} from "./hybrid.js";

import { Tier1Provider } from "./Tier1Provider.js";
import { Tier2Provider } from "./Tier2Provider.js";
import { CombinedProvider } from "./CombinedProvider.js";
import { Tier1BM25 } from "./Tier1BM25.js";

let combined: CombinedProvider | null = null;
let activeVaultId: string | null = null;

/**
 * Build (or return) a CombinedProvider for the given vault. Once a vault
 * is active the provider is cached; passing a new vaultId resets it.
 */
export function getMemoryProvider(vaultId: string): CombinedProvider {
  if (combined && activeVaultId === vaultId) return combined;
  combined = new CombinedProvider(new Tier1Provider(), new Tier2Provider({ vaultId }));
  activeVaultId = vaultId;
  return combined;
}

/**
 * Fire-and-forget hook (Story 5.4). Call after every successful note save.
 * Returns immediately; the Tier 2 embedding refresh runs on a microtask.
 * Never awaits the network — the request path stays fast even when Ollama
 * is slow or down.
 */
export function queueIndexRefresh(vaultId: string, noteId: string): void {
  const provider = getMemoryProvider(vaultId);
  void Promise.resolve().then(() =>
    provider
      .indexNote(noteId)
      .catch((err) =>
        console.error("[memory] indexNote failed (non-blocking)", { vaultId, noteId, err }),
      ),
  );
}

/** Singleton Tier1BM25 — no per-vault state, the table is keyed by note_id. */
const tier1Bm25Singleton = new Tier1BM25();

export function getTier1BM25(): Tier1BM25 {
  return tier1Bm25Singleton;
}

/**
 * Fire-and-forget upsert into the `note_search` BM25 corpus (Phase A Wave A1
 * / Story 2). Call after every successful saveNote with the freshly read
 * note (title + body + parsed tags). Never blocks the save path.
 *
 * `forgotten` (Phase C Wave C3 / Story 2 — Cognee `forget()` UI primitive)
 * defaults to `false` so existing call-sites stay compatible. notesService
 * passes the live value derived from the frontmatter's `forgotten:` field.
 */
export function queueSearchIndexRefresh(
  vaultId: string,
  noteId: string,
  title: string,
  body: string,
  tags: string[],
  forgotten = false,
): void {
  void Promise.resolve().then(async () => {
    try {
      await tier1Bm25Singleton.upsert(noteId, vaultId, title, body, tags, forgotten);
    } catch (err) {
      console.error("[memory] note_search upsert failed (non-blocking)", {
        vaultId,
        noteId,
        err,
      });
    }
  });
}

/**
 * Phase C Wave C3 / Story 2 — Fire-and-forget toggle of the `forgotten`
 * flag on the existing `note_search` row. Used by the forget/unforget
 * route after the note's frontmatter has been updated on disk. Returns
 * immediately. If the row is missing (e.g. BM25 first-index has not yet
 * run after a fresh import) the update is a no-op and the next normal
 * BM25 upsert will reconcile the column from the frontmatter.
 */
export function queueForgottenToggle(noteId: string, forgotten: boolean): void {
  void Promise.resolve().then(async () => {
    try {
      await tier1Bm25Singleton.setForgotten(noteId, forgotten);
    } catch (err) {
      console.error("[memory] note_search forgotten toggle failed (non-blocking)", {
        noteId,
        forgotten,
        err,
      });
    }
  });
}

/**
 * Fire-and-forget removal from the BM25 corpus. Call after every successful
 * deleteEntry of a note.
 */
export function queueSearchIndexRemove(noteId: string): void {
  void Promise.resolve().then(async () => {
    try {
      await tier1Bm25Singleton.remove(noteId);
    } catch (err) {
      console.error("[memory] note_search remove failed (non-blocking)", {
        noteId,
        err,
      });
    }
  });
}
