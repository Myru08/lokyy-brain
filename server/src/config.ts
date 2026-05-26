import { resolve } from "node:path";

/**
 * Zentrale Konfiguration. Liest aus process.env (Node lädt .env ab v20.6
 * via `--env-file`, der dev-Script kann das ergänzen — hier bewusst
 * dependency-frei gehalten).
 *
 * `gitRemote` / `gitBranch` are OPTIONAL: empty defaults so the server
 * boots before the setup wizard has wired a Forgejo repo. Once the wizard
 * runs through `setupVaultFromForgejo`, the remote is written to the
 * `vaults` row and the working-copy already has it baked into
 * `.git/config` — env-level config is only needed for the initial
 * `ensureRepo()` clone on a fresh machine, which `gitService` now skips
 * silently when the value is empty.
 */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return v;
}

export const config = {
  /** absoluter Pfad zum Vault-Working-Clone */
  vaultDir: resolve(process.env.VAULT_DIR ?? "../vault"),
  gitRemote: process.env.GIT_REMOTE ?? "",
  gitBranch: process.env.GIT_BRANCH ?? "main",
  gitAuthorName: process.env.GIT_AUTHOR_NAME ?? "lokyy-brain",
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL ?? "lokyy-brain@localhost",
  supadataApiKey: process.env.SUPADATA_API_KEY ?? "",
  /** Postgres DSN — required for sessions, vault metadata, embeddings. */
  databaseUrl: req("DATABASE_URL"),
  /** Forgejo OAuth (setup-wizard). Empty when the operator hasn't wired an OAuth app yet. */
  forgejoBaseUrl: process.env.FORGEJO_BASE_URL ?? "",
  forgejoOauthClientId: process.env.FORGEJO_OAUTH_CLIENT_ID ?? "",
  forgejoOauthClientSecret: process.env.FORGEJO_OAUTH_CLIENT_SECRET ?? "",
  port: Number(process.env.PORT ?? 8787),
} as const;
