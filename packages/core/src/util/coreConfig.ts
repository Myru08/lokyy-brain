/**
 * Shared configuration injection for `@lokyy/core` services.
 *
 * The server (and the future `mcp` package) owns its own `config` module
 * (env loading, validation, dotenv etc.). Core services do not load env
 * directly — they receive a `CoreConfig` slice at startup via `initCore`.
 *
 * Every core service that needs vault path or git identity reads it via
 * `coreConfig()`. This avoids circular deps and keeps core stateless from
 * the environment.
 */

export interface CoreConfig {
  vaultDir: string;
  gitRemote: string;
  gitBranch: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

let injected: CoreConfig | null = null;

export function initCore(c: CoreConfig): void {
  injected = c;
}

export function coreConfig(): CoreConfig {
  if (!injected) {
    throw new Error(
      "@lokyy/core not initialized — call initCore(config) at process startup before invoking any core service.",
    );
  }
  return injected;
}
