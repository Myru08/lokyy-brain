import { resolve } from "node:path";
import { validateGitBranch } from "@lokyy/core";

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
  /**
   * The singleton/personal vault id (the working copy at `vaultDir`). Used by
   * the owner vault-switcher middleware (C) to decide when NOT to rebind: the
   * personal vault lives at `vaultDir`, every other vault under `vaultsRoot`.
   */
  lokyyVaultId: process.env.LOKYY_VAULT_ID ?? "",
  gitRemote: process.env.GIT_REMOTE ?? "",
  // AC#1 (Story 10.6): trim + validate to a single clean ref token at config
  // load. A bad GIT_BRANCH (`"main "`, two tokens) now fails loudly here
  // instead of producing `fatal: Cannot rebase onto multiple branches` in pull.
  gitBranch: validateGitBranch(process.env.GIT_BRANCH ?? "main"),
  gitAuthorName: process.env.GIT_AUTHOR_NAME ?? "lokyy-brain",
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL ?? "lokyy-brain@localhost",
  supadataApiKey: process.env.SUPADATA_API_KEY ?? "",
  /** Postgres DSN — required for sessions, vault metadata, embeddings. */
  databaseUrl: req("DATABASE_URL"),
  /** Ollama host — local LLM/embedding runtime. */
  ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
  /** Forgejo OAuth (setup-wizard). Empty when the operator hasn't wired an OAuth app yet. */
  forgejoBaseUrl: process.env.FORGEJO_BASE_URL ?? "",
  forgejoOauthClientId: process.env.FORGEJO_OAUTH_CLIENT_ID ?? "",
  forgejoOauthClientSecret: process.env.FORGEJO_OAUTH_CLIENT_SECRET ?? "",
  /**
   * Multi-tenant (M3 / LBMT-1.4): Forgejo admin token + org under which each
   * customer vault gets its OWN private repo (`<org>/<slug>`). When both are
   * set, `POST /api/tenants` creates + clones a real Forgejo repo; otherwise it
   * falls back to a local-only working copy (demo / not-yet-configured).
   */
  forgejoAdminToken: process.env.FORGEJO_ADMIN_TOKEN ?? "",
  forgejoTenantsOrg: process.env.FORGEJO_TENANTS_ORG ?? "",
  /**
   * Whisper transcription endpoint.
   *
   * Empty (default) → fall back to OpenAI cloud
   * (`https://api.openai.com/v1/audio/transcriptions`) using the API key
   * from the `llm_providers` table.
   *
   * Set → point at a self-hosted whisper-asr-webservice instance
   * (e.g. `http://whisper-<UUID>:9000` or
   * `https://whisper.example.com/v1/audio/transcriptions`). The handler
   * appends `/v1/audio/transcriptions` if the URL doesn't already end in
   * that path, so both base-URL and full-URL forms work.
   *
   * Optional companion: `WHISPER_API_KEY` — when set alongside
   * `WHISPER_BASE_URL`, sent as `Authorization: Bearer <key>`. Omit for
   * the default whisper-asr-webservice (no auth).
   */
  whisperBaseUrl: process.env.WHISPER_BASE_URL ?? "",
  whisperApiKey: process.env.WHISPER_API_KEY ?? "",
  port: Number(process.env.PORT ?? 8787),
} as const;
