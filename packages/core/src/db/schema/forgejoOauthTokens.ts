import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * Per-user OAuth access tokens for self-hosted Forgejo instances.
 *
 * Wizard flow: user logs in to Forgejo via `/api/auth/forgejo/start`, the
 * callback exchanges the auth-code for an access token and stores it here.
 * Subsequent `/api/forgejo/*` calls (list repos, create repo, clone vault)
 * pull the token from this row.
 *
 * One token row per (user, forgejo_base_url) pair — re-authorizing the same
 * instance UPSERTS the row instead of stacking.
 *
 * ## At-rest encryption
 *
 * `access_token_encrypted` / `refresh_token_encrypted` hold the AES-256-GCM
 * envelope produced by `packages/core/src/crypto/secrets.ts`. Migration
 * `0016_forgejo_oauth_tokens_encrypt` renamed the columns from their plain
 * counterparts and encrypted any legacy plaintext rows in place. NEVER read
 * these columns directly — always go through `loadToken()` /
 * `getValidForgejoToken()` in `packages/core/src/forgejo/refresh.ts` so the
 * envelope is decrypted (and refreshed, if necessary) before use.
 */
export const forgejoOauthTokens = pgTable(
  "forgejo_oauth_tokens",
  {
    id: text("id").primaryKey(), // ULID
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    forgejoBaseUrl: text("forgejo_base_url").notNull(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    forgejoUserLogin: text("forgejo_user_login").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userBaseUnique: uniqueIndex("idx_forgejo_oauth_tokens_user_base").on(
      t.userId,
      t.forgejoBaseUrl,
    ),
  }),
);

export type ForgejoOauthToken = typeof forgejoOauthTokens.$inferSelect;
export type NewForgejoOauthToken = typeof forgejoOauthTokens.$inferInsert;
