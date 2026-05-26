/**
 * Forgejo OAuth integration.
 *
 * Two tables:
 *
 *   forgejo_oauth_tokens — per-user access token for a self-hosted Forgejo
 *                          instance, used by the setup wizard to list/create
 *                          repos and by `gitService.setupVaultFromForgejo`
 *                          to clone the chosen repo. Unique on
 *                          (user_id, forgejo_base_url) so re-authorizing
 *                          the same instance UPSERTS instead of stacking.
 *
 *   forgejo_oauth_state  — opaque, one-shot CSRF tokens for the
 *                          authorize → callback round-trip. The row is
 *                          deleted on successful callback.
 *
 * Both tables FK to `users` with ON DELETE CASCADE — when a user is removed
 * their OAuth state goes with them.
 *
 * `access_token` is stored as plain text in this migration. Encrypting at
 * rest is a follow-up (out of scope here); the column type stays `text` so
 * wrapping is a code-only change later.
 */
export const migration0015ForgejoOauthTokens = `
CREATE TABLE IF NOT EXISTS forgejo_oauth_tokens (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  forgejo_base_url     TEXT NOT NULL,
  access_token         TEXT NOT NULL,
  refresh_token        TEXT,
  expires_at           TIMESTAMPTZ,
  forgejo_user_login   TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_forgejo_oauth_tokens_user_base
  ON forgejo_oauth_tokens (user_id, forgejo_base_url);

CREATE TABLE IF NOT EXISTS forgejo_oauth_state (
  state       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
