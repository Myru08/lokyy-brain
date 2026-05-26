import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * Opaque, one-shot CSRF tokens for the Forgejo OAuth2 authorize → callback
 * round-trip.
 *
 * `/api/auth/forgejo/start` inserts a row (32 hex chars from
 * `crypto.randomBytes`) and redirects to Forgejo with `state=<row.state>`.
 * The callback verifies the row exists, deletes it, then proceeds with the
 * token exchange. One-shot semantics — a replay attempts will miss the row.
 */
export const forgejoOauthState = pgTable("forgejo_oauth_state", {
  state: text("state").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ForgejoOauthState = typeof forgejoOauthState.$inferSelect;
export type NewForgejoOauthState = typeof forgejoOauthState.$inferInsert;
