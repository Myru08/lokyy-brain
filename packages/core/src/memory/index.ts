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

import { Tier1Provider } from "./Tier1Provider.js";
import { Tier2Provider } from "./Tier2Provider.js";
import { CombinedProvider } from "./CombinedProvider.js";

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
