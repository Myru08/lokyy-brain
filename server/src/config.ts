import { resolve } from "node:path";

/**
 * Zentrale Konfiguration. Liest aus process.env (Node lädt .env ab v20.6
 * via `--env-file`, der dev-Script kann das ergänzen — hier bewusst
 * dependency-frei gehalten).
 */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return v;
}

export const config = {
  /** absoluter Pfad zum Vault-Working-Clone */
  vaultDir: resolve(process.env.VAULT_DIR ?? "../vault"),
  gitRemote: req("GIT_REMOTE"),
  gitBranch: process.env.GIT_BRANCH ?? "main",
  gitAuthorName: process.env.GIT_AUTHOR_NAME ?? "lokyy-brain",
  gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL ?? "lokyy-brain@localhost",
  supadataApiKey: process.env.SUPADATA_API_KEY ?? "",
  /** Postgres DSN — required for sessions, vault metadata, embeddings. */
  databaseUrl: req("DATABASE_URL"),
  port: Number(process.env.PORT ?? 8787),
} as const;
