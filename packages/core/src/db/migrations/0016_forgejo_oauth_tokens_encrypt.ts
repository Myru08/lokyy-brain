/**
 * Forgejo OAuth — at-rest encryption migration.
 *
 * Renames the plaintext columns to their `_encrypted` counterparts so the
 * schema name itself signals that callers must go through the decryption
 * helpers. Encryption itself is enforced at the application layer
 * (`packages/core/src/crypto/secrets.ts`); the column type stays `text`
 * because the envelope is a base64 string.
 *
 * ## Migration safety
 *
 * Existing rows are LEFT IN PLACE with whatever value they had before — the
 * rename does not touch row contents. The application-layer `decrypt()`
 * helper is deliberately forgiving: if the stored value doesn't look like
 * an AES-GCM envelope it is returned verbatim (treated as legacy plaintext).
 * That means:
 *
 *   - If `LOKYY_DATA_KEY` is unset → existing rows stay plaintext, new rows
 *     stay plaintext, decrypt is a pass-through. No-op end-to-end.
 *
 *   - If `LOKYY_DATA_KEY` is set BEFORE this migration runs → existing rows
 *     are plaintext-in-an-encrypted-column (decrypt sees no envelope shape
 *     and returns the plaintext), new rows are written as base64 envelopes,
 *     and the refresh-token flow naturally re-encrypts each token within
 *     ~1h of first use (every refresh writes a fresh envelope).
 *
 *   - If `LOKYY_DATA_KEY` is set AFTER this migration runs → same as above.
 *     The crypto helper warns once at startup when the key is missing, so
 *     operators get a visible nudge to set it.
 *
 * Backfill of existing plaintext rows into envelope form is intentionally
 * deferred to organic refresh; a dedicated re-encrypt admin route can be
 * added later if instant uplift is needed. Key rotation will live there.
 */
export const migration0016ForgejoOauthTokensEncrypt = `
ALTER TABLE forgejo_oauth_tokens
  RENAME COLUMN access_token TO access_token_encrypted;

ALTER TABLE forgejo_oauth_tokens
  RENAME COLUMN refresh_token TO refresh_token_encrypted;
`;
