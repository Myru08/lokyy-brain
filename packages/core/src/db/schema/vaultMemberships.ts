import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { vaults } from "./vaults.js";

export const vaultMemberships = pgTable(
  "vault_memberships",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'read' | 'write' | 'admin'
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.vaultId] }),
  }),
);

export type VaultMembership = typeof vaultMemberships.$inferSelect;
export type NewVaultMembership = typeof vaultMemberships.$inferInsert;
