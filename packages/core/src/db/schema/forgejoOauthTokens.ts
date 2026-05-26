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
 * `access_token` is stored as plain text for now. Encrypting at rest is a
 * follow-up (out of scope of this story); the schema column type stays the
 * same so we don't need a migration when wrapping it.
 */
export const forgejoOauthTokens = pgTable(
  "forgejo_oauth_tokens",
  {
    id: text("id").primaryKey(), // ULID
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    forgejoBaseUrl: text("forgejo_base_url").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
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
