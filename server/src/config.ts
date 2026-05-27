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
  /** Ollama host — local LLM/embedding runtime. */
  ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
  /** Forgejo OAuth (setup-wizard). Empty when the operator hasn't wired an OAuth app yet. */
  forgejoBaseUrl: process.env.FORGEJO_BASE_URL ?? "",
  forgejoOauthClientId: process.env.FORGEJO_OAUTH_CLIENT_ID ?? "",
  forgejoOauthClientSecret: process.env.FORGEJO_OAUTH_CLIENT_SECRET ?? "",
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
