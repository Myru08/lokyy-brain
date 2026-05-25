import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const vaults = pgTable("vaults", {
  id: text("id").primaryKey(), // ULID
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  kind: text("kind").notNull(), // 'personal' | 'company'
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  gitRemote: text("git_remote").notNull(),
  gitBranch: text("git_branch").notNull().default("main"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Vault = typeof vaults.$inferSelect;
export type NewVault = typeof vaults.$inferInsert;
